// @jest-environment node
//
// Lane 4 (W2-A) — the streaming assistant route, cut over to the multiuser
// substrate envelope (task 1.2; spec C2/C3/C4, contract pack T4).
//
// ENV NOTE (SEAM): the `ai` SDK + its @ai-sdk/* chain ship ESM-only and next/jest
// only transforms `transpilePackages`; the deep transitive ESM chain makes the
// spec §5 "real streamText + MockLanguageModelV4" harness un-loadable under this
// jest setup (verified: even a broad transpilePackages list fails on a nested
// @ai-sdk/provider-utils import). So `ai` is mocked here and the route's OWN
// contract is asserted at the orchestration boundary: guard ORDER (no model call
// before a guard passes), the C2 envelope + post-parse asserts, the claim ->
// history -> stream flow, the pinned streamText args (stopWhen/abortSignal/
// timeout/maxOutputTokens/system), error MASKING (no raw provider payload), the
// telemetry wrapper's kind/model/requestId injection, the C3 metadata, and the
// C4 accumulator + finalize-once latch driven through the captured
// toUIMessageStreamResponse options. Real end-to-end streaming is covered by the
// launch gate (row 4) and the T6 live drive.
//
// The `ai` mock surface OWNED here (contract pack T12 shared-file rule): it gains
// `createIdGenerator` (C3's server-stable assistant ids) and the streamText result
// gains `usage` (C4's 2s usage race).

// --- ai seam: capture streamText + toUIMessageStreamResponse options --------
const streamTextSpy: jest.Mock = jest.fn();
const toUIResponseSpy: jest.Mock = jest.fn(
  () =>
    new Response("STREAM_BODY", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
);
/** Mutable so a test can hand streamText a usage promise that never settles. */
const mockUsage: { promise: PromiseLike<unknown> } = {
  promise: Promise.resolve({ inputTokens: 11, outputTokens: 22, totalTokens: 33 }),
};
jest.mock("ai", () => {
  // A1 pack C12 (FR4): the SDK error classes the route's onError tells apart. The real
  // `ai` cannot load here (ENV NOTE above), so these MIRROR ai@7.0.29 everywhere the
  // route can look: the constructor arguments (dist/index.d.ts:3150-3174), the names,
  // and `isInstance` = @ai-sdk/provider's AISDKError.hasMarker over the same
  // Symbol.for registry markers (ai dist/index.js:146-166, :371-392; provider
  // dist/index.js:2-36, :38-72). Checked against the installed SDK: the REAL
  // `isInstance` accepts these instances and these accept the real ones.
  const hasMarker = (error: unknown, marker: string): boolean => {
    const symbol = Symbol.for(marker);
    return (
      error != null &&
      typeof error === "object" &&
      symbol in error &&
      (error as Record<symbol, unknown>)[symbol] === true
    );
  };
  const mark = (error: object, marker: string): void => {
    (error as Record<symbol, boolean>)[Symbol.for(marker)] = true;
  };
  class AISDKError extends Error {
    constructor({ name, message, cause }: { name: string; message: string; cause?: unknown }) {
      super(message);
      mark(this, "vercel.ai.error");
      this.name = name;
      this.cause = cause;
    }
    static isInstance(error: unknown): boolean {
      return hasMarker(error, "vercel.ai.error");
    }
  }
  class InvalidToolInputError extends AISDKError {
    readonly toolInput: string;
    readonly toolName: string;
    constructor({
      toolInput,
      toolName,
      cause,
      message = `Invalid input for tool ${toolName}: ${String(cause)}`,
    }: {
      message?: string;
      toolInput: string;
      toolName: string;
      cause: unknown;
    }) {
      super({ name: "AI_InvalidToolInputError", message, cause });
      mark(this, "vercel.ai.error.AI_InvalidToolInputError");
      this.toolInput = toolInput;
      this.toolName = toolName;
    }
    static isInstance(error: unknown): boolean {
      return hasMarker(error, "vercel.ai.error.AI_InvalidToolInputError");
    }
  }
  class NoSuchToolError extends AISDKError {
    readonly toolName: string;
    readonly availableTools: string[] | undefined;
    constructor({
      toolName,
      availableTools = undefined,
      message = `Model tried to call unavailable tool '${toolName}'. ${
        availableTools === undefined ? "No tools are available." : `Available tools: ${availableTools.join(", ")}.`
      }`,
    }: {
      toolName: string;
      availableTools?: string[] | undefined;
      message?: string;
    }) {
      super({ name: "AI_NoSuchToolError", message });
      mark(this, "vercel.ai.error.AI_NoSuchToolError");
      this.toolName = toolName;
      this.availableTools = availableTools;
    }
    static isInstance(error: unknown): boolean {
      return hasMarker(error, "vercel.ai.error.AI_NoSuchToolError");
    }
  }
  /** The provider-shaped control: what a failed provider HTTP call throws. */
  class APICallError extends AISDKError {
    readonly statusCode?: number;
    readonly responseBody?: string;
    constructor({
      message,
      statusCode,
      responseBody,
      cause,
    }: {
      message: string;
      url: string;
      requestBodyValues: unknown;
      statusCode?: number;
      responseBody?: string;
      cause?: unknown;
    }) {
      super({ name: "AI_APICallError", message, cause });
      mark(this, "vercel.ai.error.AI_APICallError");
      this.statusCode = statusCode;
      this.responseBody = responseBody;
    }
    static isInstance(error: unknown): boolean {
      return hasMarker(error, "vercel.ai.error.AI_APICallError");
    }
  }
  return {
    __esModule: true,
    streamText: (opts: unknown) => {
      streamTextSpy(opts);
      return {
        usage: mockUsage.promise,
        toUIMessageStreamResponse: (o: unknown) => toUIResponseSpy(o),
      };
    },
    convertToModelMessages: jest.fn(async (m: unknown, o: unknown) => ({ __converted: m, __opts: o })),
    stepCountIs: (n: number) => ({ __stepCountIs: n }),
    createIdGenerator: jest.fn((o: { prefix: string; size: number }) => {
      let seq = 0;
      return () => `${o.prefix}_${o.size}_${(seq += 1)}`;
    }),
    AISDKError,
    InvalidToolInputError,
    NoSuchToolError,
    APICallError,
  };
});

// --- provider seam ---------------------------------------------------------
// A1 pack C5: no PROVIDER_TIMEOUT_MS key — timing.ts is its one owner, and the route's
// `timeout` pin below reads the REAL timing value.
jest.mock("@/lib/assistant/providers", () => ({
  __esModule: true,
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
    Promise.resolve({ userId: 1, isAdmin: false, companyIds: ["c-a"], surface: "assistant" }),
  ),
}));
const createAiToolsSpy: jest.Mock = jest.fn(() => ({ find_product: {} }));
jest.mock("@/lib/assistant/tool-adapters", () => ({
  createAiTools: (...a: unknown[]) => createAiToolsSpy(...a),
}));
jest.mock("@/lib/assistant/tools", () => ({ TURN_RESULT_BUDGET_BYTES: 131_072 }));
const recordRunSpy: jest.Mock = jest.fn(() => Promise.resolve());
jest.mock("@/lib/assistant/telemetry", () => ({ recordAssistantRun: (...a: unknown[]) => recordRunSpy(...a) }));

// --- persistence seam: the three DB entry points only ----------------------
// `createAbortLatch`, `serializedBytes` and the byte constants stay REAL — the
// route's two-timer wiring is part of what is under test here.
const mockThreadOps = {
  claimTurn: jest.fn(),
  loadBoundedHistory: jest.fn(),
  finalizeTurn: jest.fn(),
};
jest.mock("@/lib/assistant/threads", () => {
  const actual = jest.requireActual("@/lib/assistant/threads");
  return {
    __esModule: true,
    ...actual,
    claimTurn: (...a: unknown[]) => mockThreadOps.claimTurn(...a),
    loadBoundedHistory: (...a: unknown[]) => mockThreadOps.loadBoundedHistory(...a),
    finalizeTurn: (...a: unknown[]) => mockThreadOps.finalizeTurn(...a),
  };
});

// --- title stub seam (T6; 2.3 fills the module) ----------------------------
const mockTitles = {
  generateThreadTitle: jest.fn((...a: unknown[]) => {
    void a;
    return Promise.resolve();
  }),
};
jest.mock("@/lib/assistant/titles", () => ({
  __esModule: true,
  generateThreadTitle: (...a: unknown[]) => mockTitles.generateThreadTitle(...a),
}));

import { NextRequest } from "next/server";
// The mocked module's mirrors (above), typed — and so constructed — by the REAL d.ts.
import { APICallError, InvalidToolInputError, NoSuchToolError } from "ai";
import { GET, POST } from "@/app/api/assistant/route";
import { buildSystemPrompt } from "@/lib/assistant/prompt";
import { AppError } from "@/lib/error-handling";
import { RateLimitError } from "@/lib/rateLimit";
import { resolveSurfaceModel } from "@/lib/assistant/providers";
import { requireApproved } from "@/lib/api-utils";
import { validateCSRFToken } from "@/lib/csrf";
import { enforceRateLimit } from "@/lib/rateLimit";
import { FINALIZE_DEADLINE_MS, PROVIDER_TIMEOUT_MS } from "@/lib/assistant/timing";
import {
  HISTORY_OMISSION_ID,
  HISTORY_OMISSION_NOTE,
  MESSAGE_BUDGET_BYTES,
} from "@/lib/assistant/threads";

const resolveMock = resolveSurfaceModel as jest.Mock;
const approvedMock = requireApproved as jest.Mock;
const csrfMock = validateCSRFToken as jest.Mock;
const rateMock = enforceRateLimit as jest.Mock;

const THREAD_ID = "cthread0000000000000001";
const MODEL = { languageModel: { __model: true }, kind: "ANTHROPIC" as const, model: "claude-x" };
const CLAIM = {
  threadId: THREAD_ID,
  requestId: 4242,
  threadWasCreated: false,
  supersededMessageIds: [],
};
const HISTORY = [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }];

function req(body: unknown): NextRequest {
  return new NextRequest("http://x/api/assistant", {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": "t" },
    body: JSON.stringify(body),
  });
}

/** The C2 envelope. The OLD one ({ conversationId, messages }) is deleted, not
 *  deprecated — its 400 is pinned below. */
const validBody = {
  threadId: THREAD_ID,
  message: { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
  trigger: "submit-message",
};

/** One SSE frame exactly as ai@7's JsonToSseTransformStream writes it. */
function sse(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** A tee'd-copy stand-in. `close: false` models the blocked read that only the
 *  route-owned T2 deadline can end. */
function streamOf(chunks: string[], opts: { close: boolean }): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      if (opts.close) controller.close();
    },
  });
}

type StreamOptions = {
  originalMessages?: unknown;
  generateMessageId?: () => string;
  messageMetadata: (a: { part: { type: string; finishReason?: string } }) => unknown;
  onError: (e: unknown) => string;
  onEnd: (e: { responseMessage?: unknown; isAborted?: boolean }) => void;
  consumeSseStream: (a: { stream: ReadableStream<string> }) => void;
};

function capturedStreamOptions(): StreamOptions {
  return toUIResponseSpy.mock.calls[0][0] as StreamOptions;
}

/** Let the route's own promise chains (consumer -> finalize) settle. */
async function settle(): Promise<void> {
  await jest.advanceTimersByTimeAsync(10);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  approvedMock.mockResolvedValue({ user: { id: 7, isAdmin: false } });
  csrfMock.mockResolvedValue(true);
  rateMock.mockReturnValue({});
  resolveMock.mockResolvedValue(MODEL);
  createAiToolsSpy.mockReturnValue({ find_product: {} });
  mockUsage.promise = Promise.resolve({ inputTokens: 11, outputTokens: 22, totalTokens: 33 });
  mockThreadOps.claimTurn.mockResolvedValue({ ...CLAIM });
  mockThreadOps.loadBoundedHistory.mockResolvedValue(HISTORY);
  mockThreadOps.finalizeTurn.mockResolvedValue({ finalized: true, status: "ok" });
  mockTitles.generateThreadTitle.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Guard order — no model call before every guard passes
// ---------------------------------------------------------------------------

describe("guards fail as JSON before the model runs", () => {
  test("unapproved => 403, no streamText, no provider resolution, no claim", async () => {
    approvedMock.mockRejectedValue(new AppError("Account pending approval", "FORBIDDEN", 403));
    const res = await POST(req(validBody));
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(streamTextSpy).not.toHaveBeenCalled();
    expect(resolveMock).not.toHaveBeenCalled();
    expect(mockThreadOps.claimTurn).not.toHaveBeenCalled();
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

  test("provider unconfigured => 409 AI_UNCONFIGURED, no streamText, no claim", async () => {
    resolveMock.mockRejectedValue(new AppError("Assistant is not configured", "AI_UNCONFIGURED", 409));
    const res = await POST(req(validBody));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("AI_UNCONFIGURED");
    expect(streamTextSpy).not.toHaveBeenCalled();
    expect(mockThreadOps.claimTurn).not.toHaveBeenCalled();
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
// C2 envelope — the old envelope is DELETED, and the post-parse asserts bite
// ---------------------------------------------------------------------------

describe("C2 request envelope", () => {
  test("the OLD envelope (conversationId + messages array) => 400 VALIDATION_ERROR", async () => {
    const res = await POST(
      req({
        conversationId: "11111111-1111-4111-8111-111111111111",
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION_ERROR");
    expect(resolveMock).not.toHaveBeenCalled();
    expect(mockThreadOps.claimTurn).not.toHaveBeenCalled();
    expect(streamTextSpy).not.toHaveBeenCalled();
  });

  test("threadId null is legal (first message of a new thread)", async () => {
    mockThreadOps.claimTurn.mockResolvedValue({ ...CLAIM, threadWasCreated: true });
    const res = await POST(req({ ...validBody, threadId: null }));
    expect(res.status).toBe(200);
    expect(mockThreadOps.claimTurn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: null, userId: 7 }),
    );
  });

  test("a non-cuid threadId => 400", async () => {
    const res = await POST(req({ ...validBody, threadId: "not-a-cuid" }));
    expect(res.status).toBe(400);
    expect(mockThreadOps.claimTurn).not.toHaveBeenCalled();
  });

  test("a non-text part => 400 VALIDATION_ERROR (unknown part types are never stored)", async () => {
    const res = await POST(
      req({
        ...validBody,
        message: { id: "m1", role: "user", parts: [{ type: "image", url: "x" }] },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION_ERROR");
  });

  test("more than 4 parts => 400", async () => {
    const res = await POST(
      req({
        ...validBody,
        message: {
          id: "m1",
          role: "user",
          parts: Array.from({ length: 5 }, () => ({ type: "text", text: "x" })),
        },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("post-parse assert: the SERIALIZED message cap is what bites (not raw text)", async () => {
    // Four parts, each under the raw per-part bound, whose SERIALIZED total blows
    // MESSAGE_BUDGET_BYTES — exactly the G2D-1 hole a raw-text cap leaves open.
    const chunk = "y".repeat(MESSAGE_BUDGET_BYTES / 4);
    const res = await POST(
      req({
        ...validBody,
        message: {
          id: "m1",
          role: "user",
          parts: Array.from({ length: 4 }, () => ({ type: "text", text: chunk })),
        },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION_ERROR");
    expect(mockThreadOps.claimTurn).not.toHaveBeenCalled();
  });

  test("control characters other than \\n\\r\\t are rejected outright", async () => {
    const res = await POST(
      req({
        ...validBody,
        message: { id: "m1", role: "user", parts: [{ type: "text", text: "a\u0007b" }] },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION_ERROR");
  });

  test("newline / carriage return / tab stay legal", async () => {
    const res = await POST(
      req({
        ...validBody,
        message: { id: "m1", role: "user", parts: [{ type: "text", text: "a\n\r\tb" }] },
      }),
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/assistant — the U1 readiness probe (unchanged by the cutover)
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
// C2 server flow — claim -> bounded history -> stream
// ---------------------------------------------------------------------------

describe("claim transaction + bounded history", () => {
  test("claimTurn receives the envelope + the resolved provider and membership scope", async () => {
    await POST(req({ ...validBody, trigger: "regenerate-message" }));
    expect(mockThreadOps.claimTurn).toHaveBeenCalledWith({
      userId: 7,
      threadId: THREAD_ID,
      message: validBody.message,
      trigger: "regenerate-message",
      membershipScope: ["c-a"],
      providerKind: "ANTHROPIC",
      model: "claude-x",
    });
  });

  test("THREAD_BUSY surfaces as 409 JSON with no stream", async () => {
    mockThreadOps.claimTurn.mockRejectedValue(
      new AppError("A response is already streaming in this thread", "THREAD_BUSY", 409),
    );
    const res = await POST(req(validBody));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("THREAD_BUSY");
    expect(streamTextSpy).not.toHaveBeenCalled();
    expect(mockThreadOps.finalizeTurn).not.toHaveBeenCalled();
  });

  test("a foreign thread 404s (claim failure never opens a stream)", async () => {
    mockThreadOps.claimTurn.mockRejectedValue(new AppError("Thread not found", "NOT_FOUND", 404));
    const res = await POST(req(validBody));
    expect(res.status).toBe(404);
    expect(streamTextSpy).not.toHaveBeenCalled();
  });

  test("history loads AFTER the claim, scoped to the caller, and feeds both seams", async () => {
    await POST(req(validBody));
    expect(mockThreadOps.loadBoundedHistory).toHaveBeenCalledWith(7, THREAD_ID);

    const opts = streamTextSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.messages).toEqual({
      __converted: HISTORY,
      __opts: { ignoreIncompleteToolCalls: true },
    });
    expect(capturedStreamOptions().originalMessages).toBe(HISTORY);
  });
});

// ---------------------------------------------------------------------------
// W1S-1 — the omission sentinel is id AND role
// ---------------------------------------------------------------------------

describe("history omission sentinel (W1S-1)", () => {
  /** streamText's captured `messages` is the convertToModelMessages mock's envelope,
   *  so `__converted` IS the array the route chose to convert. */
  function convertedFrom(): { messages: { __converted: unknown }; system: string } {
    return streamTextSpy.mock.calls[0][0] as { messages: { __converted: unknown }; system: string };
  }

  test("a USER message that happens to carry the sentinel id is NEVER stripped", async () => {
    // Ids are client-chosen: nothing stops a client from naming its own user message
    // "system-history-omission". Stripping it would silently delete the user's turn AND
    // graft a false "earlier turns omitted" note onto a complete history.
    const history = [
      { id: HISTORY_OMISSION_ID, role: "user", parts: [{ type: "text", text: "cheeky id" }] },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "sure" }] },
    ];
    mockThreadOps.loadBoundedHistory.mockResolvedValue(history);

    await POST(req(validBody));

    const opts = convertedFrom();
    // Reference identity: the route converted the loaded array ITSELF, unsliced.
    expect(opts.messages.__converted).toBe(history);
    expect(opts.system).not.toContain(HISTORY_OMISSION_NOTE);
    expect(capturedStreamOptions().originalMessages).toBe(history);
  });

  test("CONTROL: the SYSTEM-role note IS stripped and rides the system option instead", async () => {
    const note = {
      id: HISTORY_OMISSION_ID,
      role: "system",
      parts: [{ type: "text", text: HISTORY_OMISSION_NOTE }],
    };
    const kept = { id: "m2", role: "user", parts: [{ type: "text", text: "hi" }] };
    mockThreadOps.loadBoundedHistory.mockResolvedValue([note, kept]);

    await POST(req(validBody));

    const opts = convertedFrom();
    // ai@7 REJECTS system-role messages in `messages` — the note must not be converted.
    expect(opts.messages.__converted).toEqual([kept]);
    expect(opts.system).toContain(HISTORY_OMISSION_NOTE);
    expect(capturedStreamOptions().originalMessages).toEqual([kept]);
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
    // RETAINED alongside the route-owned timers; A1 pack C5: the value is timing.ts's
    // (the providers mock above carries no such key, so a providers import reads undefined).
    expect(opts.timeout).toBe(PROVIDER_TIMEOUT_MS);
    expect(opts.maxOutputTokens).toBe(16000); // A1 plan D5 (model-options.ts)
    // "claude-x" is ANTHROPIC but outside the effort table: API defaults, no options.
    expect(opts).not.toHaveProperty("providerOptions");
    expect(opts).not.toHaveProperty("prepareStep");
    expect(opts.tools).toEqual({ find_product: {} });
    expect(typeof opts.onFinish).toBe("function");
  });

  // A1 pack C3/C4 (seam S1): the route spells no provider option itself — the
  // resolved kind + model go through modelCallOptions(..., "assistant").
  test("a resolved claude-opus-5-5 sends effort medium (its API default) and no thinking", async () => {
    resolveMock.mockResolvedValue({ ...MODEL, model: "claude-opus-5-5" });
    await POST(req(validBody));
    const opts = streamTextSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.providerOptions).toEqual({ anthropic: { effort: "medium" } });
    expect(opts.maxOutputTokens).toBe(16000);
    expect(JSON.stringify(opts.providerOptions)).not.toContain("thinking");
    expect(opts).not.toHaveProperty("prepareStep");
    expect(opts.stopWhen).toEqual({ __stepCountIs: 10 });
  });

  test("an OPENAI row gets NO providerOptions, the same 16000 per-step cap, no prepareStep", async () => {
    resolveMock.mockResolvedValue({ languageModel: { __model: true }, kind: "OPENAI", model: "gpt-x" });
    await POST(req(validBody));
    const opts = streamTextSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(opts).not.toHaveProperty("providerOptions");
    expect(opts.maxOutputTokens).toBe(16000);
    expect(opts).not.toHaveProperty("prepareStep");
    expect(opts.stopWhen).toEqual({ __stepCountIs: 10 });
  });

  test("abortSignal is the LATCH's signal, never request.signal directly", async () => {
    const request = req(validBody);
    await POST(request);
    const opts = streamTextSpy.mock.calls[0][0] as { abortSignal: AbortSignal };
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
    expect(opts.abortSignal).not.toBe(request.signal);
  });

  // STEP_LIMIT 8 -> 10 is W3-TUNE (spec §5 T-TUNE REV-2). The per-step output cap is
  // A1 plan D5: 3072 cut one Opus 5.5 answer in five (thinking counts toward it), so
  // it is 16000 and lives in lib/assistant/model-options.ts. Cost is dominated by
  // INPUT, not this cap — it moves only the output tail. Changing either value here
  // must re-derive D5.
  test("STEP_LIMIT is 10 and the per-step output cap is 16000 (A1 plan D5)", async () => {
    await POST(req(validBody));
    const opts = streamTextSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.stopWhen).toEqual({ __stepCountIs: 10 });
    expect(opts.maxOutputTokens).toBe(16000);
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

    // The telemetry wrapper injects resolved kind/model AND the claim's requestId
    // into each row (T5 — per-tool rows attribute to the turn that spent them).
    onRun({ userId: 7, surface: "assistant", toolName: "find_product", outcome: "ok", durationMs: 1, resultBytes: 5 });
    expect(recordRunSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        providerKind: "ANTHROPIC",
        model: "claude-x",
        toolName: "find_product",
        requestId: 4242,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// C3 — message identity + thread-id return
// ---------------------------------------------------------------------------

describe("response stream options (C3)", () => {
  test("generateMessageId is a createIdGenerator({ prefix: 'am', size: 24 })", async () => {
    await POST(req(validBody));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createIdGenerator } = jest.requireMock("ai") as { createIdGenerator: jest.Mock };
    expect(createIdGenerator).toHaveBeenCalledWith({ prefix: "am", size: 24 });
    expect(typeof capturedStreamOptions().generateMessageId).toBe("function");
  });

  test("messageMetadata carries threadId on start and { finishReason, threadId } on finish", async () => {
    await POST(req(validBody));
    const o = capturedStreamOptions();
    expect(o.messageMetadata({ part: { type: "start" } })).toEqual({ threadId: THREAD_ID });
    expect(o.messageMetadata({ part: { type: "finish", finishReason: "tool-calls" } })).toEqual({
      finishReason: "tool-calls",
      threadId: THREAD_ID,
    });
    expect(o.messageMetadata({ part: { type: "text-delta" } })).toBeUndefined();
  });

  // A1 pack C4b (seam S2, producer half): an `abort` part that was NOT a user Stop
  // carries the timeout to the live client as message metadata.
  test("messageMetadata on an abort part after T1 (cause 'provider-timeout') carries PROVIDER_TIMEOUT", async () => {
    await POST(req(validBody));
    await jest.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS);
    // Positive control: T1 really fired (it aborts the latch's signal) and T2 did not.
    const opts = streamTextSpy.mock.calls[0][0] as { abortSignal: AbortSignal };
    expect(opts.abortSignal.aborted).toBe(true);
    expect(mockThreadOps.finalizeTurn).not.toHaveBeenCalled();
    expect(capturedStreamOptions().messageMetadata({ part: { type: "abort" } })).toEqual({
      errorCode: "PROVIDER_TIMEOUT",
      threadId: THREAD_ID,
    });
  });

  test("messageMetadata on an abort part with NO latched cause (the SDK's own timeout) carries PROVIDER_TIMEOUT", async () => {
    await POST(req(validBody));
    expect(capturedStreamOptions().messageMetadata({ part: { type: "abort" } })).toEqual({
      errorCode: "PROVIDER_TIMEOUT",
      threadId: THREAD_ID,
    });
  });

  test("messageMetadata on an abort part after a user Stop (cause 'client') is undefined", async () => {
    const request = req(validBody);
    const controller = new AbortController();
    Object.defineProperty(request, "signal", { value: controller.signal });
    await POST(request);
    controller.abort();
    const o = capturedStreamOptions();
    expect(o.messageMetadata({ part: { type: "abort" } })).toBeUndefined();
    // The thread id still rides "start" after a Stop — only the abort branch differs.
    expect(o.messageMetadata({ part: { type: "start" } })).toEqual({ threadId: THREAD_ID });
  });

  test("onError masks any provider error to a fixed code, never the raw payload", async () => {
    await POST(req(validBody));
    const masked = capturedStreamOptions().onError(new Error("sk-live-SECRET-should-never-leak"));
    expect(masked).toBe("PROVIDER_ERROR");
    expect(masked).not.toContain("SECRET");
    await settle();
  });
});

// ---------------------------------------------------------------------------
// C4 — the accumulator (frame buffering, never one chunk = one event)
// ---------------------------------------------------------------------------

describe("SSE accumulator", () => {
  test("buffers arbitrary chunk boundaries into complete frames", async () => {
    await POST(req(validBody));
    const o = capturedStreamOptions();
    o.consumeSseStream({
      stream: streamOf(
        [
          'data: {"type":"start","messageId":"am_srv"}\n\ndata: {"type":"text-st',
          'art","id":"t1"}\n\ndata: {"type":"text-delta","id":"t1","delta":"Hel',
          'lo"}\n\n',
        ],
        { close: false },
      ),
    });

    await jest.advanceTimersByTimeAsync(FINALIZE_DEADLINE_MS);
    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledTimes(1);
    const input = mockThreadOps.finalizeTurn.mock.calls[0][0] as { message: { id: string; parts: unknown[] } };
    expect(input.message.id).toBe("am_srv");
    expect(input.message.parts).toEqual([{ type: "text", text: "Hello", state: "streaming" }]);
  });

  test("parses tool + text parts and stops at [DONE]", async () => {
    await POST(req(validBody));
    const o = capturedStreamOptions();
    o.consumeSseStream({
      stream: streamOf(
        [
          sse({ type: "start", messageId: "am_srv" }),
          sse({ type: "tool-input-start", toolCallId: "tc1", toolName: "find_product" }),
          sse({ type: "tool-input-available", toolCallId: "tc1", toolName: "find_product", input: { q: "x" } }),
          sse({ type: "tool-output-available", toolCallId: "tc1", output: { ok: true } }),
          sse({ type: "text-start", id: "t1" }),
          sse({ type: "text-delta", id: "t1", delta: "done" }),
          sse({ type: "text-end", id: "t1" }),
          // Exactly what the route's own messageMetadata callback puts on the wire.
          sse({
            type: "finish",
            finishReason: "stop",
            messageMetadata: { finishReason: "stop", threadId: THREAD_ID },
          }),
          "data: [DONE]\n\n",
          sse({ type: "text-delta", id: "t1", delta: "AFTER-DONE" }),
        ],
        { close: false },
      ),
    });

    await jest.advanceTimersByTimeAsync(FINALIZE_DEADLINE_MS);
    const input = mockThreadOps.finalizeTurn.mock.calls[0][0] as {
      message: { parts: unknown[]; metadata?: unknown };
    };
    expect(input.message.parts).toEqual([
      {
        type: "tool-find_product",
        toolCallId: "tc1",
        state: "output-available",
        input: { q: "x" },
        output: { ok: true },
      },
      { type: "text", text: "done", state: "done" },
    ]);
    // The accumulator mirrors the SDK: message metadata comes from `messageMetadata`
    // carriers only. finalizeTurn reads finishReason back out of it (pack T2) and
    // strips threadId, so this is the seam that keeps a stalled turn's finish reason.
    expect(input.message.metadata).toEqual({ finishReason: "stop", threadId: THREAD_ID });
  });

  test("an empty stream yields NO assistant message (the silent-stall case)", async () => {
    await POST(req(validBody));
    capturedStreamOptions().consumeSseStream({ stream: streamOf([], { close: false }) });
    await jest.advanceTimersByTimeAsync(FINALIZE_DEADLINE_MS);
    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ message: null }),
    );
  });
});

// ---------------------------------------------------------------------------
// C4 — finalize-once across onEnd / onError / T2 deadline / setup failure
// ---------------------------------------------------------------------------

describe("finalize-once", () => {
  test("onEnd finalizes with the SDK's responseMessage and the resolved usage", async () => {
    await POST(req(validBody));
    const message = { id: "am_1", role: "assistant", parts: [{ type: "text", text: "hi" }] };
    capturedStreamOptions().onEnd({ responseMessage: message, isAborted: false });
    await settle();

    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledTimes(1);
    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledWith({
      requestId: 4242,
      threadId: THREAD_ID,
      message,
      cause: null,
      eventAborted: false,
      errorLatched: null,
      usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 },
      durationMs: expect.any(Number),
    });
  });

  test("a second onEnd (and a later deadline) cannot finalize twice", async () => {
    await POST(req(validBody));
    const o = capturedStreamOptions();
    o.onEnd({ responseMessage: { id: "am_1", role: "assistant", parts: [] }, isAborted: false });
    o.onEnd({ responseMessage: { id: "am_1", role: "assistant", parts: [] }, isAborted: false });
    await jest.advanceTimersByTimeAsync(FINALIZE_DEADLINE_MS);
    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledTimes(1);
  });

  test("a client disconnect is latched as cause 'client' and reaches the finalizer", async () => {
    const request = req(validBody);
    const controller = new AbortController();
    Object.defineProperty(request, "signal", { value: controller.signal });
    await POST(request);
    controller.abort();

    capturedStreamOptions().onEnd({ responseMessage: { id: "am_1", role: "assistant", parts: [] }, isAborted: true });
    await settle();
    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ cause: "client", eventAborted: true }),
    );
  });

  test("onError latches the masked code and finalizes only AFTER the consumer settles", async () => {
    await POST(req(validBody));
    const o = capturedStreamOptions();

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    o.consumeSseStream({
      stream: new ReadableStream<string>({
        async pull(controller) {
          await gate;
          controller.enqueue(sse({ type: "text-start", id: "t1" }));
          controller.enqueue(sse({ type: "text-delta", id: "t1", delta: "partial" }));
          controller.close();
        },
      }),
    });

    o.onError(new AppError("step cap", "STEP_LIMIT", 500));
    await settle();
    expect(mockThreadOps.finalizeTurn).not.toHaveBeenCalled(); // consumer still running

    release();
    await settle();
    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledTimes(1);
    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorLatched: "STEP_LIMIT",
        message: expect.objectContaining({ parts: [{ type: "text", text: "partial", state: "streaming" }] }),
      }),
    );
  });

  test("the T2 deadline finalizes with cause 'provider-timeout' (T1 latched it first)", async () => {
    await POST(req(validBody));
    capturedStreamOptions().consumeSseStream({
      stream: streamOf([sse({ type: "start", messageId: "am_srv" })], { close: false }),
    });
    await jest.advanceTimersByTimeAsync(FINALIZE_DEADLINE_MS);
    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ cause: "provider-timeout", eventAborted: false }),
    );
  });

  test("usage that never resolves loses the 2s race and persists as null", async () => {
    mockUsage.promise = new Promise(() => {});
    await POST(req(validBody));
    capturedStreamOptions().onEnd({ responseMessage: { id: "am_1", role: "assistant", parts: [] }, isAborted: false });
    await jest.advanceTimersByTimeAsync(2_100);
    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledWith(expect.objectContaining({ usage: null }));
  });

  test("a REJECTED usage promise persists null (finalized only after the consumer settles)", async () => {
    // The hazard is the WINDOW: on the error path the finalizer (the only other
    // `await` of result.usage) runs many ticks later, after the accumulator settles,
    // and node's default is to CRASH on an unhandled rejection — hence the route's
    // `void result.usage.catch(...)` at the assignment site. HONESTY NOTE: the
    // listener below is a WITNESS, not a proof — this harness does not surface the
    // process-level event either way (verified by deleting the guard). What IS
    // proven here is the persisted outcome: usage null, exactly once, late.
    const unhandled = jest.fn();
    process.on("unhandledRejection", unhandled);
    mockUsage.promise = Promise.reject(new Error("provider blew up"));

    await POST(req(validBody));
    const o = capturedStreamOptions();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    o.consumeSseStream({
      stream: new ReadableStream<string>({
        async pull(controller) {
          await gate;
          controller.close();
        },
      }),
    });
    o.onError(new Error("provider blew up"));
    await settle();
    expect(mockThreadOps.finalizeTurn).not.toHaveBeenCalled(); // consumer still running

    release();
    await settle();
    process.off("unhandledRejection", unhandled);

    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledTimes(1);
    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledWith(expect.objectContaining({ usage: null }));
    expect(unhandled).not.toHaveBeenCalled();
  });

  test("a setup failure after the claim finalizes the request row (no phantom running)", async () => {
    mockThreadOps.loadBoundedHistory.mockRejectedValue(new Error("history exploded"));
    const res = await POST(req(validBody));
    expect(res.status).toBe(500);
    expect(streamTextSpy).not.toHaveBeenCalled();
    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ message: null, errorLatched: "PROVIDER_ERROR", usage: null }),
    );
  });
});

// ---------------------------------------------------------------------------
// A1 pack C12 (FR4, A1-FD3-1) — the SDK also calls the UI-stream onError for a tool
// call it REJECTED: a `tool-input-error` part for invalid input or an unknown tool
// (ai dist/index.js:7335-7345; produced at :8232-8242). The model reads the rejection
// and can recover, so that call returns "TOOL_ERROR" as the part's error text and does
// nothing else. Every other error keeps today's exact path: masked, latched, logged,
// finalize scheduled.
//
// REV 11 (amendment row 11): for ONE rejected call the SDK calls onError TWICE — with
// the instance, then with its string form for the paired `tool-output-error` (:7394-
// 7399; the producer sets `error: getErrorMessage(instance)` = `instance.toString()`).
// The route classifies both through lib/assistant/stream-errors.ts (REAL here; only
// `ai` is mocked). The real SDK's sequence is proven in the wire probe, case f.
// ---------------------------------------------------------------------------

describe("onError: a tool call the SDK rejected is not a failed turn (A1 C12)", () => {
  /** classifyTurn's rule (threads.ts) for a turn with no abort cause: a latched code
   *  is status "error", none is "ok". The fence's answer — and the title job behind
   *  it — follows what the route latched. */
  const fenceFromLatch = async (input: { errorLatched: string | null }) => ({
    finalized: true,
    status: input.errorLatched === null ? "ok" : "error",
  });
  const RECOVERED = {
    id: "am_1",
    role: "assistant",
    parts: [{ type: "text", text: "Alpha 5mg has 12 on hand." }],
  };

  let info: jest.SpyInstance;
  beforeEach(() => {
    mockThreadOps.finalizeTurn.mockImplementation(fenceFromLatch);
    info = jest.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => info.mockRestore());

  const failedRunsLogged = (): number =>
    info.mock.calls.filter(
      ([tag, row]) => tag === "[assistant] run" && (row as { outcome?: string }).outcome === "error",
    ).length;
  const fenceStatus = (call: number): Promise<unknown> => mockThreadOps.finalizeTurn.mock.results[call].value;

  const REJECTIONS: Array<[string, () => Error]> = [
    [
      "an InvalidToolInputError",
      () =>
        new InvalidToolInputError({
          toolName: "find_product",
          toolInput: '{"query":5}',
          cause: new Error("Expected string, received number"),
        }),
    ],
    ["a NoSuchToolError", () => new NoSuchToolError({ toolName: "find_products", availableTools: ["find_product"] })],
  ];

  test.each(REJECTIONS)(
    "%s, the SDK's real TWO-call sequence (the instance, then its string) -> both 'TOOL_ERROR'; the turn finalizes ok and gets its title",
    async (_name, rejection) => {
      await POST(req(validBody));
      const o = capturedStreamOptions();
      const instance = rejection();
      // What the SDK hands onError for the paired tool-output-error: getErrorMessage(
      // instance), i.e. `instance.toString()` = "<name>: <message>".
      const sdkString = instance.toString();
      expect(sdkString.startsWith(`${instance.name}: `)).toBe(true);

      expect(o.onError(instance)).toBe("TOOL_ERROR"); // tool-input-error
      expect(o.onError(sdkString)).toBe("TOOL_ERROR"); // tool-output-error
      await settle();
      expect(mockThreadOps.finalizeTurn).not.toHaveBeenCalled(); // no early finalize
      expect(failedRunsLogged()).toBe(0);

      o.onEnd({ responseMessage: RECOVERED, isAborted: false });
      await settle();
      expect(mockThreadOps.finalizeTurn).toHaveBeenCalledTimes(1);
      expect(mockThreadOps.finalizeTurn).toHaveBeenCalledWith(
        expect.objectContaining({ message: RECOVERED, cause: null, eventAborted: false, errorLatched: null }),
      );
      await expect(fenceStatus(0)).resolves.toEqual({ finalized: true, status: "ok" });
      expect(mockTitles.generateThreadTitle).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    ["a string that names the class mid-text", "Upstream said: AI_NoSuchToolError: model tried a tool"],
    ["a string that is the bare name (no ': ')", "AI_InvalidToolInputError"],
    ["a lower-case look-alike string", "ai_nosuchtoolerror: x"],
    // The instance check is the SDK's marker check, never the name.
    ["an Error merely NAMED like one", Object.assign(new Error("x"), { name: "AI_NoSuchToolError" })],
  ])("CONTROL: %s keeps today's path — PROVIDER_ERROR latched, logged, finalized; status error", async (_name, error) => {
    await POST(req(validBody));
    const o = capturedStreamOptions();
    expect(o.onError(error)).toBe("PROVIDER_ERROR");
    await settle();
    expect(failedRunsLogged()).toBe(1);
    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledTimes(1);
    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledWith(expect.objectContaining({ errorLatched: "PROVIDER_ERROR" }));
    await expect(fenceStatus(0)).resolves.toEqual({ finalized: true, status: "error" });
    expect(mockTitles.generateThreadTitle).not.toHaveBeenCalled();
  });

  test.each(REJECTIONS)(
    "%s -> 'TOOL_ERROR'; nothing latched, logged or finalized early; the recovered turn finalizes ok and gets its title",
    async (_name, rejection) => {
      await POST(req(validBody));
      const o = capturedStreamOptions();

      expect(o.onError(rejection())).toBe("TOOL_ERROR");
      await settle();
      expect(mockThreadOps.finalizeTurn).not.toHaveBeenCalled(); // no early finalize
      expect(failedRunsLogged()).toBe(0);

      // The model recovers; the stream ends normally.
      o.onEnd({ responseMessage: RECOVERED, isAborted: false });
      await settle();
      expect(mockThreadOps.finalizeTurn).toHaveBeenCalledTimes(1);
      expect(mockThreadOps.finalizeTurn).toHaveBeenCalledWith(
        expect.objectContaining({ message: RECOVERED, cause: null, eventAborted: false, errorLatched: null }),
      );
      await expect(fenceStatus(0)).resolves.toEqual({ finalized: true, status: "ok" });
      expect(mockTitles.generateThreadTitle).toHaveBeenCalledTimes(1);
    },
  );

  test("CONTROL: a provider error (an APICallError) keeps today's path — PROVIDER_ERROR latched, logged, finalized without onEnd; status error, no title", async () => {
    await POST(req(validBody));
    const o = capturedStreamOptions();
    const masked = o.onError(
      new APICallError({
        message: "Overloaded",
        url: "https://provider.invalid/v1/messages",
        requestBodyValues: {},
        statusCode: 529,
        responseBody: "sk-live-SECRET-should-never-leak",
      }),
    );
    expect(masked).toBe("PROVIDER_ERROR");
    await settle();
    expect(failedRunsLogged()).toBe(1);
    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledTimes(1);
    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledWith(expect.objectContaining({ errorLatched: "PROVIDER_ERROR" }));
    await expect(fenceStatus(0)).resolves.toEqual({ finalized: true, status: "error" });

    o.onEnd({ responseMessage: RECOVERED, isAborted: false });
    await settle();
    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledTimes(1);
    expect(mockTitles.generateThreadTitle).not.toHaveBeenCalled();
  });

  test.each([
    ["a plain Error", "PROVIDER_ERROR", () => new Error("socket hang up")],
    ["an AppError STEP_LIMIT", "STEP_LIMIT", () => new AppError("step cap", "STEP_LIMIT", 500)],
    // The new branch keys on the SDK's class, never on the code string: our own
    // TOOL_ERROR is still latched.
    ["an AppError TOOL_ERROR", "TOOL_ERROR", () => new AppError("tool failed", "TOOL_ERROR", 500)],
  ])("CONTROL: %s is unchanged — masked to %p, latched, logged, finalized", async (_name, code, make) => {
    await POST(req(validBody));
    const o = capturedStreamOptions();
    expect(o.onError(make())).toBe(code);
    await settle();
    expect(failedRunsLogged()).toBe(1);
    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledTimes(1);
    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledWith(expect.objectContaining({ errorLatched: code }));
    await expect(fenceStatus(0)).resolves.toEqual({ finalized: true, status: "error" });
    expect(mockTitles.generateThreadTitle).not.toHaveBeenCalled();
  });

  test("a rejected tool call shields nothing: a LATER provider error still latches PROVIDER_ERROR", async () => {
    await POST(req(validBody));
    const o = capturedStreamOptions();
    expect(o.onError(new NoSuchToolError({ toolName: "find_products" }))).toBe("TOOL_ERROR");
    expect(o.onError(new Error("provider blew up"))).toBe("PROVIDER_ERROR");
    await settle();
    expect(failedRunsLogged()).toBe(1);
    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledTimes(1);
    expect(mockThreadOps.finalizeTurn).toHaveBeenCalledWith(expect.objectContaining({ errorLatched: "PROVIDER_ERROR" }));
    await expect(fenceStatus(0)).resolves.toEqual({ finalized: true, status: "error" });
    expect(mockTitles.generateThreadTitle).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // A2 pack C11 (FD4-1): the redacted run log COUNTS the rejected tool calls — one per
  // call (the instance; its string twin is not a second call), logged when streamText's
  // onFinish fires (the real SDK's ordering is proven in the wire probe, cases f and
  // f-one-step). Still "TOOL_ERROR", still nothing latched.
  // -------------------------------------------------------------------------

  describe("A2 C11 — rejectedToolCalls on the run log", () => {
    /** The run-log rows the route wrote, in order. */
    const runRows = (): Array<Record<string, unknown>> =>
      info.mock.calls.filter(([tag]) => tag === "[assistant] run").map(([, row]) => row as Record<string, unknown>);
    const finish = () => (streamTextSpy.mock.calls[0][0] as { onFinish: () => void }).onFinish();

    test.each(REJECTIONS)("one rejection (%s): the instance then its string -> rejectedToolCalls 1", async (_name, rejection) => {
      await POST(req(validBody));
      const o = capturedStreamOptions();
      const instance = rejection();
      expect(o.onError(instance)).toBe("TOOL_ERROR");
      expect(o.onError(instance.toString())).toBe("TOOL_ERROR");
      finish();
      expect(runRows()).toEqual([expect.objectContaining({ outcome: "ok", rejectedToolCalls: 1 })]);
      expect(failedRunsLogged()).toBe(0);

      // Nothing latched: the turn still finalizes ok.
      o.onEnd({ responseMessage: RECOVERED, isAborted: false });
      await settle();
      expect(mockThreadOps.finalizeTurn).toHaveBeenCalledWith(expect.objectContaining({ errorLatched: null }));
      await expect(fenceStatus(0)).resolves.toEqual({ finalized: true, status: "ok" });
    });

    test("two rejections (an unknown tool, then invalid input), each instance + string -> 2", async () => {
      await POST(req(validBody));
      const o = capturedStreamOptions();
      for (const [, rejection] of REJECTIONS) {
        const instance = rejection();
        expect(o.onError(instance)).toBe("TOOL_ERROR");
        expect(o.onError(instance.toString())).toBe("TOOL_ERROR");
      }
      finish();
      expect(runRows()).toEqual([expect.objectContaining({ outcome: "ok", rejectedToolCalls: 2 })]);
      expect(failedRunsLogged()).toBe(0);
    });

    test("the string twin alone is never counted (it is the same call's second part)", async () => {
      await POST(req(validBody));
      const o = capturedStreamOptions();
      const [, rejection] = REJECTIONS[0];
      expect(o.onError(rejection().toString())).toBe("TOOL_ERROR");
      finish();
      expect(runRows()).toEqual([expect.objectContaining({ outcome: "ok", rejectedToolCalls: 0 })]);
    });

    test("the run-log shape: the redacted vocabulary plus rejectedToolCalls, nothing else", async () => {
      await POST(req(validBody));
      const o = capturedStreamOptions();
      const [, rejection] = REJECTIONS[1];
      o.onError(rejection());
      finish();
      expect(runRows()).toEqual([
        {
          threadId: THREAD_ID,
          requestId: 4242,
          userId: 7,
          providerKind: "ANTHROPIC",
          model: "claude-x",
          toolNames: [],
          rejectedToolCalls: 1,
          outcome: "ok",
          durationMs: expect.any(Number),
        },
      ]);
    });

    test("a later provider failure logs the error row with the count so far; a control error counts nothing", async () => {
      await POST(req(validBody));
      const o = capturedStreamOptions();
      const [, rejection] = REJECTIONS[0];
      o.onError(rejection());
      // An Error merely NAMED like a rejection is a provider failure, not a rejected call.
      expect(o.onError(Object.assign(new Error("x"), { name: "AI_NoSuchToolError" }))).toBe("PROVIDER_ERROR");
      await settle();
      expect(runRows()).toEqual([expect.objectContaining({ outcome: "error", rejectedToolCalls: 1 })]);
      expect(failedRunsLogged()).toBe(1);
    });

    // FD4-4: stream-errors.ts is complete only for the route's current streamText options —
    // a repair hook would turn a rejection into a ToolCallRepairError the classifier (and
    // so this counter) does not know.
    test("FD4-4: the captured streamText options carry no experimental_repairToolCall", async () => {
      await POST(req(validBody));
      const opts = streamTextSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(opts).not.toHaveProperty("experimental_repairToolCall");
      expect(Object.keys(opts).some((k) => /repair/i.test(k))).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// T6 — the detached title dispatch
// ---------------------------------------------------------------------------

describe("title dispatch", () => {
  test("a created thread dispatches mode 'creating-model' with the first user text", async () => {
    mockThreadOps.claimTurn.mockResolvedValue({ ...CLAIM, threadWasCreated: true });
    await POST(req({ ...validBody, threadId: null }));
    capturedStreamOptions().onEnd({ responseMessage: { id: "am_1", role: "assistant", parts: [] }, isAborted: false });
    await settle();
    expect(mockTitles.generateThreadTitle).toHaveBeenCalledWith({
      mode: "creating-model",
      userId: 7,
      threadId: THREAD_ID,
      firstUserText: "hi",
      membershipScope: ["c-a"],
    });
  });

  test("an existing thread dispatches mode 'later-fallback' (no model call in W1)", async () => {
    await POST(req(validBody));
    capturedStreamOptions().onEnd({ responseMessage: { id: "am_1", role: "assistant", parts: [] }, isAborted: false });
    await settle();
    expect(mockTitles.generateThreadTitle).toHaveBeenCalledWith({
      mode: "later-fallback",
      userId: 7,
      threadId: THREAD_ID,
    });
  });

  test("no title job unless the FENCE reported { finalized: true, status: 'ok' }", async () => {
    mockThreadOps.finalizeTurn.mockResolvedValue({ finalized: false, status: null });
    await POST(req(validBody));
    capturedStreamOptions().onEnd({ responseMessage: { id: "am_1", role: "assistant", parts: [] }, isAborted: false });
    await settle();
    expect(mockTitles.generateThreadTitle).not.toHaveBeenCalled();

    mockThreadOps.finalizeTurn.mockResolvedValue({ finalized: true, status: "error" });
    await POST(req(validBody));
    (toUIResponseSpy.mock.calls[1][0] as StreamOptions).onEnd({
      responseMessage: { id: "am_2", role: "assistant", parts: [] },
      isAborted: false,
    });
    await settle();
    expect(mockTitles.generateThreadTitle).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Redacted request-scoped log vocabulary (T4)
// ---------------------------------------------------------------------------

describe("redacted run log", () => {
  test("logs threadId + requestId and never prompts, args or results", async () => {
    const info = jest.spyOn(console, "info").mockImplementation(() => {});
    await POST(req(validBody));
    const opts = streamTextSpy.mock.calls[0][0] as { onFinish: () => void };
    opts.onFinish();

    expect(info).toHaveBeenCalledWith("[assistant] run", {
      threadId: THREAD_ID,
      requestId: 4242,
      userId: 7,
      providerKind: "ANTHROPIC",
      model: "claude-x",
      toolNames: [],
      // A2 pack C11: the rejected-tool-call count (none in this turn).
      rejectedToolCalls: 0,
      outcome: "ok",
      durationMs: expect.any(Number),
    });
    info.mockRestore();
  });
});
