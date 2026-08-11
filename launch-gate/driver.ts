/**
 * launch-gate/driver.ts — the HTTP driver (spec C7 "Driver"; contract pack T8; seam
 * S9).
 *
 * Everything the matrices do to the app goes through here: the NextAuth credentials
 * dance, the app's own CSRF handshake, the C2 envelope POST, and the SSE parse.
 *
 * LOGIN ONCE PER USER. `lib/auth.ts:85` rate-limits credentials logins to 20 per IP
 * per 15 minutes, and every seeded user shares one loopback IP — a per-turn login
 * would exhaust that inside a single matrix. Sessions are created in global setup,
 * written to the state file, and reused; the JWT strategy means they also survive
 * `restartApp()` (same NEXTAUTH_SECRET, no server-side session store).
 *
 * POST BUDGET. The route's in-process limiter is 30 chat POSTs per user per hour
 * (route.ts:72), so the harness counts them itself, per user PER APP GENERATION, and
 * FAILS the suite on breach. A silent 429 mid-matrix would look like a product bug.
 *
 * SSE PARSE. The transport is chunked HTTP, not one-event-per-chunk: the parser
 * buffers until it has complete `\n\n` frames. `events` carries exactly the bound
 * `SseEvent` union; `raw` carries every byte the server sent (the row-1 leak scan
 * greps sentinels over `raw`, so it must stay lossless).
 */

// Relative + type-only: this module sits in globalSetup's require graph, where jest
// does not apply `moduleNameMapper` (test files still may use the `@/` alias).
import type { EnvelopeC2 } from "../lib/assistant/thread-contracts";
import { GATE_SEED } from "./seed";
import { readState, updateState, type Session } from "./state";

export const APP_BASE_URL = "http://127.0.0.1:3100";
export const MCP_BASE_URL = "http://127.0.0.1:3101";

/**
 * Chat POSTs allowed per user per app generation. Below the route's 30/hr so the
 * driver fails FIRST with a legible message instead of surfacing a 429 (pack T8:
 * "never a silent 429"). Every stated per-task budget (1.7 <= 20, 1.8 <= 24, 2.4a
 * <= 10, 3.3 <= 10) fits, warm-up included.
 */
export const POST_BUDGET_PER_GENERATION = 28;

export type StreamMetadata = { threadId?: string; finishReason?: string };

export type SseEvent =
  | { type: "text-delta"; id: string; delta: string }
  | { type: "tool-input-available"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-output-available"; toolCallId: string; output: unknown }
  | { type: "start"; messageId?: string; messageMetadata?: StreamMetadata }
  | { type: "finish"; finishReason?: string; messageMetadata?: StreamMetadata }
  | { type: "message-metadata"; messageMetadata: StreamMetadata }
  | { type: "abort"; reason?: string }
  | { type: "error"; errorText: string };

export type TurnResult = {
  events: SseEvent[];
  text: string;
  threadId: string | null;
  status: number;
  raw: string;
};

const UNION_TYPES = new Set([
  "text-delta",
  "tool-input-available",
  "tool-output-available",
  "start",
  "finish",
  "message-metadata",
  "abort",
  "error",
]);

/** Merge a `Set-Cookie` list into an existing `Cookie:` header value. */
function mergeCookies(existing: string, setCookies: string[]): string {
  const jar = new Map<string, string>();
  for (const pair of existing.split("; ").filter(Boolean)) {
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  for (const raw of setCookies) {
    const [pair] = raw.split(";");
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1));
  }
  return Array.from(jar, ([name, value]) => `${name}=${value}`).join("; ");
}

function setCookiesOf(response: Response): string[] {
  const getter = response.headers as Headers & { getSetCookie?: () => string[] };
  return typeof getter.getSetCookie === "function" ? getter.getSetCookie() : [];
}

/**
 * The scripted NextAuth credentials flow (spec C7 "Driver"):
 *   GET  /api/auth/csrf                  -> csrfToken + the csrf cookie
 *   POST /api/auth/callback/credentials  -> the session cookie
 * then the app's own CSRF handshake (GET /api/csrf -> `x-csrf-token`).
 *
 * Called ONCE per user per run; the resulting `Session` is persisted to the state
 * file and every later call reads it back.
 */
export async function loginOnce(user: Session["user"]): Promise<Session> {
  const cached = readState().sessions[user];
  if (cached !== undefined) return cached;

  const actor = GATE_SEED.actors[user];
  let cookieHeader = "";

  const csrfResponse = await fetch(`${APP_BASE_URL}/api/auth/csrf`, { redirect: "manual" });
  if (!csrfResponse.ok) {
    throw new Error(`NextAuth csrf handshake failed with ${csrfResponse.status}`);
  }
  cookieHeader = mergeCookies(cookieHeader, setCookiesOf(csrfResponse));
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };

  const callback = await fetch(`${APP_BASE_URL}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader },
    body: new URLSearchParams({
      csrfToken,
      email: actor.email,
      password: actor.password,
      callbackUrl: "http://localhost:3100/",
      json: "true",
    }).toString(),
  });
  cookieHeader = mergeCookies(cookieHeader, setCookiesOf(callback));
  if (!cookieHeader.includes("next-auth.session-token=")) {
    throw new Error(
      `credentials login for ${user} (${actor.email}) did not yield a session cookie ` +
        `(status ${callback.status}); check the seed's bcrypt hash, isApproved, and the ` +
        "ALLOWED_EMAIL_DOMAINS posture",
    );
  }

  const appCsrf = await fetch(`${APP_BASE_URL}/api/csrf`, {
    redirect: "manual",
    headers: { cookie: cookieHeader },
  });
  if (!appCsrf.ok) throw new Error(`app csrf handshake failed with ${appCsrf.status}`);
  cookieHeader = mergeCookies(cookieHeader, setCookiesOf(appCsrf));
  const { token } = (await appCsrf.json()) as { token: string };

  const session: Session = { user, cookieHeader, csrfToken: token };
  updateState((state) => {
    state.sessions[user] = session;
  });
  return session;
}

/**
 * THE MIDDLEWARE WINDOW (Task 1.8, declared — a second limiter the POST budget did
 * not model).
 *
 * `middleware.ts:43` runs `enforceRateLimit(request, "middleware:/api/assistant")`
 * with lib/rateLimit's DEFAULTS: 30 requests per 60 SECONDS, keyed by IP. Every
 * seeded caller shares one loopback IP, so this is a SUITE-WIDE budget measured in
 * wall clock — a completely different shape from the route's own 30/hr per-user
 * limiter (`POST_BUDGET_PER_GENERATION`), and the binding one once the matrix drives
 * ~40 turns. It is also invisible from any single test file: three fast files in a
 * row can exhaust it for a fourth that has spent almost nothing.
 *
 * The harness RESPECTS it rather than working around it (no test-only override, no
 * new product seam): a POST that would breach the window WAITS for the oldest entry
 * to age out. Timestamps live in the state file because each jest test file gets a
 * fresh module registry and the window spans files.
 */
const MIDDLEWARE_WINDOW_MS = 60_000;
const MIDDLEWARE_LIMIT = 30;
/** Two spare requests, the same headroom `POST_BUDGET_PER_GENERATION` keeps against
 *  the route limiter: the harness fails or waits BEFORE the product refuses. */
const MIDDLEWARE_EFFECTIVE_LIMIT = MIDDLEWARE_LIMIT - 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reserve a slot in the trailing-60s window, waiting (bounded by the window itself)
 *  when it is full. Returns the milliseconds spent waiting. */
async function reserveMiddlewareSlot(): Promise<number> {
  const startedAt = Date.now();
  let waitedAtAll = false;
  for (;;) {
    const { result } = updateState((state) => {
      const now = Date.now();
      const recent = (state.postTimestamps ?? []).filter(
        (stamp) => now - stamp < MIDDLEWARE_WINDOW_MS,
      );
      if (recent.length >= MIDDLEWARE_EFFECTIVE_LIMIT) {
        state.postTimestamps = recent;
        return MIDDLEWARE_WINDOW_MS - (now - recent[0]) + 250;
      }
      recent.push(now);
      state.postTimestamps = recent;
      return 0;
    });
    if (result <= 0) {
      const waited = Date.now() - startedAt;
      // Only when the window was ACTUALLY full — otherwise this logs the microsecond
      // the state-file lock took and reads like a throttle that is always engaging.
      if (waitedAtAll) {
        console.log(
          `[launch-gate] middleware window: waited ${waited}ms for the 30-per-60s ` +
            "/api/assistant bucket to roll over",
        );
      }
      return waited;
    }
    waitedAtAll = true;
    await sleep(result);
  }
}

/** Charge one chat POST against the caller's budget for the CURRENT generation. */
function chargePost(user: Session["user"]): void {
  const { result } = updateState((state) => {
    const key = String(state.appGeneration);
    const generation = state.postCounts[key] ?? ({} as Record<Session["user"], number>);
    generation[user] = (generation[user] ?? 0) + 1;
    state.postCounts[key] = generation;
    return generation[user];
  });
  if (result > POST_BUDGET_PER_GENERATION) {
    throw new Error(
      `POST budget breached: ${user} has now spent ${result} chat POSTs in this app generation ` +
        `(limit ${POST_BUDGET_PER_GENERATION}; the route's in-process limiter cuts in at 30/hr). ` +
        "Pack more tool calls per turn, spread the load across the seeded callers, or take a " +
        "restartApp() generation boundary.",
    );
  }
}

/**
 * Extras a caller may want mid-flight. Both were added by 1.6 (Spike B): a client
 * disconnect cannot be scripted without an abort handle, and the moment to pull it
 * is "when content has actually arrived", which the returned `TurnResult` — a value
 * that only exists once the stream is over — cannot express.
 */
export type PostTurnOptions = {
  /**
   * Aborts the client half of the stream. The in-flight `fetch`/read then rejects
   * with an `AbortError` and `postTurn` PROPAGATES it (standard fetch semantics):
   * a caller that aborts on purpose catches its own abort, and the events it has
   * seen reach it through `onEvent`, not through a return value.
   */
  signal?: AbortSignal;
  /** Called with each union event AS IT ARRIVES, before the stream completes. */
  onEvent?: (event: SseEvent) => void;
};

/** Read the response body to completion, re-cutting arbitrary network chunks into
 *  complete `\n\n` SSE frames. Returns the raw text AND the union events. */
async function parseSse(
  response: Response,
  onEvent?: (event: SseEvent) => void,
): Promise<{ raw: string; events: SseEvent[] }> {
  const events: SseEvent[] = [];
  let raw = "";
  let buffer = "";

  const emit = (frame: string): void => {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (typeof chunk !== "object" || chunk === null) continue;
      const typed = chunk as { type?: unknown };
      if (typeof typed.type === "string" && UNION_TYPES.has(typed.type)) {
        const event = chunk as SseEvent;
        events.push(event);
        onEvent?.(event);
      }
    }
  };

  const body = response.body;
  if (body !== null) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      raw += text;
      buffer += text;
      for (;;) {
        const cut = buffer.indexOf("\n\n");
        if (cut === -1) break;
        emit(buffer.slice(0, cut));
        buffer = buffer.slice(cut + 2);
      }
    }
    if (buffer.trim() !== "") emit(buffer);
  }
  return { raw, events };
}

/** threadId/finishReason ride THREE metadata carriers (pack T8) — read all of them. */
function metadataOf(events: SseEvent[]): StreamMetadata {
  const merged: StreamMetadata = {};
  for (const event of events) {
    const carrier =
      event.type === "start" || event.type === "finish" || event.type === "message-metadata"
        ? event.messageMetadata
        : undefined;
    if (carrier?.threadId !== undefined && merged.threadId === undefined) {
      merged.threadId = carrier.threadId;
    }
    if (carrier?.finishReason !== undefined) merged.finishReason = carrier.finishReason;
    if (event.type === "finish" && event.finishReason !== undefined && merged.finishReason === undefined) {
      merged.finishReason = event.finishReason;
    }
  }
  return merged;
}

/**
 * POST the C2 envelope and drain the stream. A non-streaming guard failure (400/403/
 * 409/429) returns with `events: []` and the JSON body in `raw` — the caller reads
 * `status` and parses `raw` itself.
 */
export async function postTurn(
  session: Session,
  body: EnvelopeC2,
  options: PostTurnOptions = {},
): Promise<TurnResult> {
  chargePost(session.user);
  await reserveMiddlewareSlot();
  const response = await fetch(`${APP_BASE_URL}/api/assistant`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      cookie: session.cookieHeader,
      "x-csrf-token": session.csrfToken,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const raw = await response.text();
    return { events: [], text: "", threadId: null, status: response.status, raw };
  }

  const { raw, events } = await parseSse(response, options.onEvent);
  const text = events
    .filter((event): event is Extract<SseEvent, { type: "text-delta" }> => event.type === "text-delta")
    .map((event) => event.delta)
    .join("");
  const metadata = metadataOf(events);
  return { events, text, threadId: metadata.threadId ?? null, status: response.status, raw };
}

export type ApiResponse = { status: number; raw: string };

/** Authenticated GET against the app (thread list/detail). Not budgeted — the chat
 *  limiter only counts POSTs to /api/assistant. */
export async function apiGet(session: Session, path: string): Promise<ApiResponse> {
  const response = await fetch(`${APP_BASE_URL}${path}`, {
    redirect: "manual",
    headers: { cookie: session.cookieHeader },
  });
  return { status: response.status, raw: await response.text() };
}

/** Authenticated DELETE against the app (thread delete; CSRF-guarded). */
export async function apiDelete(session: Session, path: string): Promise<ApiResponse> {
  const response = await fetch(`${APP_BASE_URL}${path}`, {
    method: "DELETE",
    redirect: "manual",
    headers: { cookie: session.cookieHeader, "x-csrf-token": session.csrfToken },
  });
  return { status: response.status, raw: await response.text() };
}

export type McpResponse = { status: number; raw: string; json: unknown };

/** One JSON-RPC call against the MCP sidecar. Stateless transport: `tools/call`
 *  needs no prior `initialize` (mcp/src/build-smoke.test.ts precedent). */
export async function mcpCall(
  tokenPlaintext: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<McpResponse> {
  const response = await fetch(`${MCP_BASE_URL}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokenPlaintext}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const raw = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* a non-JSON body is itself the finding; the caller reads `raw` */
  }
  return { status: response.status, raw, json };
}
