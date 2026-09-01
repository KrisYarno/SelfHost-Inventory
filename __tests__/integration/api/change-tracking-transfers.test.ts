// @jest-environment node
/**
 * Change-tracking Phase C Task 4 — transfer correlation (P-C7).
 *
 * These pin the transfer routes' NEW correlation wiring, which the Task-2 inventory
 * suite (change-tracking-inventory.test.ts) does not cover:
 *   - the INVENTORY_TRANSFER event's `details.transferId` comes from the record
 *     CALLBACK's `result.transferId` and equals the transferId stamped on BOTH legs,
 *   - the event's `batchId` is stamped onto BOTH ledger legs (P-C1 join),
 *   - transfer/batch per-transfer RESULTS expose each leg-pair's `transferId`.
 *
 * The REAL @/lib/change-tracking + REAL createInventoryTransfer run against a
 * jest-mock-extended Prisma; apiHandler is stubbed to a passthrough. This mirrors
 * the harness in __tests__/integration/api/change-tracking-inventory.test.ts.
 */

import { mockDeep, type DeepMockProxy } from "jest-mock-extended";
import { Prisma } from "@prisma/client";

jest.mock("@/lib/api-utils", () => ({
  ...jest.requireActual("@/lib/api-utils"),
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(),
}));
jest.mock("@/lib/csrf", () => ({ validateCSRFToken: jest.fn(async () => true) }));
jest.mock("@/lib/rateLimit", () => ({
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((r: any) => r),
}));
jest.mock("@/lib/prisma", () => {
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireApproved, TX_BUSY_MESSAGE } from "@/lib/api-utils";
import { POST as TRANSFER } from "@/app/api/inventory/transfer/route";
import { POST as TRANSFER_BATCH } from "@/app/api/inventory/transfer/batch/route";

const db = prisma as unknown as DeepMockProxy<typeof prisma>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// THE RECORDING RAW TRIO (pack CB0.3, the per-suite paragraph).
//
// This suite declares its OWN `@/lib/prisma` factory, so the global harness's
// trio never reaches it, and it builds a FRESH tx per test — so the trio is
// installed on each tx `makeTx()` hands out, at the point it is built (the
// REV-15 OC-4 placement rule: never somewhere a later rebuild would discard).
//
// Two layers: the OUTER fn always records and then delegates to an INNER
// behaviour fn (`rawBehavior`), which is what a test configures — so an
// override can never silently switch the recording off.
// ---------------------------------------------------------------------------
type RawCall = { kind: "query" | "execute" | "executeUnsafe"; sql: string; at: number };

/** Every raw statement the test under way has spent, in call order. */
const rawCalls: RawCall[] = [];
/** The INNER behaviour fns, by method name — what a test configures. */
const rawBehavior: Record<string, jest.Mock> = {};
/** The OUTER recording fns — for `invocationCallOrder` against the delegates. */
const rawFns: Record<string, jest.Mock> = {};
let rawSeq = 0;

function sqlTextOf(arg: unknown): string {
  return arg && typeof arg === "object" && typeof (arg as { sql?: unknown }).sql === "string"
    ? (arg as { sql: string }).sql
    : String(arg);
}

function installRecordingRaw(target: Record<string, unknown>): void {
  const install = (kind: RawCall["kind"], method: string, make: () => unknown) => {
    const behavior = jest.fn((..._args: unknown[]) => Promise.resolve(make()));
    const recording = jest.fn((...args: unknown[]) => {
      rawCalls.push({ kind, sql: sqlTextOf(args[0]), at: rawSeq++ });
      return behavior(...args);
    });
    rawBehavior[method] = behavior;
    rawFns[method] = recording;
    target[method] = recording;
  };
  install("query", "$queryRaw", () => []);
  install("execute", "$executeRaw", () => 0);
  install("executeUnsafe", "$executeRawUnsafe", () => 0);
}

/** The prelock's returning SELECT (lib/inventory/prelock.ts), by its text. */
function isPrelockSelect(sql: string): boolean {
  return sql.includes("FROM product_locations") && sql.includes("(productId, locationId) IN");
}

/**
 * What the prelock's returning SELECT hands back. `createInventoryTransfer`'s
 * paired `findUnique`s retired with the prelock (pack CB1a-i.3), so the fixture
 * that read { quantity: 100, version: 1 } is spelled here as the materialized
 * rows the version checks and the source floor now read.
 */
function prelocked(
  rows: Array<{ productId: number; locationId: number; quantity: number; version: number }>
): void {
  rawBehavior.$queryRaw.mockImplementation(async (...args: unknown[]) =>
    isPrelockSelect(sqlTextOf(args[0])) ? rows : []
  );
}

/** Every prelocked key these transfers touch: stocked, at version 1. */
const STOCKED = [
  { productId: 5, locationId: 2, quantity: 100, version: 1 },
  { productId: 5, locationId: 3, quantity: 100, version: 1 },
  { productId: 5, locationId: 9, quantity: 100, version: 1 },
];

/** A fresh deep-mocked TransactionClient with the reads every transfer path needs. */
function makeTx() {
  const tx = mockDeep<Prisma.TransactionClient>();
  installRecordingRaw(tx as unknown as Record<string, unknown>);
  prelocked(STOCKED);
  tx.product_locations.findUnique.mockResolvedValue({ version: 1, quantity: 100 } as any);
  tx.product_locations.upsert.mockResolvedValue({ version: 2 } as any);
  tx.inventory_logs.create.mockResolvedValue({ id: 1, products: { name: "Widget" } } as any);
  tx.product.update.mockResolvedValue({} as any);
  tx.auditLog.create.mockResolvedValue({ id: 1 } as any);
  return tx;
}

function driveTxWith(tx: ReturnType<typeof makeTx>) {
  (db.$transaction as unknown as jest.Mock).mockImplementation(async (cb: any) => cb(tx));
}

/** A synthesized deadlock — the class + code the wire maps to BUSY. */
function busy(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "\nInvalid `prisma.$queryRaw()` invocation:\n\nTransaction failed due to a write conflict or a deadlock. Please retry your transaction",
    { code: "P2034", clientVersion: "test" }
  );
}

/**
 * The Nth prelock SELECT of this request (1-based) loses a deadlock; every other
 * statement answers exactly as `prelocked(STOCKED)` does. The returning locking
 * read is where a deadlock victim actually finds out, and ONE prelock pair runs
 * per transfer — so `n = 2` is the second transfer of a batch, and only it.
 */
function busyOnPrelock(n: number): void {
  let seen = 0;
  rawBehavior.$queryRaw.mockImplementation(async (...args: unknown[]) => {
    if (!isPrelockSelect(sqlTextOf(args[0]))) return [];
    seen += 1;
    if (seen === n) throw busy();
    return STOCKED;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  rawCalls.length = 0;
  (requireApproved as jest.Mock).mockResolvedValue({
    user: { id: 7, email: "u@x.com", isApproved: true, isAdmin: false },
  });
  db.product_locations.findUnique.mockResolvedValue({ quantity: 100, version: 1 } as any);
});

describe("transfer — event.details.transferId + batchId join both legs (P-C7)", () => {
  it("stamps the leg-pair transferId into the event and the event batchId onto both legs", async () => {
    const tx = makeTx();
    driveTxWith(tx);
    db.product.findUnique.mockResolvedValue({ id: 5, name: "Widget" } as any);
    db.location.findUnique
      .mockResolvedValueOnce({ id: 2, name: "From" } as any)
      .mockResolvedValueOnce({ id: 3, name: "To" } as any);

    const res = await TRANSFER(
      post("http://x/api/inventory/transfer", {
        productId: 5,
        fromLocationId: 2,
        toLocationId: 3,
        quantity: 4,
      })
    );
    expect(res.status).toBe(200);

    // Both legs written; one event recorded.
    expect(tx.inventory_logs.create).toHaveBeenCalledTimes(2);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const legs = tx.inventory_logs.create.mock.calls.map((c) => (c[0] as any).data);
    const event = tx.auditLog.create.mock.calls[0][0].data as any;

    // details.transferId came from the record callback's result.transferId, and it
    // is the SAME id stamped on both ledger legs.
    expect(event.details.transferId).toMatch(UUID_RE);
    expect(legs[0].transferId).toBe(event.details.transferId);
    expect(legs[1].transferId).toBe(event.details.transferId);

    // The event's batchId is stamped onto BOTH legs (P-C1 join, no NULLs).
    expect(event.batchId).toMatch(UUID_RE);
    expect(legs[0].batchId).toBe(event.batchId);
    expect(legs[1].batchId).toBe(event.batchId);
  });
});

describe("transfer/batch — per-transfer results expose transferId; one shared batchId", () => {
  it("each result carries its leg-pair transferId; both legs of each carry the batch's batchId", async () => {
    const tx = makeTx();
    driveTxWith(tx);
    db.product.findFirst.mockResolvedValue({ id: 5, name: "Widget" } as any);
    db.location.findUnique.mockResolvedValue({ id: 9, name: "Dest" } as any);
    db.location.findMany.mockResolvedValue([
      { id: 2, name: "Src A" },
      { id: 3, name: "Src B" },
    ] as any);

    const res = await TRANSFER_BATCH(
      post("http://x/api/inventory/transfer/batch", {
        productId: 5,
        toLocationId: 9,
        transfers: [
          { fromLocationId: 2, quantity: 4 },
          { fromLocationId: 3, quantity: 6 },
        ],
      })
    );
    expect([200, 207]).toContain(res.status);

    const body = await res.json();
    expect(body.results).toHaveLength(2);

    // Each successful result exposes a UUID transferId; the two are distinct pairs.
    for (const r of body.results) {
      expect(r.success).toBe(true);
      expect(r.transferId).toMatch(UUID_RE);
    }
    expect(body.results[0].transferId).not.toBe(body.results[1].transferId);

    // 4 legs (2 per transfer) + 2 events; every event's transferId matches a result.
    const legs = tx.inventory_logs.create.mock.calls.map((c) => (c[0] as any).data);
    const events = tx.auditLog.create.mock.calls.map((c) => (c[0].data as any));
    expect(legs).toHaveLength(4);
    expect(events).toHaveLength(2);

    const resultIds = new Set(body.results.map((r: any) => r.transferId));
    const eventIds = new Set(events.map((e) => e.details.transferId));
    expect(eventIds).toEqual(resultIds);

    // Each leg's transferId is one of the two pair ids…
    for (const leg of legs) {
      expect(resultIds.has(leg.transferId)).toBe(true);
    }

    // …and every leg + every event shares the ONE request batchId.
    const batchId = body.batchId;
    expect(batchId).toMatch(UUID_RE);
    for (const leg of legs) expect(leg.batchId).toBe(batchId);
    for (const e of events) expect(e.batchId).toBe(batchId);
  });
});

// ---------------------------------------------------------------------------
// THE TRANSFER THAT LOSES A DEADLOCK (fix-delta FDb-1, coverage gap FDc-3).
//
// The covered writers queue on each other's prelocked rows, so one transfer of a
// batch can lose its transaction to a write conflict while its siblings commit.
// The route's per-transfer catch is BELOW apiHandler, so nothing above it can
// type that failure: without the transient branch the 207's failed result would
// carry Prisma's own multi-line invocation dump — "Invalid `prisma.$queryRaw()`
// invocation … write conflict or a deadlock" — verbatim into a stocker's toast.
// ---------------------------------------------------------------------------
describe("transfer/batch — a transfer that loses a deadlock (FDb-1)", () => {
  it("gives the failed result the shared BUSY sentence, never Prisma's own text", async () => {
    const tx = makeTx();
    driveTxWith(tx);
    // The SECOND transfer's returning locking read is the deadlock victim.
    busyOnPrelock(2);
    db.product.findFirst.mockResolvedValue({ id: 5, name: "Widget" } as any);
    db.location.findUnique.mockResolvedValue({ id: 9, name: "Dest" } as any);
    db.location.findMany.mockResolvedValue([
      { id: 2, name: "Src A" },
      { id: 3, name: "Src B" },
    ] as any);

    const res = await TRANSFER_BATCH(
      post("http://x/api/inventory/transfer/batch", {
        productId: 5,
        toLocationId: 9,
        transfers: [
          { fromLocationId: 2, quantity: 4 },
          { fromLocationId: 3, quantity: 6 },
        ],
      })
    );

    // One moved, one lost the race: the partial-success envelope.
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.totalTransferred).toBe(4);
    expect(body.results).toHaveLength(2);

    expect(body.results[0]).toMatchObject({ fromLocationId: 2, success: true });
    expect(body.results[1]).toMatchObject({ fromLocationId: 3, success: false });

    // THE PIN: the one sentence apiHandler would have answered with, shared from
    // @/lib/api-utils rather than re-spelled here — and no Prisma text anywhere.
    expect(body.results[1].error).toBe(TX_BUSY_MESSAGE);
    expect(body.results[1].error).not.toMatch(/P2034|deadlock|prisma/i);

    // The transfer that DID commit is untouched by its sibling's loss: both legs
    // and its event are on the wire with the request's batchId.
    const legs = tx.inventory_logs.create.mock.calls.map((c) => (c[0] as any).data);
    expect(legs).toHaveLength(2);
    for (const leg of legs) expect(leg.batchId).toBe(body.batchId);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });
});
