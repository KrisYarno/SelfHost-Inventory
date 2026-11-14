// @jest-environment node
//
// P2-B3-2 (contract pack § P2-B3-2, C2-2) — THE ADJUST ROUTE'S COUNT ARM.
//
// `intent: 'count'` used to parse through the request truth table and stop at
// the route's guard with "this intent is not available yet". It now dispatches
// to `countResponse` (app/api/inventory/adjust/count.ts), which reads the
// product and the location OUTSIDE the transaction, mints a batch id, runs the
// count core inside `withDeadlockRetry(() => $transaction(…, STOCK_TX_OPTIONS))`
// and files ONE `INVENTORY_ADJUSTMENT` event through the `onRecord` it hands
// the core. `correction` still parses and is still refused.
//
// THE SEAM: `@/lib/inventory/count` is mocked. The core's own decisions (the
// prelock, the version, the COUNT/COUNT row) are its unit suite's
// (__tests__/unit/lib/inventory/count.test.ts) and the gate's (scenario 16).
// What this suite owns is the ROUTE's half: what it hands the core, what it
// answers on the wire, and the event its `onRecord` writes — captured from the
// mocked core's call and invoked here with a recording `tx`, so the REAL
// `recordChange` builds the row the database would receive.
import { mockDeep, type DeepMockProxy } from "jest-mock-extended";

jest.mock("@/lib/api-utils", () => ({
  ...jest.requireActual("@/lib/api-utils"),
  requireApproved: jest.fn(),
  requireCSRF: jest.fn(),
}));
jest.mock("@/lib/rateLimit", () => ({
  ...jest.requireActual("@/lib/rateLimit"),
  enforceRateLimit: jest.fn(),
}));
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: mockDeep() }));
jest.mock("@/lib/inventory/count");
// The T7 mapper, the attempt writer and the retry helper are WRAPPED, never
// replaced: the route keeps every real behaviour, and the pins can read
// whether (and how often) the count arm reached them.
jest.mock("@/lib/inventory/intent", () => {
  const actual =
    jest.requireActual<typeof import("@/lib/inventory/intent")>("@/lib/inventory/intent");
  return { ...actual, mapDeductionIntent: jest.fn(actual.mapDeductionIntent) };
});
jest.mock("@/lib/attribution/attempts", () => {
  const actual = jest.requireActual<typeof import("@/lib/attribution/attempts")>(
    "@/lib/attribution/attempts"
  );
  return { ...actual, recordAttributionAttempt: jest.fn(actual.recordAttributionAttempt) };
});
jest.mock("@/lib/inventory", () => {
  const actual = jest.requireActual<typeof import("@/lib/inventory")>("@/lib/inventory");
  return { ...actual, withDeadlockRetry: jest.fn(actual.withDeadlockRetry) };
});

import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireApproved, requireCSRF } from "@/lib/api-utils";
import { enforceRateLimit } from "@/lib/rateLimit";
import { countAtLocation, type CountResult } from "@/lib/inventory/count";
import { OptimisticLockError } from "@/lib/inventory/tx-errors";
import { mapDeductionIntent } from "@/lib/inventory/intent";
import { recordAttributionAttempt } from "@/lib/attribution/attempts";
import { STOCK_TX_OPTIONS, withDeadlockRetry } from "@/lib/inventory";
import { POST as ADJUST } from "@/app/api/inventory/adjust/route";

const db = prisma as unknown as DeepMockProxy<typeof prisma>;
const countMock = countAtLocation as jest.Mock;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RATE_HEADERS = { "X-RateLimit-Limit": "60", "X-RateLimit-Remaining": "59" };

const PRODUCT_ID = 5;
const LOCATION_ID = 2;
const COUNT_BODY = {
  productId: PRODUCT_ID,
  locationId: LOCATION_ID,
  intent: "count",
  countedQuantity: 7,
  expectedVersion: 3,
};
const LOG = { id: 555, productId: PRODUCT_ID, locationId: LOCATION_ID, delta: -2 };

/** The `tx` the mocked `$transaction` hands its callback — the count core never
 *  sees it here (the core is mocked), so it only has to be identifiable. */
const ROUTE_TX = { marker: "route-tx" } as unknown as Prisma.TransactionClient;

function post(body: unknown): NextRequest {
  return new NextRequest("http://x/api/inventory/adjust", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-csrf-token": "x" },
  });
}

type CoreCall = {
  tx: Prisma.TransactionClient;
  input: Record<string, unknown>;
  onRecord: (tx: Prisma.TransactionClient, result: CountResult) => Promise<void>;
};

/** The mocked core answers `result` and keeps what the route handed it. */
function coreAnswers(result: CountResult | Error): { calls: CoreCall[] } {
  const seen: { calls: CoreCall[] } = { calls: [] };
  countMock.mockImplementation(async (tx, input, onRecord) => {
    seen.calls.push({ tx, input, onRecord });
    if (result instanceof Error) throw result;
    return result;
  });
  return seen;
}

/** Invoke the route's `onRecord` with a recording tx; hand back the row it filed. */
async function eventFiledBy(
  onRecord: CoreCall["onRecord"],
  result: CountResult
): Promise<{ data: Record<string, any>; tx: DeepMockProxy<Prisma.TransactionClient> }> {
  const tx = mockDeep<Prisma.TransactionClient>();
  tx.auditLog.create.mockResolvedValue({ id: 1 } as any);
  await onRecord(tx, result);
  expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  return { data: tx.auditLog.create.mock.calls[0][0].data as Record<string, any>, tx };
}

const MATCH: CountResult = { changed: false, previousQuantity: 7, version: 3 };
const DIFFER: CountResult = {
  changed: true,
  previousQuantity: 9,
  delta: -2,
  log: LOG as unknown as Extract<CountResult, { changed: true }>["log"],
  newVersion: 4,
};

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({
    user: { id: 7, email: "u@x.com", isApproved: true, isAdmin: false },
  });
  (requireCSRF as jest.Mock).mockResolvedValue(undefined);
  (enforceRateLimit as jest.Mock).mockReturnValue(RATE_HEADERS);
  db.product.findFirst.mockResolvedValue({ name: "Widget" } as any);
  db.location.findUnique.mockResolvedValue({ name: "Main" } as any);
  (db.$transaction as unknown as jest.Mock).mockImplementation(async (cb: any) => cb(ROUTE_TX));
});

// ---------------------------------------------------------------------------
// The dispatch
// ---------------------------------------------------------------------------

describe("count — the route reaches the core with the shape and a minted batch id", () => {
  it("hands countAtLocation the request's fields, the actor and a fresh batch id, inside the route's tx", async () => {
    const seen = coreAnswers(MATCH);

    const res = await ADJUST(post(COUNT_BODY));

    expect(res.status).toBe(200);
    expect(seen.calls).toHaveLength(1);
    const [call] = seen.calls;
    expect(call.tx).toBe(ROUTE_TX);
    expect(call.input).toEqual({
      userId: 7,
      productId: PRODUCT_ID,
      locationId: LOCATION_ID,
      countedQuantity: 7,
      expectedVersion: 3,
      batchId: expect.stringMatching(UUID),
    });
    expect(typeof call.onRecord).toBe("function");
  });

  it("the existence reads are the house spellings: a LIVE product, the location by id", async () => {
    coreAnswers(MATCH);

    await ADJUST(post(COUNT_BODY));

    expect(db.product.findFirst).toHaveBeenCalledWith({
      where: { id: PRODUCT_ID, deletedAt: null },
      select: { name: true },
    });
    expect(db.location.findUnique).toHaveBeenCalledWith({
      where: { id: LOCATION_ID },
      select: { name: true },
    });
  });

  it("the transaction carries STOCK_TX_OPTIONS and runs under withDeadlockRetry, once", async () => {
    coreAnswers(MATCH);

    await ADJUST(post(COUNT_BODY));

    expect(withDeadlockRetry).toHaveBeenCalledTimes(1);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect((db.$transaction as unknown as jest.Mock).mock.calls[0][1]).toBe(STOCK_TX_OPTIONS);
  });

  // FR1 (row 128 (8)): counting the wrapper's calls does not prove the retry
  // can WORK — a `$transaction` promise built once and handed to the wrapper
  // would be awaited three times and fail three times. Drive a real retry: the
  // FIRST transaction runs the core and then rejects deadlock-shaped (P2034,
  // the engine choosing it as the victim), the second commits.
  it("a deadlock-shaped rejection of the FIRST transaction is retried through the thunk: two transactions, two core calls, a 200", async () => {
    const seen = coreAnswers(MATCH);
    let attempt = 0;
    (db.$transaction as unknown as jest.Mock).mockImplementation(async (cb: any) => {
      attempt += 1;
      const result = await cb(ROUTE_TX);
      if (attempt === 1) {
        throw Object.assign(
          new Error("Transaction failed due to a write conflict or a deadlock. Please retry your transaction"),
          { code: "P2034" }
        );
      }
      return result;
    });

    const res = await ADJUST(post(COUNT_BODY));

    expect(res.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(seen.calls).toHaveLength(2);
    expect(withDeadlockRetry).toHaveBeenCalledTimes(1);
    for (const call of (db.$transaction as unknown as jest.Mock).mock.calls) {
      expect(call[1]).toBe(STOCK_TX_OPTIONS);
    }
    // The batch is minted ONCE, before the retry (C2-2 step 3 precedes step 4):
    // the rolled-back attempt left nothing under it.
    expect(seen.calls[1].input.batchId).toBe(seen.calls[0].input.batchId);
    expect(await res.json()).toEqual({
      success: true,
      changed: false,
      batchId: seen.calls[1].input.batchId,
      countedQuantity: 7,
      previousQuantity: 7,
      delta: 0,
      newVersion: 3,
    });
  });

  it("each request mints its own batch id", async () => {
    const seen = coreAnswers(MATCH);

    await ADJUST(post(COUNT_BODY));
    await ADJUST(post(COUNT_BODY));

    expect(seen.calls).toHaveLength(2);
    expect(seen.calls[0].input.batchId).not.toBe(seen.calls[1].input.batchId);
  });
});

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

describe("count — the two 200 envelopes", () => {
  it("a match: changed false, the batch id, delta 0, the UNCHANGED version — and the rate-limit headers", async () => {
    const seen = coreAnswers(MATCH);

    const res = await ADJUST(post(COUNT_BODY));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      changed: false,
      batchId: seen.calls[0].input.batchId,
      countedQuantity: 7,
      previousQuantity: 7,
      delta: 0,
      newVersion: 3,
    });
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("59");
  });

  it("a difference: changed true, the signed delta, the bumped version and the log — and the rate-limit headers", async () => {
    const seen = coreAnswers(DIFFER);

    const res = await ADJUST(post(COUNT_BODY));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      changed: true,
      batchId: seen.calls[0].input.batchId,
      countedQuantity: 7,
      previousQuantity: 9,
      delta: -2,
      newVersion: 4,
      log: LOG,
    });
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("59");
  });
});

describe("count — the version conflict is the ONE 409 envelope", () => {
  it("OptimisticLockError -> 409 OPTIMISTIC_LOCK_ERROR with BOTH versions", async () => {
    coreAnswers(new OptimisticLockError("Stock changed while you counted", 4, 3));

    const res = await ADJUST(post(COUNT_BODY));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Stock changed while you counted",
      code: "OPTIMISTIC_LOCK_ERROR",
      currentVersion: 4,
      expectedVersion: 3,
    });
    // A deterministic conflict is never retried.
    expect(countMock).toHaveBeenCalledTimes(1);
  });
});

describe("count — an unknown product or location is a named 404, before any transaction", () => {
  let consoleError: jest.SpyInstance;
  beforeEach(() => {
    // apiHandler logs every AppError; keep the run readable.
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleError.mockRestore();
  });

  it.each([
    [
      "an unknown or soft-deleted product (the live-row read finds nothing)",
      "Product not found",
      () => db.product.findFirst.mockResolvedValue(null),
    ],
    ["an unknown location", "Location not found", () => db.location.findUnique.mockResolvedValue(null)],
  ])("%s -> 404 '%s', no transaction, no core call", async (_label, message, arrange) => {
    coreAnswers(MATCH);
    arrange();

    const res = await ADJUST(post(COUNT_BODY));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: message, code: "NOT_FOUND" });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(countMock).not.toHaveBeenCalled();
  });

  it("the soft-deleted case is decided by the read's filter, not by a post-read check", async () => {
    coreAnswers(MATCH);
    db.product.findFirst.mockResolvedValue(null);

    await ADJUST(post(COUNT_BODY));

    expect(db.product.findFirst.mock.calls[0][0]).toMatchObject({ where: { deletedAt: null } });
    expect(db.product.findUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The event the route's onRecord files
// ---------------------------------------------------------------------------

describe("count — the ONE INVENTORY_ADJUSTMENT event", () => {
  it("a match: 'Confirmed count of …', keyed by product under the minted batch, delta 0", async () => {
    const seen = coreAnswers(MATCH);
    await ADJUST(post(COUNT_BODY));
    const [call] = seen.calls;

    const { data } = await eventFiledBy(call.onRecord, MATCH);

    expect(data).toMatchObject({
      userId: 7,
      actionType: "INVENTORY_ADJUSTMENT",
      entityType: "INVENTORY",
      entityId: String(PRODUCT_ID),
      batchId: call.input.batchId,
      action: 'Confirmed count of 7 for "Widget" at Main',
    });
    expect(data.details).toEqual({
      productName: "Widget",
      intent: "count",
      countedQuantity: 7,
      previousQuantity: 7,
      delta: 0,
      locationId: LOCATION_ID,
    });
  });

  it("a difference: 'Counted N (was P) …', the signed delta", async () => {
    const seen = coreAnswers(DIFFER);
    await ADJUST(post(COUNT_BODY));
    const [call] = seen.calls;

    const { data } = await eventFiledBy(call.onRecord, DIFFER);

    expect(data).toMatchObject({
      actionType: "INVENTORY_ADJUSTMENT",
      entityType: "INVENTORY",
      entityId: String(PRODUCT_ID),
      batchId: call.input.batchId,
      action: 'Counted 7 (was 9) for "Widget" at Main',
    });
    expect(data.details).toEqual({
      productName: "Widget",
      intent: "count",
      countedQuantity: 7,
      previousQuantity: 9,
      delta: -2,
      locationId: LOCATION_ID,
    });
  });

  it("NO notes / reason key when none was sent — absent, never `notes: undefined`", async () => {
    const seen = coreAnswers(MATCH);
    await ADJUST(post(COUNT_BODY));

    const { data } = await eventFiledBy(seen.calls[0].onRecord, MATCH);

    expect(Object.keys(data.details)).not.toContain("notes");
    expect(Object.keys(data.details)).not.toContain("reason");
  });

  it("the operator's Note (and an API caller's reason) ride on the event when sent", async () => {
    const seen = coreAnswers(DIFFER);
    await ADJUST(post({ ...COUNT_BODY, notes: "back shelf, behind the returns", reason: "spot check" }));

    const { data } = await eventFiledBy(seen.calls[0].onRecord, DIFFER);

    expect(data.details).toMatchObject({
      notes: "back shelf, behind the returns",
      reason: "spot check",
    });
  });

  it("no attempt row and no T7 mapping — a count is not an attribution", async () => {
    const seen = coreAnswers(DIFFER);
    await ADJUST(post(COUNT_BODY));

    const { tx } = await eventFiledBy(seen.calls[0].onRecord, DIFFER);

    expect(recordAttributionAttempt).not.toHaveBeenCalled();
    expect(tx.orderAttributionAttempt.create).not.toHaveBeenCalled();
    expect(mapDeductionIntent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// What still refuses
// ---------------------------------------------------------------------------

describe("count — the schema bound and the guard that stays", () => {
  it("countedQuantity 1,000,000 -> 400 at the field (zod's own message), nothing read", async () => {
    coreAnswers(MATCH);

    const res = await ADJUST(post({ ...COUNT_BODY, countedQuantity: 1_000_000 }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Number must be less than or equal to 999999",
      code: "VALIDATION_ERROR",
    });
    expect(db.product.findFirst).not.toHaveBeenCalled();
    expect(countMock).not.toHaveBeenCalled();
  });

  it("a VALID correction is still 400 'this intent is not available yet', never mapped, never counted", async () => {
    coreAnswers(MATCH);

    const res = await ADJUST(
      post({
        productId: PRODUCT_ID,
        locationId: LOCATION_ID,
        intent: "correction",
        delta: 2,
        reversesBatchId: "3F2504E0-4F89-41D3-9A0C-0305E82C3301",
      })
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "this intent is not available yet",
      code: "VALIDATION_ERROR",
    });
    expect(countMock).not.toHaveBeenCalled();
    expect(mapDeductionIntent).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
