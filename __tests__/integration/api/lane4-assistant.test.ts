// @jest-environment node
//
// Lane 4 (W2-A) — the streaming assistant route.
//
// ENV NOTE (SEAM): the `ai` SDK + its @ai-sdk/* chain ship ESM-only and next/jest
// only transforms `transpilePackages`; the deep transitive ESM chain makes the
// spec §5 "real streamText + MockLanguageModelV4" harness un-loadable under this
// jest setup (verified: even a broad transpilePackages list fails on a nested
// @ai-sdk/provider-utils import). So `ai` is mocked here and the route's OWN
// contract is asserted at the orchestration boundary: guard ORDER (no model call
// before a guard passes), the pinned streamText args (stopWhen/abortSignal/
// timeout/maxOutputTokens/system), error MASKING (no raw provider payload), the
// telemetry wrapper's kind/model injection, and the finish-reason metadata. Real
// end-to-end streaming is covered by the T6 live drive.

// --- ai seam: capture streamText + toUIMessageStreamResponse options --------
const streamTextSpy: jest.Mock = jest.fn();
const toUIResponseSpy: jest.Mock = jest.fn(
  () =>
    new Response("STREAM_BODY", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
);
jest.mock("ai", () => ({
  __esModule: true,
  streamText: (opts: unknown) => {
    streamTextSpy(opts);
    return { toUIMessageStreamResponse: (o: unknown) => toUIResponseSpy(o) };
  },
  convertToModelMessages: jest.fn(async (m: unknown) => m),
  stepCountIs: (n: number) => ({ __stepCountIs: n }),
}));

// --- provider seam ---------------------------------------------------------
jest.mock("@/lib/assistant/providers", () => ({
  __esModule: true,
  PROVIDER_TIMEOUT_MS: 60_000,
  resolveSurfaceModel: jest.fn(),
}));

// --- guards ----------------------------------------------------------------
jest.mock("@/lib/api-utils", () => ({
  ...jest.requireActual("@/lib/api-utils"),
  requireApproved: jest.fn(),
}));
jest.mock("@/lib/csrf", () => ({ validateCSRFToken: jest.fn(() => Promise.resolve(true)) }));
jest.mock("@/lib/rateLimit", () => ({
  ...jest.requireActual("@/lib/rateLimit"),
  enforceRateLimit: jest.fn(),
}));

// --- context / tools / telemetry (no prisma) -------------------------------
jest.mock("@/lib/assistant/context", () => ({
  resolveToolContext: jest.fn(() =>
    Promise.resolve({ userId: 1, isAdmin: false, companyIds: [], surface: "assistant" }),
  ),
}));
const createAiToolsSpy: jest.Mock = jest.fn(() => ({ find_product: {} }));
jest.mock("@/lib/assistant/tool-adapters", () => ({
  createAiTools: (...a: unknown[]) => createAiToolsSpy(...a),
}));
jest.mock("@/lib/assistant/tools", () => ({ TURN_RESULT_BUDGET_BYTES: 131_072 }));
const recordRunSpy: jest.Mock = jest.fn(() => Promise.resolve());
jest.mock("@/lib/assistant/telemetry", () => ({ recordAssistantRun: (...a: unknown[]) => recordRunSpy(...a) }));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/assistant/route";
import { buildSystemPrompt } from "@/lib/assistant/prompt";
import { AppError } from "@/lib/error-handling";
import { RateLimitError } from "@/lib/rateLimit";
import { resolveSurfaceModel } from "@/lib/assistant/providers";
import { requireApproved } from "@/lib/api-utils";
import { validateCSRFToken } from "@/lib/csrf";
import { enforceRateLimit } from "@/lib/rateLimit";

const resolveMock = resolveSurfaceModel as jest.Mock;
const approvedMock = requireApproved as jest.Mock;
const csrfMock = validateCSRFToken as jest.Mock;
const rateMock = enforceRateLimit as jest.Mock;

const UUID = "11111111-1111-4111-8111-111111111111";
const MODEL = { languageModel: { __model: true }, kind: "ANTHROPIC" as const, model: "claude-x" };

function req(body: unknown): NextRequest {
  return new NextRequest("http://x/api/assistant", {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": "t" },
    body: JSON.stringify(body),
  });
}

const validBody = {
  conversationId: UUID,
  messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
};

beforeEach(() => {
  jest.clearAllMocks();
  approvedMock.mockResolvedValue({ user: { id: 7, isAdmin: false } });
  csrfMock.mockResolvedValue(true);
  rateMock.mockReturnValue({});
  resolveMock.mockResolvedValue(MODEL);
  createAiToolsSpy.mockReturnValue({ find_product: {} });
});

// ---------------------------------------------------------------------------
// Guard order — no model call before every guard passes
// ---------------------------------------------------------------------------

describe("guards fail as JSON before the model runs", () => {
  test("unapproved => 403, no streamText, no provider resolution", async () => {
    approvedMock.mockRejectedValue(new AppError("Account pending approval", "FORBIDDEN", 403));
    const res = await POST(req(validBody));
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(streamTextSpy).not.toHaveBeenCalled();
    expect(resolveMock).not.toHaveBeenCalled();
  });

  test("invalid CSRF => 403 CSRF_INVALID, no streamText", async () => {
    csrfMock.mockResolvedValue(false);
    const res = await POST(req(validBody));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("CSRF_INVALID");
    expect(streamTextSpy).not.toHaveBeenCalled();
  });

  test("rate-limited => 429 + Retry-After, no streamText", async () => {
    rateMock.mockImplementation(() => {
      throw new RateLimitError(30, 0, Date.now() + 1000);
    });
    const res = await POST(req(validBody));
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("RATE_LIMITED");
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(streamTextSpy).not.toHaveBeenCalled();
  });

  test("missing conversationId => 400, no provider resolution", async () => {
    const res = await POST(req({ messages: [] }));
    expect(res.status).toBe(400);
    expect(resolveMock).not.toHaveBeenCalled();
    expect(streamTextSpy).not.toHaveBeenCalled();
  });

  test("non-uuid conversationId => 400", async () => {
    const res = await POST(req({ conversationId: "nope", messages: [] }));
    expect(res.status).toBe(400);
  });

  test("provider unconfigured => 409 AI_UNCONFIGURED, no streamText", async () => {
    resolveMock.mockRejectedValue(new AppError("Assistant is not configured", "AI_UNCONFIGURED", 409));
    const res = await POST(req(validBody));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("AI_UNCONFIGURED");
    expect(streamTextSpy).not.toHaveBeenCalled();
  });

  test("guards run in the pinned order: approved -> csrf -> rate", async () => {
    const calls: string[] = [];
    approvedMock.mockImplementation(async () => {
      calls.push("approved");
      return { user: { id: 7, isAdmin: false } };
    });
    csrfMock.mockImplementation(async () => {
      calls.push("csrf");
      return true;
    });
    rateMock.mockImplementation(() => {
      calls.push("rate");
      return {};
    });
    await POST(req(validBody));
    expect(calls).toEqual(["approved", "csrf", "rate"]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/assistant — the U1 readiness probe
// ---------------------------------------------------------------------------

describe("GET readiness probe (U1)", () => {
  test("configured:true when the surface model resolves; never cached", async () => {
    resolveMock.mockResolvedValue(MODEL);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ configured: true });
  });

  test("configured:false on AI_UNCONFIGURED — a 200, never an error status", async () => {
    resolveMock.mockRejectedValue(new AppError("Assistant is not configured", "AI_UNCONFIGURED", 409));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ configured: false });
  });

  test("unapproved => guard error (403), no provider resolution, no configured payload", async () => {
    approvedMock.mockRejectedValue(new AppError("Account pending approval", "FORBIDDEN", 403));
    const res = await GET();
    expect(res.status).toBe(403);
    expect((await res.json()).configured).toBeUndefined();
    expect(resolveMock).not.toHaveBeenCalled();
  });

  test("an unexpected resolution failure surfaces as a guard error (client keeps the reactive fork)", async () => {
    resolveMock.mockRejectedValue(new Error("db down"));
    const res = await GET();
    expect(res.status).toBe(500);
    expect((await res.json()).configured).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Happy path — pinned streamText args
// ---------------------------------------------------------------------------

describe("streamText wiring", () => {
  test("200 event-stream; pinned generation args", async () => {
    const res = await POST(req(validBody));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    expect(streamTextSpy).toHaveBeenCalledTimes(1);
    const opts = streamTextSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.model).toBe(MODEL.languageModel);
    // D-T6: the system prompt now carries today's UTC date (server-controlled). It
    // is built from `new Date()` at request time, so assert its shape, not equality
    // with a fresh call at a different instant.
    expect(typeof opts.system).toBe("string");
    expect(opts.system).toBe(buildSystemPrompt(new Date()));
    expect(opts.system as string).toContain("Today is");
    expect(opts.stopWhen).toEqual({ __stepCountIs: 10 }); // stepCountIs(STEP_LIMIT), W3-TUNE
    expect(opts.timeout).toBe(60_000);
    expect(opts.maxOutputTokens).toBe(3072); // W3-TUNE (spec §5 T-TUNE REV-2)
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal); // request.signal (codex F18)
    expect(opts.tools).toEqual({ find_product: {} });
    expect(typeof opts.onFinish).toBe("function");
  });

  // W3-TUNE (spec §5 T-TUNE REV-2) — PINNED cost math: the per-step MAX_OUTPUT_TOKENS
  // cap applies PER STEP, so 10 steps x 4096 would have raised worst-case generation
  // ~2.5x; 10 x 3072 keeps it ~1.9x and the 60s provider timeout still stands. STEP_LIMIT
  // 8 -> 10 and MAX_OUTPUT_TOKENS 2048 -> 3072 are pinned here; changing either must
  // re-derive that cost math (and revisit after live-drive latency/cost data).
  test("STEP_LIMIT is 10 and MAX_OUTPUT_TOKENS is 3072 (pinned cost math)", async () => {
    await POST(req(validBody));
    const opts = streamTextSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.stopWhen).toEqual({ __stepCountIs: 10 });
    expect(opts.maxOutputTokens).toBe(3072);
  });

  test("createAiTools bound to the resolved ctx + a byte budget + telemetry wrapper", async () => {
    await POST(req(validBody));
    expect(createAiToolsSpy).toHaveBeenCalledTimes(1);
    const [ctx, budget, onRun] = createAiToolsSpy.mock.calls[0] as [
      Record<string, unknown>,
      { remaining: number },
      (row: Record<string, unknown>) => unknown,
    ];
    expect(ctx.surface).toBe("assistant");
    expect(budget.remaining).toBe(131_072);

    // The telemetry wrapper injects resolved kind/model into each row.
    onRun({ userId: 7, surface: "assistant", toolName: "find_product", outcome: "ok", durationMs: 1, resultBytes: 5 });
    expect(recordRunSpy).toHaveBeenCalledWith(
      expect.objectContaining({ providerKind: "ANTHROPIC", model: "claude-x", toolName: "find_product" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Error masking + finish metadata (via captured toUIMessageStreamResponse opts)
// ---------------------------------------------------------------------------

describe("response stream options", () => {
  test("onError masks any provider error to a fixed code, never the raw payload", async () => {
    await POST(req(validBody));
    const o = toUIResponseSpy.mock.calls[0][0] as { onError: (e: unknown) => string };
    const masked = o.onError(new Error("sk-live-SECRET-should-never-leak"));
    expect(masked).toBe("PROVIDER_ERROR");
    expect(masked).not.toContain("SECRET");
  });

  test("messageMetadata maps a finish part to { finishReason } (client step-cap signal)", async () => {
    await POST(req(validBody));
    const o = toUIResponseSpy.mock.calls[0][0] as {
      messageMetadata: (a: { part: { type: string; finishReason?: string } }) => unknown;
    };
    expect(o.messageMetadata({ part: { type: "finish", finishReason: "tool-calls" } })).toEqual({
      finishReason: "tool-calls",
    });
    expect(o.messageMetadata({ part: { type: "start" } })).toBeUndefined();
  });
});
