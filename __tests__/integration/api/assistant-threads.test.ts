// @jest-environment node
//
// Task 1.3 — the thread routes (spec C5; contract pack T0/T2, seams S0/S2/S13/S16).
//
// What is under test is the ROUTE's contract, not the persistence module's: the
// G1 ownership posture (a foreign thread is indistinguishable from a missing one),
// the exact T0 response shapes, the pagination arithmetic, the >90s hung-row
// disclosure, and the guard order on DELETE.
//
// Prisma is the GLOBAL jest.setup mock (design D2), but the delegates here are
// armed with a tiny FAKE STORE rather than fixed return values: a `findFirst` that
// ignores `where.userId` would happily hand back another user's thread, and only a
// store that honors the WHERE can tell the difference. Same for staleness — the
// request delegate evaluates `createdAt.gt` against the seeded row, so the >90s
// case is decided by the route's own cutoff arithmetic (design D7: BACKDATE, never
// sleep).
//
// `deleteThreadGuarded` runs FOR REAL against that store (it is not mocked): the
// route's job is to surface its THREAD_BUSY/NOT_FOUND vocabulary as JSON, and
// stubbing it would assert nothing about the surfacing. Its internals are pinned
// separately in __tests__/unit/lib/assistant/threads.test.ts.

// --- guards ----------------------------------------------------------------
jest.mock("@/lib/api-utils", () => ({
  ...jest.requireActual("@/lib/api-utils"),
  requireApproved: jest.fn(),
}));
jest.mock("@/lib/csrf", () => ({ validateCSRFToken: jest.fn(() => Promise.resolve(true)) }));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireApproved } from "@/lib/api-utils";
import { validateCSRFToken } from "@/lib/csrf";
import { AppError } from "@/lib/error-handling";
import { CLAIM_STALE_MS } from "@/lib/assistant/timing";
import { GET as listThreads } from "@/app/api/assistant/threads/route";
import { GET as getThread, DELETE as deleteThread } from "@/app/api/assistant/threads/[id]/route";

/* eslint-disable @typescript-eslint/no-explicit-any */

const db = prisma as unknown as Record<string, any>;
const approvedMock = requireApproved as jest.Mock;
const csrfMock = validateCSRFToken as jest.Mock;

const CALLER = 7;
const OTHER_USER = 8;
const NOW = new Date("2026-08-10T12:00:00.000Z");
const OWN_THREAD = "cthread0000000000000001";
const FOREIGN_THREAD = "cthread0000000000000002";
const MISSING_THREAD = "cthread0000000000000404";

type ThreadRow = {
  id: string;
  userId: number;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
};
type MessageRow = {
  threadId: string;
  id: string;
  role: string;
  parts: unknown;
  metadata: unknown;
  sequence: number;
};
type RequestRow = {
  id: number;
  threadId: string;
  kind: string;
  status: string;
  createdAt: Date;
};

let threads: ThreadRow[] = [];
let messages: MessageRow[] = [];
let requests: RequestRow[] = [];

function thread(over: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: OWN_THREAD,
    userId: CALLER,
    title: "Stock questions",
    createdAt: new Date(NOW.getTime() - 60_000),
    updatedAt: new Date(NOW.getTime() - 30_000),
    ...over,
  };
}

/** The subset of prisma WHERE semantics these routes actually use. */
function matchesThreadWhere(row: ThreadRow, where: any): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  return true;
}

function matchesRequestWhere(row: RequestRow, where: any): boolean {
  if (where.threadId !== undefined && row.threadId !== where.threadId) return false;
  if (where.kind !== undefined && row.kind !== where.kind) return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  if (where.createdAt?.gt !== undefined && !(row.createdAt.getTime() > where.createdAt.gt.getTime())) {
    return false;
  }
  return true;
}

/** Arm every delegate the two routes (and the real `deleteThreadGuarded`) touch. */
function armStore(): void {
  db.assistantThread.findMany.mockImplementation(async (args: any) => {
    const rows = threads
      .filter((t) => matchesThreadWhere(t, args.where ?? {}))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    const skip = args.skip ?? 0;
    return rows.slice(skip, skip + (args.take ?? rows.length));
  });
  db.assistantThread.findFirst.mockImplementation(
    async (args: any) => threads.find((t) => matchesThreadWhere(t, args.where ?? {})) ?? null,
  );
  db.assistantThread.updateMany.mockImplementation(async (args: any) => {
    const hit = threads.filter((t) => matchesThreadWhere(t, args.where ?? {}));
    for (const row of hit) Object.assign(row, args.data ?? {});
    return { count: hit.length };
  });
  db.assistantThread.delete.mockImplementation(async (args: any) => {
    const row = threads.find((t) => t.id === args.where.id);
    threads = threads.filter((t) => t.id !== args.where.id);
    return row ?? null;
  });
  db.assistantMessage.findMany.mockImplementation(async (args: any) => {
    const rows = messages.filter((m) => m.threadId === args.where.threadId);
    if (args.orderBy?.sequence === "asc") rows.sort((a, b) => a.sequence - b.sequence);
    return rows;
  });
  db.assistantMessage.groupBy.mockImplementation(async (args: any) => {
    const ids: string[] = args.where?.threadId?.in ?? [];
    const counts = new Map<string, number>();
    for (const m of messages) {
      if (!ids.includes(m.threadId)) continue;
      counts.set(m.threadId, (counts.get(m.threadId) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([threadId, n]) => ({
      threadId,
      _count: { _all: n },
    }));
  });
  db.assistantRequest.findFirst.mockImplementation(
    async (args: any) => requests.find((r) => matchesRequestWhere(r, args.where ?? {})) ?? null,
  );
}

function listReq(query = ""): NextRequest {
  return new NextRequest(`http://x/api/assistant/threads${query}`);
}

function detailReq(method: "GET" | "DELETE", id: string): NextRequest {
  return new NextRequest(`http://x/api/assistant/threads/${id}`, {
    method,
    headers: { "x-csrf-token": "t" },
  });
}

const ctx = (id: string) => ({ params: { id } });

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  jest.clearAllMocks(); // NEVER resetAllMocks: it would drop $transaction's default (pack T12)
  threads = [];
  messages = [];
  requests = [];
  armStore();
  approvedMock.mockResolvedValue({ user: { id: CALLER, isAdmin: false } });
  csrfMock.mockResolvedValue(true);
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// G1 — ownership is server-derived, absolute, and anti-enumerating
// ---------------------------------------------------------------------------

describe("G1: a foreign thread is byte-identical to a missing one", () => {
  test("GET detail: nonexistent and foreign-owned produce the SAME 404 body", async () => {
    threads = [thread({ id: FOREIGN_THREAD, userId: OTHER_USER })];

    const missing = await getThread(detailReq("GET", MISSING_THREAD), ctx(MISSING_THREAD));
    const foreign = await getThread(detailReq("GET", FOREIGN_THREAD), ctx(FOREIGN_THREAD));

    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    const missingBody = await missing.text();
    expect(await foreign.text()).toBe(missingBody);
    expect(JSON.parse(missingBody)).toEqual({ error: "Thread not found", code: "NOT_FOUND" });
  });

  test("GET detail derives the owner from the session, never the request", async () => {
    threads = [thread({ id: FOREIGN_THREAD, userId: OTHER_USER })];
    await getThread(detailReq("GET", FOREIGN_THREAD), ctx(FOREIGN_THREAD));
    expect(db.assistantThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: FOREIGN_THREAD, userId: CALLER } }),
    );
    // The 404 short-circuits: no message or request read leaks work about a
    // thread the caller does not own.
    expect(db.assistantMessage.findMany).not.toHaveBeenCalled();
    expect(db.assistantRequest.findFirst).not.toHaveBeenCalled();
  });

  test("DELETE: nonexistent and foreign-owned produce the SAME 404 body, and delete nothing", async () => {
    threads = [thread({ id: FOREIGN_THREAD, userId: OTHER_USER })];

    const missing = await deleteThread(detailReq("DELETE", MISSING_THREAD), ctx(MISSING_THREAD));
    const foreign = await deleteThread(detailReq("DELETE", FOREIGN_THREAD), ctx(FOREIGN_THREAD));

    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).toBe(await missing.text());
    expect(db.assistantThread.delete).not.toHaveBeenCalled();
    expect(threads).toHaveLength(1);
  });

  test("unapproved callers never reach the database", async () => {
    approvedMock.mockRejectedValue(new AppError("Account pending approval", "FORBIDDEN", 403));
    const list = await listThreads(listReq());
    const detail = await getThread(detailReq("GET", OWN_THREAD), ctx(OWN_THREAD));
    expect(list.status).toBe(403);
    expect(detail.status).toBe(403);
    expect(db.assistantThread.findMany).not.toHaveBeenCalled();
    expect(db.assistantThread.findFirst).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/assistant/threads — scoping, shape, pagination
// ---------------------------------------------------------------------------

describe("GET list", () => {
  test("queries the caller's rows only, newest-updated first", async () => {
    threads = [
      thread({ id: "t-old", updatedAt: new Date(NOW.getTime() - 90_000) }),
      thread({ id: "t-new", updatedAt: new Date(NOW.getTime() - 10_000) }),
      thread({ id: "t-foreign", userId: OTHER_USER }),
    ];

    const res = await listThreads(listReq());
    const body = await res.json();

    expect(db.assistantThread.findMany).toHaveBeenCalledTimes(1);
    const args = db.assistantThread.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ userId: CALLER });
    expect(args.orderBy).toEqual({ updatedAt: "desc" });
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["t-new", "t-old"]);
  });

  test("returns the exact T0 ThreadListResponse shape (ISO dates, no extra keys)", async () => {
    threads = [thread()];
    messages = [
      { threadId: OWN_THREAD, id: "m1", role: "user", parts: [], metadata: null, sequence: 1 },
      { threadId: OWN_THREAD, id: "m2", role: "assistant", parts: [], metadata: null, sequence: 2 },
    ];

    const res = await listThreads(listReq());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      items: [
        {
          id: OWN_THREAD,
          title: "Stock questions",
          createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
          updatedAt: new Date(NOW.getTime() - 30_000).toISOString(),
          messageCount: 2,
        },
      ],
      limit: 20,
      offset: 0,
      nextOffset: null,
    });
  });

  test("a null title stays null (never coerced to a placeholder string)", async () => {
    threads = [thread({ title: null })];
    const body = await (await listThreads(listReq())).json();
    expect(body.items[0].title).toBeNull();
  });

  test("messageCount comes from ONE grouped count, never per-thread queries", async () => {
    threads = [thread({ id: "t-a" }), thread({ id: "t-b" })];
    messages = [
      { threadId: "t-a", id: "m1", role: "user", parts: [], metadata: null, sequence: 1 },
    ];

    const body = await (await listThreads(listReq())).json();

    expect(db.assistantMessage.groupBy).toHaveBeenCalledTimes(1);
    const args = db.assistantMessage.groupBy.mock.calls[0][0];
    expect(args.by).toEqual(["threadId"]);
    expect(args.where.threadId.in.sort()).toEqual(["t-a", "t-b"]);
    expect(db.assistantMessage.count).not.toHaveBeenCalled();
    expect(db.assistantMessage.findMany).not.toHaveBeenCalled();
    // A thread with no rows in the grouped result counts 0 — it genuinely has none.
    const counts = Object.fromEntries(
      body.items.map((i: { id: string; messageCount: number }) => [i.id, i.messageCount]),
    );
    expect(counts).toEqual({ "t-a": 1, "t-b": 0 });
  });

  test("defaults: limit 20 / offset 0, over-fetching exactly one row to detect a next page", async () => {
    await listThreads(listReq());
    const args = db.assistantThread.findMany.mock.calls[0][0];
    expect(args.take).toBe(21);
    expect(args.skip).toBe(0);
  });

  test("nextOffset is offset + items.length when more rows exist, null at the end", async () => {
    threads = Array.from({ length: 5 }, (_, i) =>
      thread({ id: `t-${i}`, updatedAt: new Date(NOW.getTime() - i * 1_000) }),
    );

    const page1 = await (await listThreads(listReq("?limit=2"))).json();
    expect(page1.items).toHaveLength(2);
    expect(page1).toMatchObject({ limit: 2, offset: 0, nextOffset: 2 });

    const page3 = await (await listThreads(listReq("?limit=2&offset=4"))).json();
    expect(page3.items).toHaveLength(1);
    expect(page3).toMatchObject({ limit: 2, offset: 4, nextOffset: null });
  });

  test("limit clamps at 50 (a valid oversized page is bounded, not rejected)", async () => {
    const body = await (await listThreads(listReq("?limit=100"))).json();
    expect(body.limit).toBe(50);
    expect(db.assistantThread.findMany.mock.calls[0][0].take).toBe(51);
  });

  test.each([
    ["?limit=abc", "non-numeric limit"],
    ["?limit=0", "limit below 1"],
    ["?limit=1.5", "fractional limit"],
    ["?offset=-1", "negative offset"],
    ["?offset=oops", "non-numeric offset"],
  ])("garbage query %s => 400 VALIDATION_ERROR, no query runs (%s)", async (query) => {
    const res = await listThreads(listReq(query));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION_ERROR");
    expect(db.assistantThread.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/assistant/threads/[id] — messages + activeRequest
// ---------------------------------------------------------------------------

describe("GET detail", () => {
  test("returns the exact T0 ThreadDetailResponse shape, messages in sequence order", async () => {
    threads = [thread()];
    messages = [
      {
        threadId: OWN_THREAD,
        id: "m2",
        role: "assistant",
        parts: [{ type: "text", text: "answer" }],
        metadata: { finishReason: "stop" },
        sequence: 2,
      },
      {
        threadId: OWN_THREAD,
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "question" }],
        metadata: null,
        sequence: 1,
      },
    ];

    const res = await getThread(detailReq("GET", OWN_THREAD), ctx(OWN_THREAD));

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(db.assistantMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { threadId: OWN_THREAD },
        orderBy: { sequence: "asc" },
      }),
    );
    expect(await res.json()).toEqual({
      id: OWN_THREAD,
      title: "Stock questions",
      messages: [
        { id: "m1", role: "user", parts: [{ type: "text", text: "question" }], metadata: null },
        {
          id: "m2",
          role: "assistant",
          parts: [{ type: "text", text: "answer" }],
          metadata: { finishReason: "stop" },
        },
      ],
      activeRequest: null,
    });
  });

  test("SQL NULL metadata surfaces as null, never as {} (a stopped turn must stay stopped)", async () => {
    threads = [thread()];
    messages = [
      { threadId: OWN_THREAD, id: "m1", role: "user", parts: [], metadata: null, sequence: 1 },
      {
        threadId: OWN_THREAD,
        id: "m2",
        role: "assistant",
        parts: [],
        metadata: { aborted: true },
        sequence: 2,
      },
    ];
    const body = await (await getThread(detailReq("GET", OWN_THREAD), ctx(OWN_THREAD))).json();
    expect(body.messages[0].metadata).toBeNull();
    expect(body.messages[1].metadata).toEqual({ aborted: true });
  });

  test("an empty thread returns an empty message list, not a 404", async () => {
    threads = [thread()];
    const res = await getThread(detailReq("GET", OWN_THREAD), ctx(OWN_THREAD));
    expect(res.status).toBe(200);
    expect((await res.json()).messages).toEqual([]);
  });

  test("a LIVE running chat request surfaces as activeRequest", async () => {
    threads = [thread()];
    requests = [
      {
        id: 1,
        threadId: OWN_THREAD,
        kind: "chat",
        status: "running",
        createdAt: new Date(NOW.getTime() - 5_000),
      },
    ];
    const body = await (await getThread(detailReq("GET", OWN_THREAD), ctx(OWN_THREAD))).json();
    expect(body.activeRequest).toEqual({ status: "running" });

    const where = db.assistantRequest.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ threadId: OWN_THREAD, kind: "chat", status: "running" });
    // The lease boundary is CLAIM_STALE_MS from timing.ts — not a local literal.
    expect(where.createdAt.gt).toEqual(new Date(NOW.getTime() - CLAIM_STALE_MS));
  });

  test("a HUNG running row older than the lease surfaces NOTHING (spec C5 disclosure)", async () => {
    threads = [thread()];
    requests = [
      {
        id: 1,
        threadId: OWN_THREAD,
        kind: "chat",
        status: "running",
        // Backdated past the 90s lease (design D7 — no sleeps anywhere).
        createdAt: new Date(NOW.getTime() - CLAIM_STALE_MS - 1_000),
      },
    ];
    const body = await (await getThread(detailReq("GET", OWN_THREAD), ctx(OWN_THREAD))).json();
    expect(body.activeRequest).toBeNull();
  });

  test("a running TITLE request is not a live chat turn", async () => {
    threads = [thread()];
    requests = [
      {
        id: 1,
        threadId: OWN_THREAD,
        kind: "title",
        status: "running",
        createdAt: new Date(NOW.getTime() - 1_000),
      },
    ];
    const body = await (await getThread(detailReq("GET", OWN_THREAD), ctx(OWN_THREAD))).json();
    expect(body.activeRequest).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/assistant/threads/[id] — CSRF + claim-aware guard
// ---------------------------------------------------------------------------

describe("DELETE", () => {
  test("deletes an idle thread and answers { deleted: true }", async () => {
    threads = [thread()];
    const res = await deleteThread(detailReq("DELETE", OWN_THREAD), ctx(OWN_THREAD));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(db.assistantThread.delete).toHaveBeenCalledWith({ where: { id: OWN_THREAD } });
    expect(threads).toHaveLength(0);
  });

  test("a live streaming turn => 409 THREAD_BUSY as plain JSON, nothing deleted", async () => {
    threads = [thread()];
    requests = [
      {
        id: 1,
        threadId: OWN_THREAD,
        kind: "chat",
        status: "running",
        createdAt: new Date(NOW.getTime() - 5_000),
      },
    ];

    const res = await deleteThread(detailReq("DELETE", OWN_THREAD), ctx(OWN_THREAD));

    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "Stop the response first", code: "THREAD_BUSY" });
    expect(db.assistantThread.delete).not.toHaveBeenCalled();
  });

  test("a HUNG turn older than the lease does not block deletion", async () => {
    threads = [thread()];
    requests = [
      {
        id: 1,
        threadId: OWN_THREAD,
        kind: "chat",
        status: "running",
        createdAt: new Date(NOW.getTime() - CLAIM_STALE_MS - 1_000),
      },
    ];
    const res = await deleteThread(detailReq("DELETE", OWN_THREAD), ctx(OWN_THREAD));
    expect(res.status).toBe(200);
    expect(db.assistantThread.delete).toHaveBeenCalled();
  });

  test("missing/invalid CSRF => 403 CSRF_INVALID BEFORE any delete work", async () => {
    threads = [thread()];
    csrfMock.mockResolvedValue(false);

    const res = await deleteThread(detailReq("DELETE", OWN_THREAD), ctx(OWN_THREAD));

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("CSRF_INVALID");
    expect(db.assistantThread.updateMany).not.toHaveBeenCalled();
    expect(db.assistantThread.delete).not.toHaveBeenCalled();
    expect(threads).toHaveLength(1);
  });
});
