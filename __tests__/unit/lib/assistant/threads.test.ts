/**
 * @jest-environment node
 *
 * Task 1.1 unit contracts for `lib/assistant/threads.ts` (spec C2/C4; contract pack
 * T1/T2, seam ledger S1/S2/S13).
 *
 * Prisma is the GLOBAL jest.setup mock (design D2 — unit tests mock prisma, the
 * launch gate is the real-DB proof). `$transaction` drives its callback with the
 * shared `__mockTx`, whose delegates ARE the top-level client delegates, so a single
 * assertion handle covers both.
 *
 * No wall-clock sleeps anywhere (design D7): staleness is proved by BACKDATING
 * `createdAt` and letting the module's own cutoff arithmetic decide.
 */

import fs from "fs";
import path from "path";

import prisma from "@/lib/prisma";
import { AppError } from "@/lib/error-handling";
import {
  claimTurn,
  createAbortLatch,
  deleteThreadGuarded,
  finalizeTurn,
  loadBoundedHistory,
  serializedBytes,
  HISTORY_BUDGET_BYTES,
  HISTORY_OMISSION_NOTE,
  MESSAGE_BUDGET_BYTES,
  SHED_KEEP_TURNS,
  TOOL_OUTPUT_OMITTED,
} from "@/lib/assistant/threads";
import {
  CLAIM_STALE_MS,
  FINALIZE_DEADLINE_MS,
  PROVIDER_TIMEOUT_MS,
} from "@/lib/assistant/timing";
import {
  requestSchema,
  userMessageSchema,
  type EnvelopeC2,
  type ValidatedUserMessage,
} from "@/lib/assistant/thread-contracts";

/* eslint-disable @typescript-eslint/no-explicit-any */

const db = prisma as unknown as Record<string, any>;
const { __mockTx: mockTx } = jest.requireMock("@/lib/prisma") as { __mockTx: Record<string, any> };

const USER_ID = 42;
const THREAD_ID = "cthread0000000000000000001";

function userMessage(over: Partial<ValidatedUserMessage> = {}): ValidatedUserMessage {
  return { id: "msg-user-1", role: "user", parts: [{ type: "text", text: "hello" }], ...over };
}

/** Reset every delegate function EXCEPT `$transaction` (whose default implementation
 *  is the jest.setup contract under test — pack T12). */
function resetDelegates(): void {
  for (const [key, value] of Object.entries(db)) {
    if (key === "$transaction" || typeof value !== "object" || value === null) continue;
    for (const fn of Object.values(value)) {
      if (typeof fn === "function" && "mockReset" in (fn as jest.Mock)) (fn as jest.Mock).mockReset();
    }
  }
}

/** Everything a happy-path claim touches; individual tests override one arm. */
function armClaim(): void {
  db.assistantThread.create.mockResolvedValue({ id: THREAD_ID });
  db.assistantThread.updateMany.mockResolvedValue({ count: 1 });
  db.assistantRequest.findFirst.mockResolvedValue(null);
  db.assistantRequest.updateMany.mockResolvedValue({ count: 0 });
  db.assistantRequest.create.mockResolvedValue({ id: 901 });
  db.assistantMessage.findUnique.mockResolvedValue(null);
  db.assistantMessage.findFirst.mockResolvedValue(null);
  db.assistantMessage.findMany.mockResolvedValue([]);
  db.assistantMessage.aggregate.mockResolvedValue({ _max: { sequence: 4 } });
  db.assistantMessage.create.mockResolvedValue({});
  db.assistantMessage.deleteMany.mockResolvedValue({ count: 0 });
}

/** A `findFirst` that actually evaluates the module's `createdAt > cutoff` predicate
 *  against one fixture row — the sleep-free staleness proof (D7). */
function armLiveRequestProbe(ageMs: number): void {
  const row = { id: 55, createdAt: new Date(Date.now() - ageMs) };
  db.assistantRequest.findFirst.mockImplementation(async (args: any) => {
    const cutoff = args?.where?.createdAt?.gt as Date | undefined;
    if (!cutoff) return row;
    return row.createdAt.getTime() > cutoff.getTime() ? row : null;
  });
}

beforeEach(() => {
  resetDelegates();
});

describe("module boundary (S1): threads.ts stays ai-free and never reaches the tool graph", () => {
  const REPO_ROOT = process.cwd();
  const VALUE_AI_IMPORT = /^\s*import\s+(?!type\b)[^;]*from\s+["']ai["']/m;
  const TOOL_GRAPH_IMPORT = /from\s+["']@\/lib\/assistant\/(providers|tools|tool-adapters)["']/;

  const threadsSrc = fs.readFileSync(path.join(REPO_ROOT, "lib/assistant/threads.ts"), "utf8");

  it("the value-import detector actually fires (negative control)", () => {
    const providersSrc = fs.readFileSync(path.join(REPO_ROOT, "lib/assistant/providers.ts"), "utf8");
    expect(VALUE_AI_IMPORT.test(providersSrc)).toBe(true);
    expect(TOOL_GRAPH_IMPORT.test(providersSrc)).toBe(false);
  });

  it("has NO value import from `ai` (Spike B loads this module with no ai in its graph)", () => {
    expect(VALUE_AI_IMPORT.test(threadsSrc)).toBe(false);
  });

  it("never imports providers.ts / tools.ts / tool-adapters.ts", () => {
    expect(TOOL_GRAPH_IMPORT.test(threadsSrc)).toBe(false);
  });
});

describe("thread contracts (S0): the zod envelope and the T0 DTOs agree", () => {
  const validMessage = { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] };

  it("requestSchema's OUTPUT is assignable to EnvelopeC2 (compile-time + runtime)", () => {
    // The annotation is the pin: tsc fails the suite if the shapes drift apart.
    const parsed: EnvelopeC2 = requestSchema.parse({ threadId: null, message: validMessage });
    expect(parsed.trigger).toBe("submit-message");
    expect(parsed.messageId).toBeUndefined();
    expect(parsed.threadId).toBeNull();
  });

  it("userMessageSchema's OUTPUT is assignable to ValidatedUserMessage", () => {
    const parsed: ValidatedUserMessage = userMessageSchema.parse(validMessage);
    expect(parsed.role).toBe("user");
  });

  it("enforces the C2 runtime limits the DTO types cannot express", () => {
    expect(requestSchema.safeParse({ threadId: "not-a-cuid", message: validMessage }).success).toBe(
      false,
    );
    expect(
      requestSchema.safeParse({ threadId: null, message: { ...validMessage, parts: [] } }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        threadId: null,
        message: { ...validMessage, parts: Array(5).fill({ type: "text", text: "x" }) },
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        threadId: null,
        message: validMessage,
        trigger: "delete-everything",
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        threadId: null,
        message: { ...validMessage, parts: [{ type: "image", url: "x" }] },
      }).success,
    ).toBe(false);
  });

  it("accepts a real cuid threadId and the regenerate trigger", () => {
    const parsed = requestSchema.safeParse({
      threadId: THREAD_ID,
      message: validMessage,
      trigger: "regenerate-message",
      messageId: "sdk-supplied-and-unused",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("constants (T1)", () => {
  it("pins the byte + shed budgets on threads.ts", () => {
    expect(MESSAGE_BUDGET_BYTES).toBe(24_576);
    expect(HISTORY_BUDGET_BYTES).toBe(98_304);
    expect(SHED_KEEP_TURNS).toBe(4);
  });

  it("pins the three time constants on timing.ts with 60 < 75 < 90", () => {
    expect(PROVIDER_TIMEOUT_MS).toBe(60_000);
    expect(FINALIZE_DEADLINE_MS).toBe(75_000);
    expect(CLAIM_STALE_MS).toBe(90_000);
    expect(PROVIDER_TIMEOUT_MS).toBeLessThan(FINALIZE_DEADLINE_MS);
    expect(FINALIZE_DEADLINE_MS).toBeLessThan(CLAIM_STALE_MS);
  });
});

describe("serializedBytes: the ONE canonical measurement", () => {
  it("measures the SERIALIZED representation, not the raw text (JSON-escape expansion)", () => {
    const raw = "\u0001".repeat(1_000);
    expect(raw.length).toBe(1_000);
    // Each control character serializes as the six-character escape \u0001.
    expect(serializedBytes({ text: raw })).toBeGreaterThan(6_000);
  });
});

describe("createAbortLatch (T1, two timers)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("starts unlatched and un-aborted", () => {
    const latch = createAbortLatch(new AbortController().signal);
    expect(latch.cause()).toBeNull();
    expect(latch.signal.aborted).toBe(false);
  });

  it("latches `client` synchronously at CONSTRUCTION for an already-aborted signal", () => {
    const controller = new AbortController();
    controller.abort();
    const latch = createAbortLatch(controller.signal);
    expect(latch.cause()).toBe("client");
    expect(latch.signal.aborted).toBe(true);
  });

  it("latches `client` and aborts the route controller on a later client disconnect", () => {
    const controller = new AbortController();
    const latch = createAbortLatch(controller.signal);
    controller.abort();
    expect(latch.cause()).toBe("client");
    expect(latch.signal.aborted).toBe(true);
  });

  it("T1 latches provider-timeout AND aborts BEFORE T2 fires onDeadline", () => {
    const controller = new AbortController();
    const latch = createAbortLatch(controller.signal);
    const onDeadline = jest.fn();
    latch.armTimers(onDeadline);

    jest.advanceTimersByTime(PROVIDER_TIMEOUT_MS);
    expect(latch.cause()).toBe("provider-timeout");
    expect(latch.signal.aborted).toBe(true);
    expect(onDeadline).not.toHaveBeenCalled();

    jest.advanceTimersByTime(FINALIZE_DEADLINE_MS - PROVIDER_TIMEOUT_MS);
    expect(onDeadline).toHaveBeenCalledTimes(1);
    expect(latch.cause()).toBe("provider-timeout");
  });

  it("is FIRST-SOURCE: a client disconnect after T1 does not overwrite provider-timeout", () => {
    const controller = new AbortController();
    const latch = createAbortLatch(controller.signal);
    latch.armTimers(jest.fn());

    jest.advanceTimersByTime(PROVIDER_TIMEOUT_MS);
    controller.abort();
    expect(latch.cause()).toBe("provider-timeout");
  });

  it("clearTimers() clears BOTH timers and drops the request listener", () => {
    const controller = new AbortController();
    const latch = createAbortLatch(controller.signal);
    const onDeadline = jest.fn();
    latch.armTimers(onDeadline);

    latch.clearTimers();
    jest.advanceTimersByTime(FINALIZE_DEADLINE_MS * 2);
    expect(onDeadline).not.toHaveBeenCalled();
    expect(latch.cause()).toBeNull();
    expect(latch.signal.aborted).toBe(false);

    controller.abort();
    expect(latch.cause()).toBeNull();
  });
});

describe("claimTurn (T2 / spec C2 step 2)", () => {
  beforeEach(armClaim);

  it("creates the thread when threadId is null and reports threadWasCreated", async () => {
    const result = await claimTurn({
      userId: USER_ID,
      threadId: null,
      message: userMessage(),
      trigger: "submit-message",
      membershipScope: ["c1", "c2"],
      providerKind: "OLLAMA",
      model: "gate-scripted",
    });

    expect(db.assistantThread.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { userId: USER_ID } }),
    );
    expect(result).toEqual({
      threadId: THREAD_ID,
      requestId: 901,
      threadWasCreated: true,
      supersededMessageIds: [],
    });
  });

  it("inserts the request row running/chat with the membership snapshot and a UTC dayKey", async () => {
    await claimTurn({
      userId: USER_ID,
      threadId: null,
      message: userMessage(),
      trigger: "submit-message",
      membershipScope: ["c1"],
      providerKind: "OLLAMA",
      model: "gate-scripted",
    });

    const data = db.assistantRequest.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      threadId: THREAD_ID,
      userId: USER_ID,
      kind: "chat",
      status: "running",
      providerKind: "OLLAMA",
      model: "gate-scripted",
      membershipScope: ["c1"],
    });
    expect(data.dayKey).toBe(new Date().toISOString().slice(0, 10));
  });

  it("404s NOT_FOUND when the ownership-scoped thread lock affects 0 rows", async () => {
    db.assistantThread.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      claimTurn({
        userId: USER_ID,
        threadId: THREAD_ID,
        message: userMessage(),
        trigger: "submit-message",
        membershipScope: [],
        providerKind: "OLLAMA",
        model: "m",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });

    expect(db.assistantRequest.create).not.toHaveBeenCalled();
  });

  it("409s THREAD_BUSY on a FRESH running chat request (backdated 1s)", async () => {
    armLiveRequestProbe(1_000);

    const err = await claimTurn({
      userId: USER_ID,
      threadId: THREAD_ID,
      message: userMessage(),
      trigger: "submit-message",
      membershipScope: [],
      providerKind: "OLLAMA",
      model: "m",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: "THREAD_BUSY", statusCode: 409 });
    expect(db.assistantRequest.create).not.toHaveBeenCalled();
    expect(db.assistantMessage.create).not.toHaveBeenCalled();
  });

  it("FENCES a BACKDATED (stale) running row as SUPERSEDED and proceeds", async () => {
    armLiveRequestProbe(CLAIM_STALE_MS + 1_000);

    const result = await claimTurn({
      userId: USER_ID,
      threadId: THREAD_ID,
      message: userMessage(),
      trigger: "submit-message",
      membershipScope: [],
      providerKind: "OLLAMA",
      model: "m",
    });

    expect(db.assistantRequest.updateMany).toHaveBeenCalledWith({
      where: { threadId: THREAD_ID, kind: "chat", status: "running" },
      data: { status: "error", errorCode: "SUPERSEDED" },
    });
    expect(result.requestId).toBe(901);
  });

  it("submit: inserts the user message at max(sequence)+1", async () => {
    await claimTurn({
      userId: USER_ID,
      threadId: THREAD_ID,
      message: userMessage({ id: "msg-new" }),
      trigger: "submit-message",
      membershipScope: [],
      providerKind: "OLLAMA",
      model: "m",
    });

    expect(db.assistantMessage.create).toHaveBeenCalledWith({
      data: {
        threadId: THREAD_ID,
        id: "msg-new",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
        sequence: 5,
      },
    });
  });

  it("submit: 409s CONFLICT on a duplicate message id in THIS thread", async () => {
    db.assistantMessage.findUnique.mockResolvedValue({ id: "msg-user-1", sequence: 3 });

    await expect(
      claimTurn({
        userId: USER_ID,
        threadId: THREAD_ID,
        message: userMessage(),
        trigger: "submit-message",
        membershipScope: [],
        providerKind: "OLLAMA",
        model: "m",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });

    expect(db.assistantMessage.create).not.toHaveBeenCalled();
  });

  describe("the four regenerate anchor cases (spec C4)", () => {
    const regen = () =>
      claimTurn({
        userId: USER_ID,
        threadId: THREAD_ID,
        message: userMessage({ id: "msg-anchor" }),
        trigger: "regenerate-message",
        membershipScope: [],
        providerKind: "OLLAMA",
        model: "m",
      });

    it("1. already persisted -> IDEMPOTENT (no insert, no 409)", async () => {
      db.assistantMessage.findUnique.mockResolvedValue({ sequence: 7 });

      const result = await regen();

      expect(db.assistantMessage.create).not.toHaveBeenCalled();
      expect(result.supersededMessageIds).toEqual([]);
    });

    it("2. genuinely new -> INSERTED at max+1 (the failed-submit retry)", async () => {
      db.assistantMessage.findUnique.mockResolvedValue(null);

      await regen();

      expect(db.assistantMessage.create).toHaveBeenCalledWith({
        data: {
          threadId: THREAD_ID,
          id: "msg-anchor",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
          sequence: 5,
        },
      });
      expect(db.assistantMessage.deleteMany).not.toHaveBeenCalled();
    });

    it("3. trailing assistant/system rows are SUPERSEDED and reported", async () => {
      db.assistantMessage.findUnique.mockResolvedValue({ sequence: 7 });
      db.assistantMessage.findMany.mockResolvedValue([{ id: "am-old-1" }, { id: "am-old-2" }]);
      db.assistantMessage.deleteMany.mockResolvedValue({ count: 2 });

      const result = await regen();

      expect(db.assistantMessage.deleteMany).toHaveBeenCalledWith({
        where: {
          threadId: THREAD_ID,
          role: { in: ["assistant", "system"] },
          sequence: { gt: 7 },
        },
      });
      expect(result.supersededMessageIds).toEqual(["am-old-1", "am-old-2"]);
    });

    it("4. a NEWER user row -> 409 CONFLICT and NOTHING is deleted", async () => {
      db.assistantMessage.findUnique.mockResolvedValue({ sequence: 7 });
      db.assistantMessage.findFirst.mockResolvedValue({ id: "msg-user-2" });

      await expect(regen()).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });

      expect(db.assistantMessage.deleteMany).not.toHaveBeenCalled();
      expect(db.assistantRequest.create).not.toHaveBeenCalled();
    });
  });
});

describe("loadBoundedHistory (T2 / spec C2 step 3)", () => {
  function row(over: Record<string, unknown>) {
    return { id: "m", role: "user", parts: [], metadata: null, sequence: 1, ...over };
  }

  function textTurn(seq: number, text: string) {
    return [
      row({ id: `u${seq}`, role: "user", sequence: seq, parts: [{ type: "text", text }] }),
      row({
        id: `a${seq}`,
        role: "assistant",
        sequence: seq + 1,
        parts: [{ type: "text", text: `answer ${seq}` }],
        metadata: { finishReason: "stop" },
      }),
    ];
  }

  beforeEach(() => {
    db.assistantThread.findFirst.mockResolvedValue({ id: THREAD_ID });
    db.assistantMessage.findFirst.mockResolvedValue(null);
  });

  it("404s NOT_FOUND for a thread the caller does not own", async () => {
    db.assistantThread.findFirst.mockResolvedValue(null);
    await expect(loadBoundedHistory(USER_ID, THREAD_ID)).rejects.toMatchObject({
      code: "NOT_FOUND",
      statusCode: 404,
    });
  });

  it("returns messages ASCENDING with metadata, no omission note when nothing was dropped", async () => {
    db.assistantMessage.findMany.mockResolvedValue([...textTurn(1, "first")].reverse());

    const messages = await loadBoundedHistory(USER_ID, THREAD_ID);

    expect(messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(messages[1].metadata).toEqual({ finishReason: "stop" });
    expect(JSON.stringify(messages)).not.toContain(HISTORY_OMISSION_NOTE);
  });

  it("tail-pages DESC in pages of 20 using a sequence cursor", async () => {
    const all = Array.from({ length: 25 }, (_, i) =>
      row({ id: `m${25 - i}`, role: "user", sequence: 25 - i, parts: [{ type: "text", text: "x" }] }),
    );
    db.assistantMessage.findMany
      .mockResolvedValueOnce(all.slice(0, 20))
      .mockResolvedValueOnce(all.slice(20));

    await loadBoundedHistory(USER_ID, THREAD_ID);

    expect(db.assistantMessage.findMany).toHaveBeenCalledTimes(2);
    const first = db.assistantMessage.findMany.mock.calls[0][0];
    expect(first).toMatchObject({ orderBy: { sequence: "desc" }, take: 20 });
    expect(first.where.sequence).toBeUndefined();
    expect(db.assistantMessage.findMany.mock.calls[1][0].where.sequence).toEqual({ lt: 6 });
  });

  it("SHEDS tool outputs outside the last SHED_KEEP_TURNS turns and keeps recent ones intact", async () => {
    const turns: Record<string, unknown>[] = [];
    for (let t = 0; t < SHED_KEEP_TURNS + 2; t++) {
      const seq = t * 2 + 1;
      turns.push(
        row({ id: `u${t}`, role: "user", sequence: seq, parts: [{ type: "text", text: `q${t}` }] }),
        row({
          id: `a${t}`,
          role: "assistant",
          sequence: seq + 1,
          parts: [
            {
              type: "tool-inventory_overview",
              toolCallId: `call-${t}`,
              state: "output-available",
              input: {},
              output: { rows: [`payload-${t}`] },
            },
          ],
        }),
      );
    }
    db.assistantMessage.findMany.mockResolvedValue([...turns].reverse());

    const messages = await loadBoundedHistory(USER_ID, THREAD_ID);

    const outputs = messages
      .filter((m) => m.role === "assistant")
      .map((m) => (m.parts[0] as { output: unknown }).output);
    // Two oldest turns shed; the last SHED_KEEP_TURNS keep their real outputs.
    expect(outputs.slice(0, 2)).toEqual([TOOL_OUTPUT_OMITTED, TOOL_OUTPUT_OMITTED]);
    expect(outputs.slice(2)).toEqual([
      { rows: ["payload-2"] },
      { rows: ["payload-3"] },
      { rows: ["payload-4"] },
      { rows: ["payload-5"] },
    ]);
  });

  it("drops WHOLE OLDEST TURNS on the SERIALIZED byte budget (JSON-escape expansion case)", async () => {
    // Raw text totals ~60 KB (under the 96 KiB budget) but each control character
    // serializes to a six-character escape, so the SERIALIZED history is ~360 KB.
    const control = "\u0001".repeat(12_000);
    const turns = [...textTurn(1, control), ...textTurn(3, control), ...textTurn(5, control)];
    const rawChars = turns.reduce(
      (n, r) => n + (r.parts as { text: string }[]).reduce((s, p) => s + p.text.length, 0),
      0,
    );
    expect(rawChars).toBeLessThan(HISTORY_BUDGET_BYTES);
    expect(serializedBytes(turns.map((r) => r.parts))).toBeGreaterThan(HISTORY_BUDGET_BYTES);

    db.assistantMessage.findMany.mockResolvedValue([...turns].reverse());

    const messages = await loadBoundedHistory(USER_ID, THREAD_ID);

    expect(messages[0].role).toBe("system");
    expect(JSON.stringify(messages[0].parts)).toContain(HISTORY_OMISSION_NOTE);
    expect(messages.map((m) => m.id)).toEqual(["system-history-omission", "u5", "a5"]);
    expect(serializedBytes(messages)).toBeLessThanOrEqual(HISTORY_BUDGET_BYTES);
  });

  it("NEVER drops the current turn, even when it alone exceeds the budget", async () => {
    const huge = "z".repeat(HISTORY_BUDGET_BYTES + 10_000);
    const turns = [...textTurn(1, "small"), ...textTurn(3, huge)];
    db.assistantMessage.findMany.mockResolvedValue([...turns].reverse());

    const messages = await loadBoundedHistory(USER_ID, THREAD_ID);

    expect(messages.map((m) => m.id)).toEqual(["system-history-omission", "u3", "a3"]);
    expect(serializedBytes(messages)).toBeGreaterThan(HISTORY_BUDGET_BYTES);
  });

  it("prepends the omission note when the tail page did not reach the thread start", async () => {
    const page = Array.from({ length: 20 }, (_, i) =>
      row({
        id: `m${20 - i}`,
        role: i % 2 === 0 ? "assistant" : "user",
        sequence: 20 - i,
        parts: [{ type: "text", text: "x".repeat(6_000) }],
      }),
    );
    db.assistantMessage.findMany.mockResolvedValue(page);
    db.assistantMessage.findFirst.mockResolvedValue({ sequence: 1 });

    const messages = await loadBoundedHistory(USER_ID, THREAD_ID);

    expect(messages[0].id).toBe("system-history-omission");
  });
});

describe("finalizeTurn (T2 / spec C4)", () => {
  const assistantMessage = (parts: unknown[], metadata?: unknown) =>
    ({ id: "am-1", role: "assistant", parts, metadata }) as never;

  const baseInput = {
    requestId: 901,
    threadId: THREAD_ID,
    message: null,
    cause: null,
    eventAborted: false,
    errorLatched: null,
    usage: null,
    durationMs: 1_234,
  } as const;

  beforeEach(() => {
    db.assistantRequest.updateMany.mockResolvedValue({ count: 1 });
    db.assistantMessage.aggregate.mockResolvedValue({ _max: { sequence: 5 } });
    db.assistantMessage.create.mockResolvedValue({});
    db.assistantThread.updateMany.mockResolvedValue({ count: 1 });
  });

  it("FENCE: 0 rows aborts the ENTIRE finalize (no assistant insert, no thread touch)", async () => {
    db.assistantRequest.updateMany.mockResolvedValue({ count: 0 });

    const result = await finalizeTurn({
      ...baseInput,
      message: assistantMessage([{ type: "text", text: "stale zombie output" }]),
    });

    expect(result).toEqual({ finalized: false, status: null });
    expect(db.assistantMessage.create).not.toHaveBeenCalled();
    expect(db.assistantThread.updateMany).not.toHaveBeenCalled();
  });

  it("the fence is the FIRST statement and is scoped to status running", async () => {
    await finalizeTurn(baseInput);

    expect(db.assistantRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 901, status: "running" },
      data: expect.objectContaining({ status: "ok", durationMs: 1_234 }),
    });
  });

  it("SANITIZE-THEN-PREDICATE: an incomplete-tool-only message persists NO row", async () => {
    const result = await finalizeTurn({
      ...baseInput,
      message: assistantMessage([
        { type: "step-start" },
        {
          type: "tool-inventory_overview",
          toolCallId: "c1",
          state: "input-available",
          input: { a: 1 },
        },
      ]),
    });

    expect(result).toEqual({ finalized: true, status: "ok" });
    expect(db.assistantMessage.create).not.toHaveBeenCalled();
    expect(db.assistantThread.updateMany).toHaveBeenCalled();
  });

  it("persists the SANITIZED parts (incomplete tool parts stripped) plus metadata", async () => {
    await finalizeTurn({
      ...baseInput,
      message: assistantMessage(
        [
          { type: "step-start" },
          { type: "tool-x", toolCallId: "c1", state: "input-streaming", input: {} },
          { type: "tool-y", toolCallId: "c2", state: "output-available", input: {}, output: { ok: 1 } },
          { type: "text", text: "here you go" },
        ],
        { finishReason: "stop", threadId: THREAD_ID },
      ),
    });

    const data = db.assistantMessage.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ threadId: THREAD_ID, id: "am-1", role: "assistant", sequence: 6 });
    expect(data.parts).toEqual([
      { type: "step-start" },
      { type: "tool-y", toolCallId: "c2", state: "output-available", input: {}, output: { ok: 1 } },
      { type: "text", text: "here you go" },
    ]);
    // threadId is stream plumbing, not persisted turn metadata (T0 shape).
    expect(data.metadata).toEqual({ finishReason: "stop" });
  });

  it("a terminal-state tool part alone is meaningful content", async () => {
    await finalizeTurn({
      ...baseInput,
      message: assistantMessage([
        { type: "tool-y", toolCallId: "c2", state: "output-available", input: {}, output: 7 },
      ]),
    });

    expect(db.assistantMessage.create).toHaveBeenCalled();
  });

  it("a tool part that SURVIVES sanitize but is not terminal is not meaningful content", async () => {
    // Sanitize strips only input-streaming/input-available; an approval-requested
    // part therefore reaches the predicate, which must still refuse it. This is the
    // half of the belt the sanitize order cannot cover.
    await finalizeTurn({
      ...baseInput,
      message: assistantMessage([
        { type: "step-start" },
        {
          type: "tool-y",
          toolCallId: "c2",
          state: "approval-requested",
          input: {},
          approval: { id: "ap-1" },
        },
      ]),
    });

    expect(db.assistantMessage.create).not.toHaveBeenCalled();
  });

  it("an empty-text-only message is NOT meaningful content", async () => {
    await finalizeTurn({ ...baseInput, message: assistantMessage([{ type: "text", text: "   " }]) });
    expect(db.assistantMessage.create).not.toHaveBeenCalled();
  });

  describe("the abort-cause classification table", () => {
    it("cause `client` -> aborted (+ metadata.aborted on the partial)", async () => {
      const result = await finalizeTurn({
        ...baseInput,
        cause: "client",
        message: assistantMessage([{ type: "text", text: "partial" }]),
      });

      expect(result).toEqual({ finalized: true, status: "aborted" });
      expect(db.assistantRequest.updateMany.mock.calls[0][0].data).toMatchObject({
        status: "aborted",
        errorCode: null,
      });
      expect(db.assistantMessage.create.mock.calls[0][0].data.metadata).toEqual({ aborted: true });
    });

    it("cause `provider-timeout` -> error/PROVIDER_TIMEOUT", async () => {
      const result = await finalizeTurn({
        ...baseInput,
        cause: "provider-timeout",
        message: assistantMessage([{ type: "text", text: "partial" }]),
      });

      expect(result).toEqual({ finalized: true, status: "error" });
      expect(db.assistantRequest.updateMany.mock.calls[0][0].data).toMatchObject({
        status: "error",
        errorCode: "PROVIDER_TIMEOUT",
      });
      expect(db.assistantMessage.create.mock.calls[0][0].data.metadata).toEqual({
        errorCode: "PROVIDER_TIMEOUT",
      });
    });

    it("no cause + eventAborted -> error/PROVIDER_TIMEOUT (never user-aborted)", async () => {
      const result = await finalizeTurn({ ...baseInput, eventAborted: true });

      expect(result).toEqual({ finalized: true, status: "error" });
      expect(db.assistantRequest.updateMany.mock.calls[0][0].data).toMatchObject({
        status: "error",
        errorCode: "PROVIDER_TIMEOUT",
      });
    });

    it("errorLatched -> error/<masked code>", async () => {
      await finalizeTurn({ ...baseInput, errorLatched: "TOOL_ERROR" });

      expect(db.assistantRequest.updateMany.mock.calls[0][0].data).toMatchObject({
        status: "error",
        errorCode: "TOOL_ERROR",
      });
    });

    it("a latched cause OUTRANKS a latched error code", async () => {
      await finalizeTurn({ ...baseInput, cause: "provider-timeout", errorLatched: "PROVIDER_ERROR" });

      expect(db.assistantRequest.updateMany.mock.calls[0][0].data).toMatchObject({
        errorCode: "PROVIDER_TIMEOUT",
      });
    });

    it("nothing latched -> ok", async () => {
      const result = await finalizeTurn(baseInput);
      expect(result).toEqual({ finalized: true, status: "ok" });
    });
  });

  it("writes usage EXACTLY as reported: undefined -> NULL, never 0", async () => {
    await finalizeTurn({
      ...baseInput,
      usage: { inputTokens: undefined, outputTokens: 12, totalTokens: undefined },
    });

    expect(db.assistantRequest.updateMany.mock.calls[0][0].data).toMatchObject({
      inputTokens: null,
      outputTokens: 12,
      totalTokens: null,
    });
  });

  it("a null usage triple writes three NULLs", async () => {
    await finalizeTurn(baseInput);
    expect(db.assistantRequest.updateMany.mock.calls[0][0].data).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
  });

  it("FK-failure fallback: finalizes the request row ALONE when the tx fails", async () => {
    db.assistantMessage.create.mockRejectedValue(new Error("FK constraint failed"));

    const result = await finalizeTurn({
      ...baseInput,
      message: assistantMessage([{ type: "text", text: "answer" }]),
    });

    expect(result).toEqual({ finalized: true, status: "ok" });
    expect(db.assistantRequest.updateMany).toHaveBeenCalledTimes(2);
    expect(db.assistantRequest.updateMany.mock.calls[1][0]).toEqual({
      where: { id: 901, status: "running" },
      data: expect.objectContaining({ status: "ok" }),
    });
  });

  it("FK-failure fallback still honours the fence", async () => {
    db.assistantRequest.updateMany.mockResolvedValue({ count: 0 });
    db.assistantMessage.create.mockRejectedValue(new Error("boom"));
    db.assistantRequest.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const result = await finalizeTurn({
      ...baseInput,
      message: assistantMessage([{ type: "text", text: "answer" }]),
    });

    expect(result).toEqual({ finalized: false, status: null });
  });
});

describe("deleteThreadGuarded (T2 / spec C5)", () => {
  beforeEach(() => {
    db.assistantThread.updateMany.mockResolvedValue({ count: 1 });
    db.assistantThread.delete.mockResolvedValue({});
    db.assistantRequest.findFirst.mockResolvedValue(null);
  });

  it("404s NOT_FOUND for a foreign thread", async () => {
    db.assistantThread.updateMany.mockResolvedValue({ count: 0 });
    await expect(deleteThreadGuarded(USER_ID, THREAD_ID)).rejects.toMatchObject({
      code: "NOT_FOUND",
      statusCode: 404,
    });
    expect(db.assistantThread.delete).not.toHaveBeenCalled();
  });

  it("409s THREAD_BUSY while a live chat request is running", async () => {
    armLiveRequestProbe(1_000);
    await expect(deleteThreadGuarded(USER_ID, THREAD_ID)).rejects.toMatchObject({
      code: "THREAD_BUSY",
      statusCode: 409,
    });
    expect(db.assistantThread.delete).not.toHaveBeenCalled();
  });

  it("a stale (backdated) running row does NOT block the delete", async () => {
    armLiveRequestProbe(CLAIM_STALE_MS + 1_000);
    await deleteThreadGuarded(USER_ID, THREAD_ID);
    expect(db.assistantThread.delete).toHaveBeenCalledWith({ where: { id: THREAD_ID } });
  });
});

describe("jest.setup global-mock surfaces (S13 / pack T12)", () => {
  it("exports __mockTx whose delegates ARE the top-level client delegates", () => {
    expect(mockTx.assistantThread).toBe(db.assistantThread);
    expect(mockTx.assistantMessage).toBe(db.assistantMessage);
    expect(mockTx.assistantRequest).toBe(db.assistantRequest);
    expect(mockTx.assistantEvalReport).toBe(db.assistantEvalReport);
    expect(mockTx.assistantRun).toBe(db.assistantRun);
    expect(mockTx.user).toBe(db.user);
    expect(mockTx.userCompany).toBe(db.userCompany);
  });

  it("$transaction drives a callback with __mockTx and Promise.all's an array", async () => {
    await expect(db.$transaction(async (tx: unknown) => tx)).resolves.toBe(mockTx);
    await expect(db.$transaction([Promise.resolve(1), Promise.resolve(2)])).resolves.toEqual([1, 2]);
  });
});
