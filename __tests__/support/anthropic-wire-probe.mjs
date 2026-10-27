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
 *       `readUIMessageStream`;
 *   e-sse  the same abort chain over the REAL wire (pack C4 REV 7, A1-CRS-1): the UI
 *       chunks go through `createUIMessageStreamResponse` (the SSE encoder the route's
 *       `toUIMessageStreamResponse` uses); the Response body is teed — one branch read
 *       as raw SSE text, the other handed to a REAL `DefaultChatTransport` whose
 *       `fetch` returns it (an `api` on the `.invalid` client host) — and the stream
 *       `sendMessages` returns (parsed with `uiMessageChunkSchema`) is read with
 *       `readUIMessageStream`;
 *   e-sse-client  control (non-vacuity): the same with cause "client" (a user Stop) —
 *       the abort still arrives, with NO timeout metadata behind it;
 *   f   rejected tool calls (pack C12 REV 11, A1-FD3-1): a three-step `streamText`
 *       through `toUIMessageStream({ onError })` whose capture scripts step 1 a
 *       `tool_use` for an UNKNOWN tool, step 2 a `tool_use` whose input fails the tool's
 *       zod schema, step 3 plain text with `end_turn`. Every `onError` argument is
 *       recorded — its kind (instance / string / object) and lib/assistant/
 *       stream-errors.ts's verdict — and tied to its UI chunk through the error text
 *       this `onError` returns (`TOOL_ERROR#n` / `PROVIDER_ERROR#n`);
 *   f-overloaded  control: an `overloaded_error` event mid-stream (after a text delta);
 *   f-500  control: an HTTP 500 (`maxRetries: 0`, so the one attempt is the error).
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
import {
  createUIMessageStreamResponse,
  DefaultChatTransport,
  generateText,
  jsonSchema,
  readUIMessageStream,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { z } from "zod";
import { bundleToCache } from "./esm-bundle.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LEAVES = ["lib/assistant/model-options.ts", "lib/assistant/stream-metadata.ts"];
/** Imports `ai` (the two error classes): bundled with `ai` EXTERNAL, so the bundle and
 *  this probe share the one installed SDK (pack C12 REV 11). */
const AI_LEAVES = ["lib/assistant/stream-errors.ts"];

const CAPTURE_HOST = "anthropic-wire-probe.invalid";
const BASE_URL = `https://${CAPTURE_HOST}/v1`;
/** Case e-sse's client side: the transport's `api` (its `fetch` is in-process). */
const CLIENT_HOST = "wire-probe.invalid";
const CLIENT_API = `https://${CLIENT_HOST}/api/assistant`;
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

/** @param {string} text */
function sseResponse(text) {
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * One streamed `tool_use` turn (`stop_reason: "tool_use"`), the input sent as one
 * `input_json_delta` exactly as the Messages API streams it.
 * @param {string} id @param {string} name @param {string} inputJson
 * @returns {Reply}
 */
function toolUseReply(id, name, inputJson) {
  return (body) =>
    sseResponse(
      messageStart(String(body?.model ?? "unknown")) +
        sse("content_block_start", { index: 0, content_block: { type: "tool_use", id, name, input: {} } }) +
        sse("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: inputJson } }) +
        sse("content_block_stop", { index: 0 }) +
        sse("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }) +
        MESSAGE_STOP,
    );
}

/** One streamed text turn ending `end_turn`. @param {string} text @returns {Reply} */
function textReply(text) {
  return (body) =>
    sseResponse(
      messageStart(String(body?.model ?? "unknown")) +
        BLOCK_START +
        sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
        BLOCK_STOP +
        MESSAGE_DELTA +
        MESSAGE_STOP,
    );
}

/** The replies in order, one per request (one per step); a request past the script is
 *  answered with the last one. @param {Reply[]} replies @returns {Reply} */
function scriptedReplies(replies) {
  let next = 0;
  return (body, init) => replies[Math.min(next++, replies.length - 1)](body, init);
}

/** Case f-overloaded: a text delta, then the API's `overloaded_error` event mid-stream.
 *  @type {Reply} */
function overloadedReply(body) {
  return sseResponse(
    messageStart(String(body?.model ?? "unknown")) +
      BLOCK_START +
      TEXT_DELTA +
      sse("error", { error: { type: "overloaded_error", message: "Overloaded" } }),
  );
}

/** Case f-500: the API's 500 error body. @type {Reply} */
function serverErrorReply() {
  return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "Internal server error" } }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
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

/** Case f's one tool. A zod schema, as the assistant's real tools have (tool-adapters.ts),
 *  so input that fails it is the SDK's InvalidToolInputError (`jsonSchema` without a
 *  `validate` never rejects). */
const F_TOOL_NAME = "probe_stock";
const F_TOOL = tool({
  description: "Probe stock lookup. The scripted reply calls it with input that fails its schema.",
  inputSchema: z.object({ q: z.string() }),
  execute: async () => ({ ok: true }),
});
const F_UNKNOWN_CALL = { id: "toolu_f_unknown", name: "probe_no_such_tool", input: "{}" };
const F_INVALID_CALL = { id: "toolu_f_invalid", name: F_TOOL_NAME, input: '{"q":5}' };
const F_TEXT = "Alpha 5mg has 12 on hand.";

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
/** @type {any} */
let streamErrors;
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
  const aiBundles = [];
  /** @type {any[]} */
  const aiModules = [];
  for (const leaf of AI_LEAVES) {
    const outfile = await bundleToCache(path.join(REPO_ROOT, leaf), { external: ["ai"] });
    aiBundles.push({ entry: leaf, ...bundleFacts(await readFile(outfile, "utf8")) });
    aiModules.push(await import(pathToFileURL(outfile).href));
  }
  [streamErrors] = aiModules;
  if (typeof modelOptions.modelCallOptions !== "function") {
    throw new Error("the model-options bundle does not export modelCallOptions");
  }
  if (typeof streamMetadata.turnMessageMetadata !== "function") {
    throw new Error("the stream-metadata bundle does not export turnMessageMetadata");
  }
  if (typeof streamErrors.isRecoveredToolCallError !== "function") {
    throw new Error("the stream-errors bundle does not export isRecoveredToolCallError");
  }
  emit({ case: "bundles", bundles, aiBundles });
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

/** @param {ReadableStream<Uint8Array>} stream @returns {Promise<string>} */
async function readAllText(stream) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += value;
  }
}

/**
 * The `data:` payloads of an SSE text, in order: the chunk `type` of each JSON line
 * (`[DONE]` kept as itself) plus the parsed chunks; a line that does not parse is
 * recorded, never dropped.
 * @param {string} text
 */
function sseData(text) {
  /** @type {string[]} */
  const types = [];
  /** @type {any[]} */
  const chunks = [];
  /** @type {string[]} */
  const parseErrors = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      types.push("[DONE]");
      continue;
    }
    try {
      const chunk = JSON.parse(payload);
      chunks.push(chunk);
      types.push(String(chunk?.type));
    } catch {
      parseErrors.push(payload.slice(0, 120));
    }
  }
  return { types, chunks, parseErrors };
}

/**
 * Case e-sse (and its control): case e's abort chain carried over the REAL SSE
 * encoding and the REAL client transport's parse — what the browser's `useChat`
 * transport actually reads.
 * @param {string} model
 * @param {"provider-timeout" | "client"} cause the latch's cause when the abort part arrives
 */
function abortSseCase(model, cause) {
  /** @param {Record<string, any>} record */
  return async (record) => {
    const { capture, requests } = makeCapture(holdOpenReply);
    const controller = new AbortController();
    /** @type {string[]} */
    const clientChunkTypes = [];
    /** @type {string[]} */
    const readErrors = [];
    /** @type {Array<Record<string, unknown>>} */
    const clientRequests = [];
    record.model = model;
    record.cause = cause;
    record.requests = requests;
    record.clientRequests = clientRequests;
    record.clientChunkTypes = clientChunkTypes;
    record.readErrors = readErrors;
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
        // The route's rule, with the latch's cause.
        messageMetadata: ({ part }) => streamMetadata.turnMessageMetadata(part, cause, "t1"),
      })
      .pipeThrough(
        new TransformStream({
          transform(chunk, out) {
            out.enqueue(chunk);
            if (chunk.type === "text-delta" && !controller.signal.aborted) {
              record.abortedAfterFirstDelta = true;
              controller.abort();
            }
          },
        }),
      );

    // The wire: the SSE encoder, then the body teed — raw text on one branch, the
    // client transport on the other.
    const response = createUIMessageStreamResponse({ stream: uiChunks });
    if (response.body === null) throw new Error("createUIMessageStreamResponse returned no body");
    const [rawBranch, clientBranch] = response.body.tee();
    const rawText = readAllText(rawBranch);
    record.responseHeaders = {
      "content-type": response.headers.get("content-type"),
      "x-vercel-ai-ui-message-stream": response.headers.get("x-vercel-ai-ui-message-stream"),
    };

    const transport = new DefaultChatTransport({
      api: CLIENT_API,
      fetch: async (input, init = {}) => {
        const url = urlOf(input);
        clientRequests.push({ url, host: new URL(url).host, method: init.method });
        return new Response(clientBranch, { status: response.status, headers: response.headers });
      },
    });
    const parsed = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "t1",
      messageId: undefined,
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: PROMPT }] }],
      abortSignal: undefined,
    });

    /** @type {any} */
    let last = null;
    for await (const message of readUIMessageStream({
      stream: parsed.pipeThrough(
        new TransformStream({
          transform(chunk, out) {
            clientChunkTypes.push(chunk.type);
            out.enqueue(chunk);
          },
        }),
      ),
      onError: (err) => readErrors.push(describeError(err)),
    })) {
      last = message;
    }
    record.abortChunkSeen = clientChunkTypes.includes("abort");
    record.finalMetadata = last?.metadata ?? null;
    record.finalText = (last?.parts ?? [])
      .filter((/** @type {any} */ part) => part.type === "text")
      .map((/** @type {any} */ part) => part.text)
      .join("");

    const sse = sseData(await rawText);
    record.sseDataTypes = sse.types;
    record.sseParseErrors = sse.parseErrors;
    const abortAt = sse.chunks.findIndex((chunk) => chunk?.type === "abort");
    record.sseMetadataAfterAbort =
      abortAt < 0
        ? []
        : sse.chunks
            .slice(abortAt + 1)
            .filter((chunk) => chunk?.type === "message-metadata")
            .map((chunk) => chunk.messageMetadata);
    record.sseAbortBeforeTimeoutMetadata = record.sseMetadataAfterAbort.some(
      (/** @type {any} */ metadata) => metadata?.errorCode === "PROVIDER_TIMEOUT",
    );
  };
}

/** @param {unknown} error @returns {string} */
function errorKind(error) {
  if (typeof error === "string") return "string";
  if (error instanceof Error) return "instance";
  return error !== null && typeof error === "object" ? "object" : typeof error;
}

/** The class an `onError` argument names: an Error's `name`, a string's text before
 *  its first ": ", an object's `type`. @param {unknown} error @returns {string | null} */
function errorName(error) {
  if (typeof error === "string") return error.includes(": ") ? error.slice(0, error.indexOf(": ")) : null;
  if (error instanceof Error) return error.name;
  if (error !== null && typeof error === "object" && "type" in error) return String(error.type);
  return null;
}

/**
 * Cases f / f-overloaded / f-500 (pack C12 REV 11): what the REAL SDK hands the UI
 * stream's `onError`, and how lib/assistant/stream-errors.ts classifies each argument.
 * @param {string} model
 * @param {Reply} reply
 * @param {Record<string, unknown>} [extra] further `streamText` options
 */
function onErrorCase(model, reply, extra = {}) {
  /** @param {Record<string, any>} record */
  return async (record) => {
    const { capture, requests } = makeCapture(reply);
    /** @type {Array<{ n: number, kind: string, name: string | null, verdict: boolean }>} */
    const onErrorCalls = [];
    /** @type {Array<Record<string, unknown>>} */
    const errorChunks = [];
    /** @type {string[]} */
    const chunkTypes = [];
    /** @type {string[]} */
    const readErrors = [];
    record.model = model;
    record.requests = requests;
    record.onErrorCalls = onErrorCalls;
    record.errorChunks = errorChunks;
    record.chunkTypes = chunkTypes;
    record.readErrors = readErrors;

    const options = modelOptions.modelCallOptions({ kind: "ANTHROPIC", model, surface: "assistant" });
    const result = streamText({
      model: anthropicWith(capture)(model),
      system: SYSTEM,
      prompt: PROMPT,
      tools: { [F_TOOL_NAME]: F_TOOL },
      stopWhen: stepCountIs(10),
      ...callParams(options),
      ...extra,
      onError: () => {},
    });
    const uiChunks = result
      .toUIMessageStream({
        // The returned text becomes the chunk's `errorText`, which ties each recorded
        // call to the chunk the SDK built with it.
        onError: (error) => {
          const n = onErrorCalls.length + 1;
          const verdict = streamErrors.isRecoveredToolCallError(error);
          onErrorCalls.push({ n, kind: errorKind(error), name: errorName(error), verdict });
          return `${verdict ? "TOOL_ERROR" : "PROVIDER_ERROR"}#${n}`;
        },
      })
      .pipeThrough(
        new TransformStream({
          transform(chunk, out) {
            chunkTypes.push(chunk.type);
            if ("errorText" in chunk) {
              errorChunks.push({
                type: chunk.type,
                toolCallId: "toolCallId" in chunk ? chunk.toolCallId : null,
                toolName: "toolName" in chunk ? chunk.toolName : null,
                errorText: chunk.errorText,
              });
            }
            out.enqueue(chunk);
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
    try {
      record.finishReason = await result.finishReason;
    } catch (err) {
      record.finishReasonError = describeError(err);
    }
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
await runCase("e-sse", abortSseCase("claude-opus-5-5", "provider-timeout"));
await runCase("e-sse-client", abortSseCase("claude-opus-5-5", "client"));
await runCase(
  "f",
  onErrorCase(
    "claude-opus-5-5",
    scriptedReplies([
      toolUseReply(F_UNKNOWN_CALL.id, F_UNKNOWN_CALL.name, F_UNKNOWN_CALL.input),
      toolUseReply(F_INVALID_CALL.id, F_INVALID_CALL.name, F_INVALID_CALL.input),
      textReply(F_TEXT),
    ]),
  ),
);
await runCase("f-overloaded", onErrorCase("claude-opus-5-5", overloadedReply));
await runCase("f-500", onErrorCase("claude-opus-5-5", serverErrorReply, { maxRetries: 0 }));

emit({ case: "summary", captureHost: CAPTURE_HOST, strayFetches, unhandledRejections });
