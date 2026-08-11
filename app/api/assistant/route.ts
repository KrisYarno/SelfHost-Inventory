/**
 * app/api/assistant/route.ts — the streaming in-app assistant (spec C2/C3/C4;
 * D5, D13).
 *
 * Guards run and FAIL AS PLAIN JSON before the stream opens (no partial stream
 * on a rejected request): requireApproved -> requireCSRF -> enforceRateLimit ->
 * envelope parse -> provider resolution -> the CLAIM transaction. Only then does
 * `streamText` open, with the curated read tools bound to the caller's ToolContext
 * and a per-turn byte budget.
 *
 * Security posture: provider/tool errors reach the client ONLY as the fixed
 * codes PROVIDER_ERROR / STEP_LIMIT / TOOL_ERROR — raw provider payloads (urls,
 * headers, bodies, keys) never cross the boundary, and server logs carry only
 * { threadId, requestId, userId, providerKind, model, toolNames, outcome,
 * durationMs } (never prompts, args, or results). System prompt is static; tool
 * output is delivered as structured tool messages, never interpolated into
 * instructions.
 *
 * Persistence is orchestration-only here: every database decision lives in
 * lib/assistant/threads.ts (design D1). What this file owns is the turn's
 * lifecycle wiring — the two-timer abort latch, the SSE accumulator that gives a
 * blocked read something truthful to persist, and the finalize-once latch every
 * terminal path races into.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  streamText,
  convertToModelMessages,
  createIdGenerator,
  stepCountIs,
  type UIMessage,
} from "ai";
import { ZodError } from "zod";
import { requireApproved, requireCSRF, errorResponse } from "@/lib/api-utils";
import { enforceRateLimit, RateLimitError } from "@/lib/rateLimit";
import { AppError } from "@/lib/error-handling";
import { resolveSurfaceModel, PROVIDER_TIMEOUT_MS } from "@/lib/assistant/providers";
import { resolveToolContext, type ToolContext } from "@/lib/assistant/context";
import { createAiTools } from "@/lib/assistant/tool-adapters";
import { TURN_RESULT_BUDGET_BYTES } from "@/lib/assistant/tools";
import { recordAssistantRun, type RecordRun } from "@/lib/assistant/telemetry";
import { buildSystemPrompt } from "@/lib/assistant/prompt";
import {
  claimTurn,
  createAbortLatch,
  finalizeTurn,
  loadBoundedHistory,
  serializedBytes,
  HISTORY_OMISSION_ID,
  HISTORY_OMISSION_NOTE,
  MESSAGE_BUDGET_BYTES,
  type ClaimTurnResult,
} from "@/lib/assistant/threads";
import { generateThreadTitle, type TitleJob } from "@/lib/assistant/titles";
import {
  requestSchema,
  type EnvelopeC2,
  type UsageTriple,
  type ValidatedUserMessage,
} from "@/lib/assistant/thread-contracts";

// Node runtime (the tools + Prisma + encryption need it) and never cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// W3-TUNE (spec §5 T-TUNE REV-2). STEP_LIMIT 8 -> 10 (composites cut multi-call
// choreography but wider breadth needs headroom). MAX_OUTPUT_TOKENS 2048 -> 3072:
// the cap applies PER STEP, so 10x4096 would have raised worst-case generation ~2.5x;
// 10x3072 keeps it ~1.9x and the 60s provider timeout stands. Revisit after live-drive
// cost/latency data. Pinned in __tests__/integration/api/lane4-assistant.test.ts.
const STEP_LIMIT = 10;
const MAX_OUTPUT_TOKENS = 3072;
const RATE_LIMIT = { limit: 30, ttl: 60 * 60 * 1000 } as const;

/** How long the finalizer waits for `result.usage` before recording NULL tokens
 *  (spec C4 — a hung usage promise must never hold the request row open). */
const USAGE_RACE_MS = 2_000;

/** C0 controls minus \t \n \r, plus DEL: never legitimate composer input, and JSON
 *  escaping expands each one ~6x (spec C2's serialized-cap rationale). */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * The C2 post-parse asserts (house rule: cross-field rules are `assert*` helpers,
 * never `.refine` — the MCP adapter reads `.shape`).
 *
 * The cap is measured on the AGGREGATE serialized message via the same
 * `serializedBytes` the history budget uses: a raw per-part text bound does not
 * bound serialized size (four legal parts still add up), and that is precisely what
 * guarantees the current turn always fits HISTORY_BUDGET_BYTES with headroom.
 */
function assertMessageLimits(message: ValidatedUserMessage): void {
  if (serializedBytes(message) > MESSAGE_BUDGET_BYTES) {
    throw new AppError("Message is too large", "VALIDATION_ERROR", 400);
  }
  const hasControlChar =
    FORBIDDEN_CONTROL_CHARS.test(message.id) ||
    message.parts.some((part) => FORBIDDEN_CONTROL_CHARS.test(part.text));
  if (hasControlChar) {
    throw new AppError("Message contains unsupported control characters", "VALIDATION_ERROR", 400);
  }
}

/** Map a guard/parse failure to the plain-JSON response the client maps to a
 *  state (D-B7). Never opens a stream. */
function guardError(err: unknown): NextResponse {
  if (err instanceof ZodError) {
    return errorResponse(err.errors[0]?.message || "Invalid request", 400, "VALIDATION_ERROR");
  }
  if (err instanceof RateLimitError) {
    const res = NextResponse.json(
      {
        error: "Assistant is temporarily rate-limited.",
        code: "RATE_LIMITED",
        retryAt: err.headers["X-RateLimit-Reset"],
      },
      { status: 429 },
    );
    for (const [k, v] of Object.entries(err.headers)) res.headers.set(k, v);
    return res;
  }
  if (err instanceof AppError) {
    // Includes AI_UNCONFIGURED (409), CSRF_INVALID (403), UNAUTHORIZED (401),
    // FORBIDDEN (403), THREAD_BUSY (409), CONFLICT (409), NOT_FOUND (404) — each
    // already carries a safe message + code.
    return errorResponse(err.message, err.statusCode, err.code);
  }
  console.error("[assistant] guard error", err instanceof Error ? err.name : "unknown");
  return errorResponse("Internal server error", 500, "INTERNAL_ERROR");
}

/** Fixed client-facing stream-error code. Raw provider payloads never leak. */
function maskStreamError(error: unknown): string {
  if (
    error instanceof AppError &&
    (error.code === "STEP_LIMIT" || error.code === "TOOL_ERROR" || error.code === "PROVIDER_ERROR")
  ) {
    return error.code;
  }
  return "PROVIDER_ERROR";
}

type UsageSource = PromiseLike<{
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}> | null;

/**
 * `await result.usage` under a 2s race (spec C4). Token fields are passed through
 * EXACTLY as reported — `undefined` stays `undefined` so the finalizer writes NULL,
 * never 0-as-measurement (G2) — and an unresolved or rejected promise yields `null`.
 */
async function resolveUsage(source: UsageSource): Promise<UsageTriple | null> {
  if (source === null) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const usage = await Promise.race([
      source,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("usage unresolved")), USAGE_RACE_MS);
      }),
    ]);
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    };
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface StreamAccumulator {
  /** Drive the tee'd copy to completion. Never rejects — a broken accumulator must
   *  not break finalization. */
  consume(stream: ReadableStream<string>): Promise<void>;
  /** The partial message as of NOW (a copy — later chunks cannot mutate it), or
   *  `null` when nothing has been streamed yet. */
  snapshot(): UIMessage | null;
  /** TRUE once the stream's terminal `data: [DONE]` frame was observed. A consumed
   *  stream that ends WITHOUT it was truncated upstream (F-5). */
  sawTerminal(): boolean;
}

type AccumulatedPart = Record<string, unknown>;

/**
 * The route-owned ACCUMULATOR (spec C4, REV-8).
 *
 * `onEnd`'s `responseMessage` materializes only on flush/cancel, which a blocked
 * provider read never reaches — so the T2 deadline needs its own source of truth.
 * This consumer parses the tee'd UI-message stream into a partial `UIMessage`.
 *
 * Two parser states matter: the FRAME buffer (arbitrary HTTP chunks are re-cut on
 * `\n\n`, never one-chunk-one-event) and the DONE flag (`data: [DONE]` ends
 * parsing; anything after it is ignored). Malformed frames are skipped rather than
 * thrown — the accumulator is a best-effort witness, and the fence is what keeps a
 * late finalize honest.
 */
function createStreamAccumulator(fallbackId: () => string): StreamAccumulator {
  const parts: AccumulatedPart[] = [];
  const blocks = new Map<string, AccumulatedPart>();
  const toolCalls = new Map<string, AccumulatedPart>();
  let messageId = "";
  let metadata: Record<string, unknown> | undefined;
  let buffer = "";
  let done = false;

  const mergeMetadata = (incoming: unknown): void => {
    if (typeof incoming !== "object" || incoming === null) return;
    metadata = { ...(metadata ?? {}), ...(incoming as Record<string, unknown>) };
  };

  const block = (kind: "text" | "reasoning", id: string): AccumulatedPart => {
    const key = `${kind}:${id}`;
    let part = blocks.get(key);
    if (part === undefined) {
      part = { type: kind, text: "", state: "streaming" };
      blocks.set(key, part);
      parts.push(part);
    }
    return part;
  };

  const toolPart = (toolCallId: string): AccumulatedPart => {
    let part = toolCalls.get(toolCallId);
    if (part === undefined) {
      part = { type: "dynamic-tool", toolCallId, state: "input-streaming" };
      toolCalls.set(toolCallId, part);
      parts.push(part);
    }
    return part;
  };

  const nameToolPart = (part: AccumulatedPart, chunk: Record<string, unknown>): void => {
    if (typeof chunk.toolName !== "string") return;
    // Static tools ride as `tool-<name>`; dynamic ones keep `dynamic-tool` + a
    // toolName field. Both satisfy threads.ts's tool-part predicate.
    if (chunk.dynamic === true) {
      part.type = "dynamic-tool";
      part.toolName = chunk.toolName;
    } else {
      part.type = `tool-${chunk.toolName}`;
      delete part.toolName;
    }
  };

  const apply = (chunk: Record<string, unknown>): void => {
    const id = typeof chunk.id === "string" ? chunk.id : "";
    const toolCallId = typeof chunk.toolCallId === "string" ? chunk.toolCallId : "";
    switch (chunk.type) {
      case "start":
        if (typeof chunk.messageId === "string") messageId = chunk.messageId;
        mergeMetadata(chunk.messageMetadata);
        break;
      case "finish":
      case "message-metadata":
        mergeMetadata(chunk.messageMetadata);
        break;
      case "text-start":
        block("text", id);
        break;
      case "text-delta":
        if (typeof chunk.delta === "string") {
          const part = block("text", id);
          part.text = `${part.text as string}${chunk.delta}`;
        }
        break;
      case "text-end":
        block("text", id).state = "done";
        break;
      case "reasoning-start":
        block("reasoning", id);
        break;
      case "reasoning-delta":
        if (typeof chunk.delta === "string") {
          const part = block("reasoning", id);
          part.text = `${part.text as string}${chunk.delta}`;
        }
        break;
      case "reasoning-end":
        block("reasoning", id).state = "done";
        break;
      case "tool-input-start":
        nameToolPart(toolPart(toolCallId), chunk);
        break;
      case "tool-input-available": {
        const part = toolPart(toolCallId);
        nameToolPart(part, chunk);
        part.state = "input-available";
        part.input = chunk.input;
        break;
      }
      case "tool-input-error": {
        const part = toolPart(toolCallId);
        nameToolPart(part, chunk);
        part.state = "output-error";
        part.input = chunk.input;
        part.errorText = chunk.errorText;
        break;
      }
      case "tool-output-available": {
        const part = toolPart(toolCallId);
        part.state = "output-available";
        part.output = chunk.output;
        break;
      }
      case "tool-output-error": {
        const part = toolPart(toolCallId);
        part.state = "output-error";
        part.errorText = chunk.errorText;
        break;
      }
      case "tool-output-denied":
        toolPart(toolCallId).state = "output-denied";
        break;
      default:
        // step-start/finish-step/abort/error/source/file/data-* carry nothing the
        // persisted partial needs (the error code is latched by onError).
        break;
    }
  };

  const handleFrame = (frame: string): void => {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue; // SSE comments / other fields
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        done = true;
        return;
      }
      try {
        const chunk: unknown = JSON.parse(payload);
        if (typeof chunk === "object" && chunk !== null) apply(chunk as Record<string, unknown>);
      } catch {
        // A frame we cannot parse is a frame we do not persist.
      }
    }
  };

  const feed = (text: string): void => {
    buffer += text;
    for (;;) {
      const cut = buffer.indexOf("\n\n");
      if (cut === -1) break;
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      handleFrame(frame);
      if (done) {
        buffer = "";
        return;
      }
    }
  };

  return {
    async consume(stream: ReadableStream<string>): Promise<void> {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done: finished, value } = await reader.read();
          if (finished) break;
          if (typeof value === "string" && !done) feed(value);
        }
      } catch {
        // A cancelled or errored tee is not a finalization failure.
      } finally {
        reader.releaseLock();
      }
    },
    sawTerminal(): boolean {
      return done;
    },
    snapshot(): UIMessage | null {
      if (parts.length === 0) return null;
      const message: UIMessage = {
        id: messageId === "" ? fallbackId() : messageId,
        role: "assistant",
        parts: parts.map((part) => ({ ...part })) as UIMessage["parts"],
      };
      if (metadata !== undefined) message.metadata = { ...metadata };
      return message;
    },
  };
}

/**
 * GET /api/assistant — the page-load readiness probe (U1). Lets the surface fork
 * the unconfigured panel BEFORE the first submit instead of only reactively on a
 * 409. requireApproved gates it (same auth posture as POST); resolveSurfaceModel
 * decides `configured`. AI_UNCONFIGURED is the ONLY non-error "unconfigured"
 * signal — any other resolution failure surfaces as a guard error so the client
 * falls back to the reactive 409 fork. Never cached (per-session, per-config).
 */
export async function GET(): Promise<Response> {
  try {
    await requireApproved();
    let configured = true;
    try {
      await resolveSurfaceModel("assistant");
    } catch (err) {
      if (err instanceof AppError && err.code === "AI_UNCONFIGURED") {
        configured = false;
      } else {
        throw err;
      }
    }
    return NextResponse.json(
      { configured },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return guardError(err);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  // --- Guards (BEFORE any model/stream work; fail as plain JSON) ---
  let userId: number;
  let isAdmin: boolean;
  try {
    const { user } = await requireApproved();
    userId = user.id;
    isAdmin = user.isAdmin;
    await requireCSRF(request);
    enforceRateLimit(request, "assistant:message", {
      identifier: user.id,
      limit: RATE_LIMIT.limit,
      ttl: RATE_LIMIT.ttl,
    });
  } catch (err) {
    return guardError(err);
  }

  // --- Request body (the C2 envelope + its post-parse asserts) ---
  let body: EnvelopeC2;
  try {
    body = requestSchema.parse(await request.json());
    assertMessageLimits(body.message);
  } catch (err) {
    return guardError(err);
  }

  // --- Provider resolution (unconfigured -> 409 AI_UNCONFIGURED JSON) ---
  let resolved: Awaited<ReturnType<typeof resolveSurfaceModel>>;
  try {
    resolved = await resolveSurfaceModel("assistant");
  } catch (err) {
    return guardError(err);
  }

  // --- Tool context + the claim transaction (C2 step 2) ---
  // The claim is the last thing that can fail as plain JSON: THREAD_BUSY (409),
  // CONFLICT (409) and NOT_FOUND (404) all reach the client before a stream opens.
  // Everything after this point owes the request row a finalize.
  let ctx: ToolContext;
  let claim: ClaimTurnResult;
  try {
    ctx = await resolveToolContext({ id: userId, isAdmin }, "assistant");
    claim = await claimTurn({
      userId,
      threadId: body.threadId,
      message: body.message,
      trigger: body.trigger,
      membershipScope: ctx.companyIds,
      providerKind: resolved.kind,
      model: resolved.model,
    });
  } catch (err) {
    return guardError(err);
  }

  // --- Telemetry wrapper (injects resolved kind/model + the claim's requestId) ---
  const budget = { remaining: TURN_RESULT_BUDGET_BYTES };
  const toolNames = new Set<string>();
  const wrappedRecordRun: RecordRun = (row) => {
    toolNames.add(row.toolName);
    return recordAssistantRun({
      ...row,
      providerKind: resolved.kind,
      model: resolved.model,
      requestId: claim.requestId,
    });
  };

  const startedAt = Date.now();
  const logRun = (outcome: "ok" | "error"): void => {
    // Redacted route-level log ONLY — no prompts, args, or results.
    console.info("[assistant] run", {
      threadId: claim.threadId,
      requestId: claim.requestId,
      userId,
      providerKind: resolved.kind,
      model: resolved.model,
      toolNames: Array.from(toolNames),
      outcome,
      durationMs: Date.now() - startedAt,
    });
  };

  // --- Turn lifecycle: latch + accumulator + the finalize-once gate (C4) ---
  const generateMessageId = createIdGenerator({ prefix: "am", size: 24 });
  const latch = createAbortLatch(request.signal);
  const accumulator = createStreamAccumulator(generateMessageId);
  let usageSource: UsageSource = null;
  let errorLatched: string | null = null;
  let consumerSettled: Promise<void> = Promise.resolve();
  let consumeStarted = false;
  let finalizing: Promise<void> | null = null;

  const titleJob = (): TitleJob =>
    claim.threadWasCreated
      ? {
          mode: "creating-model",
          userId,
          threadId: claim.threadId,
          firstUserText: body.message.parts.map((part) => part.text).join("\n"),
          membershipScope: ctx.companyIds,
        }
      : { mode: "later-fallback", userId, threadId: claim.threadId };

  /**
   * ONE in-process latch for every terminal path — `onEnd`, `onError` (after the
   * accumulator consumer settles), the T2 deadline and the setup-failure path all
   * race here and the FIRST one wins. The database fence in `finalizeTurn` is the
   * second half of the guarantee (a superseded request writes nothing at all).
   */
  const finalizeOnce = (message: UIMessage | null, eventAborted: boolean): Promise<void> => {
    if (finalizing !== null) return finalizing;
    finalizing = (async () => {
      try {
        const durationMs = Date.now() - startedAt;
        const outcome = await finalizeTurn({
          requestId: claim.requestId,
          threadId: claim.threadId,
          message,
          cause: latch.cause(),
          eventAborted,
          // F-5 (launch-gate finding): a CONSUMED stream that never reached its
          // terminal [DONE] frame was truncated upstream — recording it `ok` would
          // make a cut-off answer indistinguishable from a complete one. Evidence-
          // based: no consumption (mocked SDK paths) = no downgrade.
          errorLatched:
            errorLatched ??
            (consumeStarted && !accumulator.sawTerminal() ? "PROVIDER_ERROR" : null),
          usage: await resolveUsage(usageSource),
          durationMs,
        });
        // Detached, and ONLY behind the fence: a superseded or failed turn must not
        // spend a title call (W1's titles.ts is the stub — 2.3 fills it).
        if (outcome.finalized && outcome.status === "ok") void generateThreadTitle(titleJob());
      } catch (err) {
        console.error("[assistant] finalize failed", err instanceof Error ? err.name : "unknown");
      } finally {
        latch.clearTimers();
      }
    })();
    return finalizing;
  };

  // T1 (60s) latches "provider-timeout" and aborts inside the latch itself; T2
  // (75s) is ours: finalize with the accumulator's frozen snapshot and abandon the
  // blocked read, whose late finalize no-ops on the fence.
  latch.armTimers(() => {
    void finalizeOnce(accumulator.snapshot(), false);
  });

  try {
    // C2 step 3: the bounded history is BOTH the model input (converted) and the
    // client's `originalMessages` (persistence mode, C3).
    const loadedHistory = await loadBoundedHistory(userId, claim.threadId);
    // F-4 (launch-gate finding): ai@7.0.29 REJECTS system-role messages in `messages`
    // ("Use the instructions option instead") — the omission note rides the SYSTEM
    // option below and is stripped here; it is never converted, never a persistence-
    // mode original (it was never persisted either).
    const historyOmitted =
      loadedHistory.length > 0 && loadedHistory[0].id === HISTORY_OMISSION_ID;
    const originalMessages = historyOmitted ? loadedHistory.slice(1) : loadedHistory;
    const messages = await convertToModelMessages(originalMessages, {
      ignoreIncompleteToolCalls: true,
    });

    // --- Stream ---
    const result = streamText({
      model: resolved.languageModel,
      // Server-controlled context: today's UTC date (D-T6). `new Date()` is trusted
      // server state, never tool or user data — the injection posture is preserved.
      system: historyOmitted
        ? `${buildSystemPrompt(new Date())}\n\n${HISTORY_OMISSION_NOTE}`
        : buildSystemPrompt(new Date()),
      messages,
      tools: createAiTools(ctx, budget, wrappedRecordRun),
      stopWhen: stepCountIs(STEP_LIMIT),
      // The LATCH's signal, never request.signal directly: a client disconnect and a
      // provider timeout must stay distinguishable after the fact (C4).
      abortSignal: latch.signal,
      // Retained alongside the route-owned timers: it still cuts a stream that
      // YIELDS between reads. T1/T2 are the observable truth.
      timeout: PROVIDER_TIMEOUT_MS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      onFinish: () => logRun("ok"),
      // Suppress the SDK's default raw-error console logging; the client-facing
      // mask + the redacted log happen in the UI-stream onError below.
      onError: () => {},
    });
    usageSource = result.usage;
    // The finalizer re-awaits this under its own try/catch, but it does so LATE (it
    // waits for the accumulator on the error path). Mark the promise handled now so
    // a provider failure cannot surface as an unhandled rejection in between.
    void Promise.resolve(result.usage).catch(() => undefined);

    return result.toUIMessageStreamResponse({
      originalMessages,
      generateMessageId,
      // C3: the client reads its thread id off the FIRST metadata it sees, and the
      // finish reason still rides home so a step-cap is distinguishable from a
      // natural completion (D-B4). The finalizer re-reads finishReason from the
      // persisted message's own metadata, so "finish" must keep carrying it.
      messageMetadata: ({ part }) => {
        if (part.type === "start") return { threadId: claim.threadId };
        if (part.type === "finish") {
          return { finishReason: part.finishReason, threadId: claim.threadId };
        }
        return undefined;
      },
      onError: (error) => {
        const code = maskStreamError(error);
        if (errorLatched === null) errorLatched = code;
        logRun("error");
        // The SDK can fire onError twice for one failure; finalization also waits
        // for the accumulator so a failed-after-content turn persists what the user
        // actually saw.
        void consumerSettled.then(() => finalizeOnce(accumulator.snapshot(), false));
        return code;
      },
      onEnd: ({ responseMessage, isAborted }) => {
        void consumerSettled.then(() =>
          finalizeOnce(responseMessage ?? accumulator.snapshot(), isAborted === true),
        );
      },
      // Mandatory server-side consumption (C4): the tee'd copy is driven to
      // completion regardless of client disconnect, and the route captures the
      // completion promise ITSELF — the SDK discards the callback's return value.
      consumeSseStream: ({ stream }) => {
        consumeStarted = true;
        consumerSettled = accumulator.consume(stream);
      },
    });
  } catch (err) {
    // C2 step 4: a failure after the claim and before streaming must never leave a
    // phantom `running` row.
    errorLatched = maskStreamError(err);
    logRun("error");
    await finalizeOnce(null, false);
    return guardError(err);
  }
}
