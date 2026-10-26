// @ts-check
/**
 * __tests__/support/anthropic-wire-probe.mjs — what the REAL `ai` + `@ai-sdk/anthropic`
 * put on the wire for the A1 model-call options, and what a mid-stream abort becomes
 * on the client (assistant A1 pack C4; seams S1 and S2).
 *
 * WHY A SPAWNED SCRIPT. `ai` and the @ai-sdk/* chain are ESM-only and the root jest
 * transform cannot load them (lane4-assistant.test.ts mocks `ai` for that reason). So
 * the test (__tests__/unit/lib/assistant/anthropic-wire.test.ts) spawns this plain node
 * ESM process, which imports the genuine SDK and bundles the two A1 leaves —
 * lib/assistant/model-options.ts and lib/assistant/stream-metadata.ts — with esbuild
 * (esm-bundle.mjs). No mock, no copy of either leaf.
 *
 * NO NETWORK, NO KEY. The provider is built with the literal key "test-key", a
 * `.invalid` base URL (RFC 2606: it can never resolve) and a CAPTURE `fetch`: it
 * records `{ url, headers, body }` and answers with a minimal valid Messages API
 * reply (JSON for a non-streaming call, an SSE sequence for a streaming one).
 * `globalThis.fetch` is replaced by a tripwire that records and refuses any call, so
 * the capture is provably the only fetch anything gets.
 *
 * CASES (one JSON line each on stdout, NDJSON, written as each completes; each under a
 * 10 s watchdog that records `{ case, error: "watchdog" }` instead of hanging):
 *   a0  control — a title `generateText` for claude-opus-5-5 with the PRE-A1 parameters
 *       (maxOutputTokens 256, thinking disabled): proves the capture sees the very
 *       fields case a asserts are gone;
 *   a   a title `generateText` for claude-opus-5-5 with modelCallOptions(..., "title");
 *   b   a chat `streamText` for claude-opus-5-5 with one trivial tool;
 *   c   the same for claude-opus-5;
 *   d   the same for claude-sonnet-4-5 (outside the effort table);
 *   e   the abort chain: `streamText` whose SSE body emits message_start,
 *       content_block_start and one text delta, then holds open until the request
 *       signal aborts and ERRORS with `signal.reason` (as undici does). The probe aborts
 *       once the first text delta is read; the result goes through
 *       `toUIMessageStream({ messageMetadata })` with the route's rule and back through
 *       `readUIMessageStream`.
 * Plus a "bundles" line first (what each leaf bundle contains) and a "summary" line
 * last (stray fetches, unhandled rejections).
 *
 * Exit 0 when every case ran (a case's own failure is EVIDENCE, recorded in its line);
 * non-zero only when the bundle or an import fails (a harness failure, never a result).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, jsonSchema, readUIMessageStream, stepCountIs, streamText, tool } from "ai";
import { bundleToCache } from "./esm-bundle.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LEAVES = ["lib/assistant/model-options.ts", "lib/assistant/stream-metadata.ts"];

const CAPTURE_HOST = "anthropic-wire-probe.invalid";
const BASE_URL = `https://${CAPTURE_HOST}/v1`;
const API_KEY = "test-key";
const WATCHDOG_MS = 10_000;

// ---------------------------------------------------------------------------
// The tripwire: any fetch that is not the capture's is recorded and refused.
// ---------------------------------------------------------------------------

/** @type {string[]} */
const strayFetches = [];
/** @type {string[]} */
const unhandledRejections = [];

/** @param {unknown} input @returns {string} */
function urlOf(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && "url" in input) return String(input.url);
  return String(input);
}

/** @param {unknown} err @returns {string} */
function describeError(err) {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, 300);
}

globalThis.fetch = async (input) => {
  strayFetches.push(urlOf(input));
  throw new Error("anthropic-wire-probe: a fetch outside the capture was attempted");
};
// A rejected SDK promise nobody reads (e.g. after the abort) must not kill the probe
// and lose the other cases' evidence; it is reported in the summary instead.
process.on("unhandledRejection", (reason) => {
  unhandledRejections.push(describeError(reason));
});

// ---------------------------------------------------------------------------
// The capture fetch + minimal Messages API replies
// ---------------------------------------------------------------------------

/**
 * @param {unknown} headers
 * @returns {Record<string, string>} lower-case keys, from a Headers, pairs or a plain object
 */
function normaliseHeaders(headers) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[String(key).toLowerCase()] = String(value);
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) out[key.toLowerCase()] = String(value);
  }
  return out;
}

/**
 * @typedef {{ url: string, host: string, path: string, method: string | undefined,
 *   headers: Record<string, string>, body: any, signalPassed: boolean }} Captured
 * @typedef {(body: any, init: RequestInit) => Response} Reply
 */

/** @param {Reply} reply */
function makeCapture(reply) {
  /** @type {Captured[]} */
  const requests = [];
  /** @type {typeof fetch} */
  const capture = async (input, init = {}) => {
    const url = urlOf(input);
    let body;
    try {
      body = JSON.parse(String(init.body));
    } catch {
      body = { unparsedBody: String(init.body).slice(0, 200) };
    }
    const parsed = new URL(url);
    requests.push({
      url,
      host: parsed.host,
      path: parsed.pathname,
      method: init.method,
      headers: normaliseHeaders(init.headers),
      body,
      signalPassed: init.signal instanceof AbortSignal,
    });
    return reply(body, init);
  };
  return { capture, requests };
}

/** @param {string} type @param {Record<string, unknown>} data */
function sse(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

/** @param {string} model */
function messageStart(model) {
  return sse("message_start", {
    message: {
      id: "msg_wire_probe",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 },
    },
  });
}
const BLOCK_START = sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
const TEXT_DELTA = sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } });
const BLOCK_STOP = sse("content_block_stop", { index: 0 });
const MESSAGE_DELTA = sse("message_delta", {
  delta: { stop_reason: "end_turn", stop_sequence: null },
  usage: { output_tokens: 2 },
});
const MESSAGE_STOP = sse("message_stop", {});

/** A JSON message for a non-streaming call; the whole SSE sequence for a streaming one.
 *  @type {Reply} */
function completeReply(body) {
  const model = String(body?.model ?? "unknown");
  if (body?.stream === true) {
    const text = messageStart(model) + BLOCK_START + TEXT_DELTA + BLOCK_STOP + MESSAGE_DELTA + MESSAGE_STOP;
    return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  const message = {
    id: "msg_wire_probe",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "Probe Title" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2 },
  };
  return new Response(JSON.stringify(message), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Case e's body: three events, then held open until the request signal aborts, when it
 * ERRORS with the signal's reason (undici's behaviour). A body that merely stalled
 * would hang forever: the SDK emits its `abort` part only when a pending read returns
 * or rejects after the abort.
 * @type {Reply}
 */
function holdOpenReply(body, init) {
  const encoder = new TextEncoder();
  const signal = init.signal;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(messageStart(String(body?.model ?? "unknown")) + BLOCK_START + TEXT_DELTA));
      if (!signal) return; // no signal reached fetch: the watchdog records the hang
      const fail = () => controller.error(signal.reason);
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** @param {typeof fetch} capture */
function anthropicWith(capture) {
  return createAnthropic({ apiKey: API_KEY, baseURL: BASE_URL, fetch: capture });
}

/** The callers' spread, in the same shape as titles.ts and the chat route.
 *  @param {{ maxOutputTokens: number, providerOptions?: any }} options */
function callParams(options) {
  return {
    maxOutputTokens: options.maxOutputTokens,
    ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
  };
}

const PROBE_TOOL = tool({
  description: "Probe lookup. Never called by the scripted reply.",
  inputSchema: jsonSchema({
    type: "object",
    properties: { q: { type: "string" } },
    required: ["q"],
    additionalProperties: false,
  }),
  execute: async () => ({ ok: true }),
});

// ---------------------------------------------------------------------------
// Case runner: one NDJSON line per case, a 10 s watchdog each
// ---------------------------------------------------------------------------

class Watchdog extends Error {
  constructor() {
    super("watchdog");
    this.name = "Watchdog";
  }
}

/** @param {Record<string, unknown>} record */
function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

/**
 * @param {string} name
 * @param {(record: Record<string, any>) => Promise<void>} run
 */
async function runCase(name, run) {
  /** @type {Record<string, any>} */
  const record = { case: name };
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    await Promise.race([
      run(record),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Watchdog()), WATCHDOG_MS);
      }),
    ]);
  } catch (err) {
    record.error = err instanceof Watchdog ? "watchdog" : describeError(err);
  } finally {
    clearTimeout(timer);
  }
  emit(record);
}

/** @param {string} text */
function bundleFacts(text) {
  const imports = [];
  const importPattern =
    /\bimport\s*(?:[^"'();]*?\bfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of text.matchAll(importPattern)) imports.push(match[1] ?? match[2] ?? match[3]);
  // esbuild heads every bundled module with a `// <path>` comment (other comments are
  // dropped), so these are the files the bundle actually contains.
  const sources = Array.from(text.matchAll(/^\/\/ (\S+)$/gm), (match) => match[1]);
  return { imports, sources, mentionsPrisma: /prisma/i.test(text) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** @type {any} */
let modelOptions;
/** @type {any} */
let streamMetadata;
try {
  const bundles = [];
  /** @type {any[]} */
  const modules = [];
  for (const leaf of LEAVES) {
    const outfile = await bundleToCache(path.join(REPO_ROOT, leaf), { external: [] });
    bundles.push({ entry: leaf, ...bundleFacts(await readFile(outfile, "utf8")) });
    modules.push(await import(pathToFileURL(outfile).href));
  }
  [modelOptions, streamMetadata] = modules;
  if (typeof modelOptions.modelCallOptions !== "function") {
    throw new Error("the model-options bundle does not export modelCallOptions");
  }
  if (typeof streamMetadata.turnMessageMetadata !== "function") {
    throw new Error("the stream-metadata bundle does not export turnMessageMetadata");
  }
  emit({ case: "bundles", bundles });
} catch (err) {
  process.stderr.write(
    `anthropic-wire-probe: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
}

const SYSTEM = "Probe system prompt.";
const PROMPT = "How many units of the probe widget are on hand?";

/** @param {string} model @param {(model: string) => Record<string, unknown>} params */
function titleCase(model, params) {
  /** @param {Record<string, any>} record */
  return async (record) => {
    const { capture, requests } = makeCapture(completeReply);
    record.model = model;
    record.requests = requests;
    const result = await generateText({
      model: anthropicWith(capture)(model),
      system: SYSTEM,
      prompt: PROMPT,
      ...params(model),
    });
    record.text = result.text;
    record.finishReason = result.finishReason;
  };
}

/** @param {string} model */
function chatCase(model) {
  /** @param {Record<string, any>} record */
  return async (record) => {
    const { capture, requests } = makeCapture(completeReply);
    record.model = model;
    record.requests = requests;
    /** @type {string[]} */
    const streamErrors = [];
    record.streamErrors = streamErrors;
    const options = modelOptions.modelCallOptions({ kind: "ANTHROPIC", model, surface: "assistant" });
    const result = streamText({
      model: anthropicWith(capture)(model),
      system: SYSTEM,
      prompt: PROMPT,
      tools: { probe_lookup: PROBE_TOOL },
      stopWhen: stepCountIs(10),
      ...callParams(options),
      onError: () => {},
    });
    // streamText sends nothing until its stream is consumed.
    await result.consumeStream({ onError: (err) => streamErrors.push(describeError(err)) });
    record.finishReason = await result.finishReason;
  };
}

/** @param {string} model */
function abortCase(model) {
  /** @param {Record<string, any>} record */
  return async (record) => {
    const { capture, requests } = makeCapture(holdOpenReply);
    const controller = new AbortController();
    /** @type {string[]} */
    const chunkTypes = [];
    /** @type {string[]} */
    const readErrors = [];
    record.model = model;
    record.requests = requests;
    record.chunkTypes = chunkTypes;
    record.readErrors = readErrors;
    record.abortChunkSeen = false;
    record.abortedAfterFirstDelta = false;

    const options = modelOptions.modelCallOptions({ kind: "ANTHROPIC", model, surface: "assistant" });
    const result = streamText({
      model: anthropicWith(capture)(model),
      system: SYSTEM,
      prompt: PROMPT,
      abortSignal: controller.signal,
      ...callParams(options),
      onError: () => {},
    });
    const uiChunks = result
      .toUIMessageStream({
        // The route's rule, with T1's cause latched.
        messageMetadata: ({ part }) => streamMetadata.turnMessageMetadata(part, "provider-timeout", "t1"),
      })
      .pipeThrough(
        new TransformStream({
          transform(chunk, out) {
            chunkTypes.push(chunk.type);
            if (chunk.type === "abort") record.abortChunkSeen = true;
            out.enqueue(chunk);
            if (chunk.type === "text-delta" && !controller.signal.aborted) {
              record.abortedAfterFirstDelta = true;
              controller.abort();
            }
          },
        }),
      );

    /** @type {any} */
    let last = null;
    for await (const message of readUIMessageStream({
      stream: uiChunks,
      onError: (err) => readErrors.push(describeError(err)),
    })) {
      last = message;
    }
    record.finalMetadata = last?.metadata ?? null;
    record.finalText = (last?.parts ?? [])
      .filter((/** @type {any} */ part) => part.type === "text")
      .map((/** @type {any} */ part) => part.text)
      .join("");
  };
}

const titleParams = (/** @type {string} */ model) =>
  callParams(modelOptions.modelCallOptions({ kind: "ANTHROPIC", model, surface: "title" }));
// The PRE-A1 title call, literally (titles.ts before A1): the non-vacuity control.
const preA1TitleParams = () => ({
  maxOutputTokens: 256,
  providerOptions: { anthropic: { thinking: { type: "disabled" } } },
});

await runCase("a0", titleCase("claude-opus-5-5", preA1TitleParams));
await runCase("a", titleCase("claude-opus-5-5", titleParams));
await runCase("b", chatCase("claude-opus-5-5"));
await runCase("c", chatCase("claude-opus-5"));
await runCase("d", chatCase("claude-sonnet-4-5"));
await runCase("e", abortCase("claude-opus-5-5"));

emit({ case: "summary", captureHost: CAPTURE_HOST, strayFetches, unhandledRejections });
