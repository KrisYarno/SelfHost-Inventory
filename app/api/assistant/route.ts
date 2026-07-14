/**
 * app/api/assistant/route.ts — the streaming in-app assistant (spec D5, D13).
 *
 * Guards run and FAIL AS PLAIN JSON before the stream opens (no partial stream
 * on a rejected request): requireApproved -> requireCSRF -> enforceRateLimit ->
 * provider resolution. Only then does `streamText` open, with the curated read
 * tools bound to the caller's ToolContext and a per-turn byte budget.
 *
 * Security posture: provider/tool errors reach the client ONLY as the fixed
 * codes PROVIDER_ERROR / STEP_LIMIT / TOOL_ERROR — raw provider payloads (urls,
 * headers, bodies, keys) never cross the boundary, and server logs carry only
 * { conversationId, userId, providerKind, model, toolNames, outcome, durationMs }
 * (never prompts, args, or results). System prompt is static; tool output is
 * delivered as structured tool messages, never interpolated into instructions.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
} from "ai";
import { z, ZodError } from "zod";
import { requireApproved, requireCSRF, errorResponse } from "@/lib/api-utils";
import { enforceRateLimit, RateLimitError } from "@/lib/rateLimit";
import { AppError } from "@/lib/error-handling";
import { resolveSurfaceModel, PROVIDER_TIMEOUT_MS } from "@/lib/assistant/providers";
import { resolveToolContext } from "@/lib/assistant/context";
import { createAiTools } from "@/lib/assistant/tool-adapters";
import { TURN_RESULT_BUDGET_BYTES } from "@/lib/assistant/tools";
import { recordAssistantRun, type RecordRun } from "@/lib/assistant/telemetry";
import { buildSystemPrompt } from "@/lib/assistant/prompt";

// Node runtime (the tools + Prisma + encryption need it) and never cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STEP_LIMIT = 8;
const MAX_OUTPUT_TOKENS = 2048;
const RATE_LIMIT = { limit: 30, ttl: 60 * 60 * 1000 } as const;

/**
 * In-lane request schema (lib/validation/ai.ts stays untouched — codex #7). The
 * `messages` are UI messages the SDK converts; only `conversationId` carries a
 * hard shape (envelope metadata only, D9).
 */
const requestSchema = z.object({
  conversationId: z.string().uuid(),
  messages: z.array(z.unknown()),
});

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
    // FORBIDDEN (403) — each already carries a safe message + code.
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

  // --- Request body ---
  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await request.json());
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

  // --- Tool context + telemetry wrapper (injects resolved kind/model) ---
  const ctx = await resolveToolContext({ id: userId, isAdmin }, "assistant");
  const budget = { remaining: TURN_RESULT_BUDGET_BYTES };
  const toolNames = new Set<string>();
  const wrappedRecordRun: RecordRun = (row) => {
    toolNames.add(row.toolName);
    return recordAssistantRun({ ...row, providerKind: resolved.kind, model: resolved.model });
  };

  const startedAt = Date.now();
  const logRun = (outcome: "ok" | "error"): void => {
    // Redacted route-level log ONLY — no prompts, args, or results.
    console.info("[assistant] run", {
      conversationId: body.conversationId,
      userId,
      providerKind: resolved.kind,
      model: resolved.model,
      toolNames: Array.from(toolNames),
      outcome,
      durationMs: Date.now() - startedAt,
    });
  };

  // --- Stream ---
  const result = streamText({
    model: resolved.languageModel,
    system: buildSystemPrompt(),
    messages: await convertToModelMessages(body.messages as UIMessage[]),
    tools: createAiTools(ctx, budget, wrappedRecordRun),
    stopWhen: stepCountIs(STEP_LIMIT),
    abortSignal: request.signal,
    timeout: PROVIDER_TIMEOUT_MS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    onFinish: () => logRun("ok"),
    // Suppress the SDK's default raw-error console logging; the client-facing
    // mask + the redacted log happen in the UI-stream onError below.
    onError: () => {},
  });

  return result.toUIMessageStreamResponse({
    // The finish reason rides as message metadata so the client can distinguish
    // a natural completion from a step-cap (D-B4) without any raw payload.
    messageMetadata: ({ part }) =>
      part.type === "finish" ? { finishReason: part.finishReason } : undefined,
    onError: (error) => {
      logRun("error");
      return maskStreamError(error);
    },
  });
}
