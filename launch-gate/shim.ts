/**
 * launch-gate/shim.ts — the provider-boundary choreography shim (spec C7 topology
 * item 3, global constraint G3).
 *
 * A loopback HTTP server speaking the slice of the Ollama chat protocol that
 * `ai-sdk-ollama@4.0.0` actually calls: `POST /api/chat`, NDJSON when
 * `stream: true`, one complete JSON document otherwise. No API key, no egress, no
 * production seam — the app resolves it through the ordinary `ai_providers` OLLAMA
 * row, so every byte still crosses the real provider boundary.
 *
 * Wire facts this file is written against (verified in
 * node_modules/ai-sdk-ollama/dist/index.js and node_modules/ollama/dist/browser.mjs):
 *   - the client iterates NDJSON lines and REQUIRES a terminal `done: true` frame,
 *     otherwise it throws "Did not receive done or success response in stream";
 *   - non-terminal frames are dereferenced as `chunk.message.thinking` before
 *     anything else, so every frame MUST carry a `message` object;
 *   - tool calls ride as `message.tool_calls[].function.{name,arguments}` with
 *     `arguments` an OBJECT (the provider JSON.stringifies it);
 *   - usage is read off the terminal frame's `prompt_eval_count` / `eval_count`;
 *   - `done_reason` maps to the finish reason, but a turn that emitted tool calls is
 *     reported as `tool-calls` regardless.
 *
 * SCENARIO DISPATCH: the `GATE:<id>` prefix on the LAST user message. The step index
 * is the number of assistant messages carrying `tool_calls` AFTER that last user
 * message — the CURRENT turn only (earlier turns' tool messages must not advance it,
 * G2D-2) and never `role: "tool"` messages (one per result would double-count a
 * parallel-packed step, G2C-6). Any non-GATE prompt is a title call and gets
 * TITLE_SCRIPT. An unknown GATE id is a 500: a mis-seeded harness fails loudly.
 *
 * HOLDS (added by 1.6): a step carrying `hold` scripts a provider that is slow
 * (`then: "complete"`), dead (`then: "eof"`) or silent (`silent: true`) — the wire
 * behaviour the bounded-finalization and client-abort proofs are about. The hold
 * timer is cleared when the peer hangs up, and `HOLD_MAX_MS` caps it, so a held
 * connection can never outlive the run.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  GATE_PREFIX,
  TITLE_SCRIPT,
  loadChoreographies,
  type Choreography,
  type StepHold,
  type UsageScript,
} from "./choreography";

const MODEL_ID = "gate-scripted";

type OllamaMessage = {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
};

type ChatRequest = {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
};

export interface ShimHandle {
  port: number;
  close(): Promise<void>;
}

function frame(body: Record<string, unknown>): string {
  return `${JSON.stringify(body)}\n`;
}

function timestamp(): string {
  return new Date().toISOString();
}

/** A non-terminal NDJSON frame. `message` is always present — the provider reads
 *  `chunk.message.thinking` before checking anything else. */
function deltaFrame(message: Record<string, unknown>): string {
  return frame({ model: MODEL_ID, created_at: timestamp(), message, done: false });
}

/** The terminal frame. Content is deliberately empty: the provider re-emits a
 *  terminal frame's content as one more text delta. */
function doneFrame(usage: UsageScript, doneReason: string): string {
  return frame({
    model: MODEL_ID,
    created_at: timestamp(),
    message: { role: "assistant", content: "" },
    done: true,
    done_reason: doneReason,
    total_duration: 1_000_000,
    load_duration: 0,
    prompt_eval_count: usage.prompt_eval_count,
    eval_count: usage.eval_count,
    eval_duration: 1_000_000,
  });
}

function titleResponse(): Record<string, unknown> {
  return {
    model: MODEL_ID,
    created_at: timestamp(),
    message: { role: "assistant", content: TITLE_SCRIPT.text },
    done: true,
    done_reason: "stop",
    total_duration: 1_000_000,
    load_duration: 0,
    prompt_eval_count: TITLE_SCRIPT.usage.prompt_eval_count,
    eval_count: TITLE_SCRIPT.usage.eval_count,
    eval_duration: 1_000_000,
  };
}

function messagesOf(body: ChatRequest): OllamaMessage[] {
  return Array.isArray(body.messages) ? (body.messages as OllamaMessage[]) : [];
}

/** Index of the LAST `role: "user"` message, or -1. */
function lastUserIndex(messages: OllamaMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
}

/**
 * The turn-scoped step index: assistant messages carrying a non-empty `tool_calls`
 * array AFTER the last user message. Historical tool turns sit BEFORE that message
 * and are therefore invisible here; `role: "tool"` result messages are not counted
 * at all.
 */
export function stepIndexOf(messages: OllamaMessage[]): number {
  const start = lastUserIndex(messages);
  let index = 0;
  for (let i = start + 1; i < messages.length; i += 1) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) index += 1;
  }
  return index;
}

/** The scenario id on the last user message, or null when this is a title call. */
export function scenarioIdOf(messages: OllamaMessage[]): string | null {
  const index = lastUserIndex(messages);
  if (index === -1) return null;
  const content = messages[index]?.content;
  if (typeof content !== "string") return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith(GATE_PREFIX)) return null;
  const id = trimmed.slice(GATE_PREFIX.length).split(/\s/)[0];
  return id === "" ? null : id;
}

/** One step's wire output, split so a `hold` can sit between the two halves. */
type RenderedStep = { content: string; terminal: string; hold?: StepHold };

function renderStep(choreography: Choreography, stepIndex: number): RenderedStep {
  const step = choreography.steps[stepIndex];
  if (step === undefined) {
    throw new Error(
      `scenario ${choreography.id} has ${choreography.steps.length} steps but the model was ` +
        `asked for step ${stepIndex} — the choreography is short a closing text step`,
    );
  }
  const terminal = doneFrame(step.usage, "stop");
  if (step.toolCalls !== undefined) {
    const toolCalls = step.toolCalls.map((call) => ({
      function: { name: call.name, arguments: call.input },
    }));
    const content = deltaFrame({ role: "assistant", content: "", tool_calls: toolCalls });
    return { content, terminal, hold: step.hold };
  }
  return {
    content: deltaFrame({ role: "assistant", content: step.text }),
    terminal,
    hold: step.hold,
  };
}

/**
 * Serve a held step: flush the headers so the caller's `fetch` resolves and its read
 * BLOCKS on the body (the silent case writes no bytes at all, so nothing else would
 * push the head out), optionally write the content frame, then wait.
 *
 * `then: "complete"` finishes the turn normally after the wait — the read yields,
 * which is the only moment the AI SDK looks at its abort signal. `then: "eof"` ends
 * the body with no terminal frame: the provider raises its "did not receive done"
 * error, which is how a stalled stream eventually releases the socket instead of
 * leaking one for the rest of the run.
 */
function serveHeld(res: http.ServerResponse, req: http.IncomingMessage, rendered: RenderedStep): void {
  const hold = rendered.hold as StepHold;
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
  res.flushHeaders();
  if (hold.silent !== true) res.write(rendered.content);

  const timer = setTimeout(() => {
    if (hold.then === "complete") res.end(rendered.terminal);
    else res.end();
  }, hold.ms);
  const cancel = (): void => clearTimeout(timer);
  req.on("close", cancel);
  res.on("close", cancel);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      try {
        resolve(raw === "" ? {} : JSON.parse(raw));
      } catch (err) {
        reject(err instanceof Error ? err : new Error("unparseable body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  // ADDITIVE (Task 1.8, declared): "a mis-seeded harness fails loudly" (spec C7 item 3)
  // was only half true — the 500 went back to the provider, where the route masks it to
  // PROVIDER_ERROR and the reason is lost. The shim's own log is the only place that
  // reason can survive, and it costs nothing on the happy path.
  if (status >= 500) console.error(`[gate-shim] ${status} ${body}`);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(body);
}

export function createShimServer(choreographies: Map<string, Choreography>): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/api/chat") {
        sendJson(res, 404, { error: `launch-gate shim does not serve ${req.method} ${req.url}` });
        return;
      }
      let body: ChatRequest;
      try {
        body = (await readBody(req)) as ChatRequest;
      } catch {
        sendJson(res, 400, { error: "invalid json body" });
        return;
      }

      const messages = messagesOf(body);
      const scenarioId = scenarioIdOf(messages);

      // Title path: any prompt without the GATE prefix. Answered as ONE complete
      // document regardless of `stream` — a single terminal frame is also a valid
      // one-line NDJSON stream, so both provider paths accept it.
      if (scenarioId === null) {
        sendJson(res, 200, titleResponse());
        return;
      }

      const choreography = choreographies.get(scenarioId);
      if (choreography === undefined) {
        sendJson(res, 500, { error: `unknown gate scenario "${scenarioId}"` });
        return;
      }

      let rendered: RenderedStep;
      try {
        rendered = renderStep(choreography, stepIndexOf(messages));
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : "scenario render failed" });
        return;
      }

      if (body.stream === true) {
        if (rendered.hold !== undefined) {
          serveHeld(res, req, rendered);
          return;
        }
        res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
        res.end(rendered.content + rendered.terminal);
        return;
      }
      // Non-streaming callers get the terminal document only. A `hold` describes
      // STREAM timing and does not apply here.
      sendJson(res, 200, JSON.parse(rendered.terminal));
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : "shim failure" });
      } else {
        res.end();
      }
    });
  });
}

export async function startShim(port: number, choreographyDir: string): Promise<ShimHandle> {
  const server = createShimServer(loadChoreographies(choreographyDir));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Process entry. The harness bundles THIS file with tsup and runs the bundle as its
 * own process (real pid + process group, killable as a group like the app and the
 * MCP sidecar) — the `mcp/src/server.ts:227` bootstrap pattern, gated on an explicit
 * env flag so importing the module from a test never starts a server.
 */
if (process.env.LAUNCH_GATE_SHIM_MAIN === "1") {
  const port = Number(process.env.LAUNCH_GATE_SHIM_PORT);
  const dir = process.env.LAUNCH_GATE_CHOREOGRAPHY_DIR ?? "";
  void startShim(port, dir).then(
    (handle) => {
      console.log(`[gate-shim] listening on 127.0.0.1:${handle.port} (scenarios from ${dir})`);
    },
    (err: unknown) => {
      console.error("[gate-shim] failed to start", err);
      process.exit(1);
    },
  );
}
