/**
 * @jest-environment node
 *
 * assistant toolsuite breadth — W1-MOVE: the movement-series module
 * (lib/reports/movement.ts, spec §5 T-MOVE REV-2 buckets).
 *
 * Pins the EXHAUSTIVE, MUTUALLY-EXCLUSIVE partition of inventory_logs over
 * logType × sign, and the NORMATIVE reconciliation invariant:
 *   net === SUM(delta) over every bucket INCLUDING transfers.
 *
 * Buckets:
 *   inbound   { stockIn, correctionIn, adjustmentIn, countIn }
 *   outbound  { sale, classifiedLoss, adjustmentUnclassified,
 *               correctionUnclassified, countOut }
 *   transfers { transferIn, transferOut }  (locally NOT netted away)
 * classifiedLoss = negative ADJUSTMENT/CORRECTION whose reasonCode is in
 * SHRINKAGE_CLASS_REASONS (DAMAGE/THEFT/EXPIRY/COUNT); every other negative
 * ADJUSTMENT/CORRECTION is *Unclassified — a DAMAGE row is classifiedLoss ONLY.
 * Zero-delta rows count NOWHERE (and never break net).
 */

import { mockReset, type DeepMockProxy } from "jest-mock-extended";
import type { PrismaClient } from "@prisma/client";
import type { ResolvedWindow } from "@/lib/assistant/window";

jest.mock("@/lib/prisma", () => {
  const { mockDeep } = require("jest-mock-extended");
  return { __esModule: true, default: mockDeep() };
});

import prisma from "@/lib/prisma";
import { getMovementSeries, getReceipts, type MovementFilters } from "@/lib/reports/movement";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

const win = (from: string, to: string): ResolvedWindow => ({
  from,
  to,
  days: Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
  ) + 1,
  source: "explicit",
});

/** Minimal fixture-row shape the module reads (select: delta/changeTime/logType/reasonCode). */
type Row = { delta: number; changeTime: Date; logType: string; reasonCode: string | null };
const at = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

const setRows = (rows: Row[]) => db.inventory_logs.findMany.mockResolvedValue(rows as never);

/**
 * G2-3: `approvedIds` is now REQUIRED on both reads (no web callers, so the
 * trust-boundary filter is never optional). These module tests are about the PARTITION
 * and the paging, not the approval universe — lifecycle-visibility.test.ts owns that — so
 * they pass one fixed id set through these wrappers and the mocked reads answer as seeded.
 */
const APPROVED_IDS = [1, 2, 3];
const series = (opts: Omit<Parameters<typeof getMovementSeries>[0], "approvedIds">) =>
  getMovementSeries({ ...opts, approvedIds: APPROVED_IDS });
const receipts = (opts: Omit<Parameters<typeof getReceipts>[0], "approvedIds">) =>
  getReceipts({ ...opts, approvedIds: APPROVED_IDS });

const BUCKET_KEYS = [
  "stockIn", "correctionIn", "adjustmentIn", "countIn",
  "sale", "classifiedLoss", "adjustmentUnclassified", "correctionUnclassified", "countOut",
  "transferIn", "transferOut",
] as const;

const sumBuckets = (b: Record<string, number>) =>
  BUCKET_KEYS.reduce((s, k) => s + b[k], 0);

beforeEach(() => {
  mockReset(db);
});

describe("reconciliation — net === SUM(delta) over every logType × sign", () => {
  // One row for every logType and BOTH signs, plus the reason-coded ADJUSTMENT/
  // CORRECTION splits and a zero-delta row. This is the normative fixture.
  const fixture: Row[] = [
    { delta: 10, changeTime: at("2026-07-10"), logType: "STOCK_IN", reasonCode: null },
    { delta: -2, changeTime: at("2026-07-10"), logType: "STOCK_IN", reasonCode: null }, // wrong-signed receipt reversal
    { delta: -8, changeTime: at("2026-07-11"), logType: "SALE", reasonCode: null },
    { delta: 1, changeTime: at("2026-07-11"), logType: "SALE", reasonCode: null }, // return posted as SALE+
    { delta: 5, changeTime: at("2026-07-12"), logType: "ADJUSTMENT", reasonCode: null }, // adjustmentIn
    { delta: -3, changeTime: at("2026-07-12"), logType: "ADJUSTMENT", reasonCode: "DAMAGE" }, // classifiedLoss
    { delta: -2, changeTime: at("2026-07-12"), logType: "ADJUSTMENT", reasonCode: null }, // adjustmentUnclassified
    { delta: -4, changeTime: at("2026-07-12"), logType: "ADJUSTMENT", reasonCode: "FOO" }, // adjustmentUnclassified (non-shrinkage reason)
    { delta: 6, changeTime: at("2026-07-13"), logType: "CORRECTION", reasonCode: null }, // correctionIn
    { delta: -3, changeTime: at("2026-07-13"), logType: "CORRECTION", reasonCode: "THEFT" }, // classifiedLoss
    { delta: -1, changeTime: at("2026-07-13"), logType: "CORRECTION", reasonCode: null }, // correctionUnclassified
    { delta: 7, changeTime: at("2026-07-13"), logType: "COUNT", reasonCode: null }, // countIn
    { delta: -2, changeTime: at("2026-07-13"), logType: "COUNT", reasonCode: null }, // countOut
    { delta: 9, changeTime: at("2026-07-13"), logType: "TRANSFER", reasonCode: null }, // transferIn
    { delta: -9, changeTime: at("2026-07-13"), logType: "TRANSFER", reasonCode: null }, // transferOut
    { delta: 0, changeTime: at("2026-07-13"), logType: "COUNT", reasonCode: null }, // zero-delta: counts nowhere
  ];

  it("totals.net equals the independent SUM(delta) AND the sum of all 11 buckets", async () => {
    setRows(fixture);
    const res = await series({ window: win("2026-07-01", "2026-07-31"), grain: "day" });

    const expectedNet = fixture.reduce((s, r) => s + r.delta, 0); // = 4
    expect(res.totals.net).toBe(expectedNet);
    expect(sumBuckets(res.totals as unknown as Record<string, number>)).toBe(expectedNet);
  });

  it("routes every logType × sign into exactly the right bucket (no double-count)", async () => {
    setRows(fixture);
    const { totals } = await series({ window: win("2026-07-01", "2026-07-31"), grain: "day" });

    expect(totals).toMatchObject({
      stockIn: 8, // 10 + (-2) folded into stockIn (logType-keyed)
      sale: -7, // -8 + 1 folded into sale (logType-keyed)
      adjustmentIn: 5,
      classifiedLoss: -6, // DAMAGE(-3) + THEFT(-3)
      adjustmentUnclassified: -6, // null(-2) + FOO(-4)
      correctionIn: 6,
      correctionUnclassified: -1,
      countIn: 7,
      countOut: -2,
      transferIn: 9,
      transferOut: -9,
    });
  });

  it("counts reasonCode-null NEGATIVE ADJUSTMENT/CORRECTION rows in coverage", async () => {
    setRows(fixture);
    const res = await series({ window: win("2026-07-01", "2026-07-31"), grain: "day" });
    // Only the -2 null ADJUSTMENT and the -1 null CORRECTION qualify; the FOO
    // adjustment has a reason, the positive ADJUSTMENT/CORRECTION are inbound,
    // and the zero-delta row is skipped.
    expect(res.coverage.reasonCodeNullRows).toBe(2);
    expect(res.coverage.unclassifiedLegacyNote).toMatch(/pre-Lane-4/i);
  });
});

describe("mutual exclusivity — a classifiedLoss row is not also *Unclassified", () => {
  it("a DAMAGE negative ADJUSTMENT lands in classifiedLoss ONLY", async () => {
    setRows([{ delta: -5, changeTime: at("2026-07-10"), logType: "ADJUSTMENT", reasonCode: "DAMAGE" }]);
    const { totals } = await series({ window: win("2026-07-01", "2026-07-31"), grain: "day" });

    expect(totals.classifiedLoss).toBe(-5);
    expect(totals.adjustmentUnclassified).toBe(0);
    expect(totals.net).toBe(-5);
  });

  it("a COUNT-reason negative CORRECTION is classifiedLoss (reason COUNT ∈ SHRINKAGE), not countOut", async () => {
    // reasonCode 'COUNT' is a SHRINKAGE class; logType stays CORRECTION so it is
    // classifiedLoss — proves the logType partition precedes the reason lookup.
    setRows([{ delta: -4, changeTime: at("2026-07-10"), logType: "CORRECTION", reasonCode: "COUNT" }]);
    const { totals } = await series({ window: win("2026-07-01", "2026-07-31"), grain: "day" });

    expect(totals.classifiedLoss).toBe(-4);
    expect(totals.correctionUnclassified).toBe(0);
    expect(totals.countOut).toBe(0);
  });
});

describe("grain rollups — week (Sun/Mon straddle) & month (month straddle)", () => {
  it("week grain splits a Sunday and the following Monday into distinct ISO weeks", async () => {
    // 2026-07-12 is a Sunday (ISO week starts Mon 2026-07-06);
    // 2026-07-13 is a Monday (ISO week starts Mon 2026-07-13).
    setRows([
      { delta: -3, changeTime: at("2026-07-12"), logType: "SALE", reasonCode: null },
      { delta: -5, changeTime: at("2026-07-13"), logType: "SALE", reasonCode: null },
    ]);
    const res = await series({ window: win("2026-07-06", "2026-07-14"), grain: "week" });

    expect(res.grain).toBe("week");
    expect(res.points.map((p) => p.key)).toEqual(["2026-07-06", "2026-07-13"]);
    expect(res.points.find((p) => p.key === "2026-07-06")?.sale).toBe(-3);
    expect(res.points.find((p) => p.key === "2026-07-13")?.sale).toBe(-5);
    expect(res.totals.sale).toBe(-8);
  });

  it("month grain splits 2026-07-31 and 2026-08-01 into distinct months", async () => {
    setRows([
      { delta: 4, changeTime: at("2026-07-31"), logType: "STOCK_IN", reasonCode: null },
      { delta: 6, changeTime: at("2026-08-01"), logType: "STOCK_IN", reasonCode: null },
    ]);
    const res = await series({ window: win("2026-07-01", "2026-08-31"), grain: "month" });

    expect(res.points.map((p) => p.key)).toEqual(["2026-07", "2026-08"]);
    expect(res.points.find((p) => p.key === "2026-07")?.stockIn).toBe(4);
    expect(res.points.find((p) => p.key === "2026-08")?.stockIn).toBe(6);
  });
});

describe("transfers at location grain are NOT netted away", () => {
  it("a lone transferOut leg (location-filtered) survives as transferOut, net non-zero", async () => {
    // Filtering to the source location returns only the negative leg.
    setRows([{ delta: -12, changeTime: at("2026-07-10"), logType: "TRANSFER", reasonCode: null }]);
    const { totals } = await series({
      window: win("2026-07-01", "2026-07-31"),
      grain: "day",
      locationId: 3,
    });

    expect(totals.transferOut).toBe(-12);
    expect(totals.transferIn).toBe(0);
    expect(totals.net).toBe(-12);

    const where = db.inventory_logs.findMany.mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.locationId).toBe(3);
  });

  it("both legs (unfiltered) stay SEPARATE — reported as +N/-N, not collapsed to one 0", async () => {
    setRows([
      { delta: 12, changeTime: at("2026-07-10"), logType: "TRANSFER", reasonCode: null },
      { delta: -12, changeTime: at("2026-07-10"), logType: "TRANSFER", reasonCode: null },
    ]);
    const { totals } = await series({ window: win("2026-07-01", "2026-07-31"), grain: "day" });

    expect(totals.transferIn).toBe(12);
    expect(totals.transferOut).toBe(-12);
    expect(totals.net).toBe(0); // nets globally, but the two buckets are still visible
  });
});

describe("empty window & query shape", () => {
  it("empty window ⇒ zeroed buckets, net 0, no points, zero coverage count", async () => {
    setRows([]);
    const res = await series({ window: win("2026-07-01", "2026-07-31"), grain: "day" });

    expect(res.points).toEqual([]);
    expect(res.totals.net).toBe(0);
    expect(sumBuckets(res.totals as unknown as Record<string, number>)).toBe(0);
    for (const k of BUCKET_KEYS) {
      expect((res.totals as unknown as Record<string, number>)[k]).toBe(0);
    }
    expect(res.coverage.reasonCodeNullRows).toBe(0);
    expect(res.coverage.unclassifiedLegacyNote).toEqual(expect.any(String));
  });

  it("queries the ledger over the window's changeTime range with optional filters, no logType/delta filter", async () => {
    setRows([]);
    await series({
      window: win("2026-07-06", "2026-07-14"),
      grain: "day",
      productId: 42,
    });

    const where = db.inventory_logs.findMany.mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.changeTime).toEqual({
      gte: new Date("2026-07-06T00:00:00.000Z"),
      lt: new Date("2026-07-15T00:00:00.000Z"), // exclusive upper: start of the day AFTER `to`
    });
    // quality+reach Task 3.1: productId and the G5 approved-id set narrow the SAME
    // column, so the read builds ONE IntFilter instead of a bare scalar. G2-3 made the
    // id set REQUIRED, so `in` is always half of that filter — a single-product read is
    // narrowed by BOTH, and neither can silently overwrite the other.
    expect(where.productId).toEqual({ equals: 42, in: APPROVED_IDS });
    expect(where.locationId).toBeUndefined();
    // Exhaustive partition ⇒ we must read ALL rows, so no server-side delta/logType narrowing.
    expect(where.delta).toBeUndefined();
    expect(where.logType).toBeUndefined();
  });

  it("echoes grain and the resolved window verbatim", async () => {
    setRows([]);
    const window = win("2026-07-01", "2026-07-31");
    const res = await series({ window, grain: "month" });
    expect(res.grain).toBe("month");
    expect(res.window).toBe(window);
  });
});

/**
 * getReceipts (W2-RCPT, spec §5 T-RCPT): STOCK_IN receipts DETAIL, DB-side
 * skip/take + count paging via `pageFromDb` — never a full-history in-memory
 * fetch. A receipt-DETAIL row must be a REAL receipt: delta > 0 is a where-clause
 * filter (server-side), unlike getMovementSeries's stockIn bucket, which folds a
 * wrong-signed row into the same logType-keyed signed sum so `net === SUM(delta)`
 * holds. Those are two different jobs -- a totals partition vs. a detail listing --
 * so the two functions disagree on purpose.
 */
describe("getReceipts -- DB-side paged STOCK_IN receipts detail", () => {
  /** Minimal fixture-row shape the module selects: productId/locationId/delta/
   *  unitCostCents/batchId/changeTime. */
  const receiptRow = (
    over: Partial<{
      productId: number;
      locationId: number | null;
      delta: number;
      unitCostCents: number | null;
      batchId: string | null;
      changeTime: Date;
    }> = {},
  ) => ({
    productId: 1,
    locationId: 2,
    delta: 5,
    unitCostCents: 350,
    batchId: "batch-1",
    changeTime: at("2026-07-10"),
    ...over,
  });

  it("pages DB-side: count() is a separate exact query under the SAME where as fetch's skip/take (never a full-history fetch)", async () => {
    db.inventory_logs.count.mockResolvedValue(37);
    db.inventory_logs.findMany.mockResolvedValue([receiptRow(), receiptRow({ productId: 2 })] as never);

    const res = await receipts({
      window: win("2026-07-01", "2026-07-31"),
      limit: 2,
      offset: 10,
      byteBudget: 100_000,
    });

    expect(res.totalRows).toBe(37);
    expect(res.returned).toBe(2);
    expect(res.nextOffset).toBe(12); // 10 consumed-before + 2 returned, 12 < 37 total

    expect(db.inventory_logs.count).toHaveBeenCalledTimes(1);
    const findManyArgs = db.inventory_logs.findMany.mock.calls[0][0]!;
    const countArgs = db.inventory_logs.count.mock.calls[0][0]!;
    expect(findManyArgs.skip).toBe(10);
    expect(findManyArgs.take).toBe(2);
    expect(countArgs.where).toEqual(findManyArgs.where);
  });

  it("orders NEWEST-first: changeTime desc, then id desc for determinism", async () => {
    db.inventory_logs.count.mockResolvedValue(1);
    db.inventory_logs.findMany.mockResolvedValue([receiptRow()] as never);

    await receipts({ window: win("2026-07-01", "2026-07-31"), byteBudget: 100_000 });

    const findManyArgs = db.inventory_logs.findMany.mock.calls[0][0]!;
    expect(findManyArgs.orderBy).toEqual([{ changeTime: "desc" }, { id: "desc" }]);
  });

  it("relays null unitCostCents, null locationId, and null batchId AS NULL -- never coerced to 0", async () => {
    db.inventory_logs.count.mockResolvedValue(1);
    db.inventory_logs.findMany.mockResolvedValue([
      receiptRow({ unitCostCents: null, locationId: null, batchId: null }),
    ] as never);

    const res = await receipts({ window: win("2026-07-01", "2026-07-31"), byteBudget: 100_000 });

    expect(res.rows[0].unitCostCents).toBeNull();
    expect(res.rows[0].locationId).toBeNull();
    expect(res.rows[0].batchId).toBeNull();
  });

  it("quantity is the positive delta; changeTime is relayed as an ISO string", async () => {
    db.inventory_logs.count.mockResolvedValue(1);
    db.inventory_logs.findMany.mockResolvedValue([
      receiptRow({ delta: 42, changeTime: at("2026-07-05") }),
    ] as never);

    const res = await receipts({ window: win("2026-07-01", "2026-07-31"), byteBudget: 100_000 });

    expect(res.rows[0].quantity).toBe(42);
    expect(res.rows[0].changeTime).toBe(at("2026-07-05").toISOString());
  });

  it("scopes to the window's half-open changeTime range -- same boundary convention as getMovementSeries", async () => {
    db.inventory_logs.count.mockResolvedValue(0);
    db.inventory_logs.findMany.mockResolvedValue([] as never);

    await receipts({ window: win("2026-07-06", "2026-07-14"), byteBudget: 100_000 });

    const where = db.inventory_logs.findMany.mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.changeTime).toEqual({
      gte: new Date("2026-07-06T00:00:00.000Z"),
      lt: new Date("2026-07-15T00:00:00.000Z"), // exclusive upper: start of the day AFTER `to`
    });
  });

  it("productId filter narrows the where clause", async () => {
    db.inventory_logs.count.mockResolvedValue(0);
    db.inventory_logs.findMany.mockResolvedValue([] as never);

    await receipts({ window: win("2026-07-01", "2026-07-31"), productId: 42, byteBudget: 100_000 });

    const where = db.inventory_logs.findMany.mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.productId).toEqual({ equals: 42, in: APPROVED_IDS });
  });

  it("omitting productId narrows by the approved id set ALONE (G2-3: never unfiltered)", async () => {
    db.inventory_logs.count.mockResolvedValue(0);
    db.inventory_logs.findMany.mockResolvedValue([] as never);

    await receipts({ window: win("2026-07-01", "2026-07-31"), byteBudget: 100_000 });

    const where = db.inventory_logs.findMany.mock.calls[0][0]!.where as Record<string, unknown>;
    // The `equals` half is absent (no single-product scope) but the trust-boundary half
    // is ALWAYS there — a catalog-wide receipts listing is still approved-only.
    expect(where.productId).toEqual({ in: APPROVED_IDS });
  });

  // W2 seam-fix item 2: locationId was silently ignored — the tool advertised a
  // locationId arg but getReceipts never threaded it into the where clause, so a
  // location-scoped receipts request returned the GLOBAL receipt list. Both the
  // count and the findMany must be narrowed by locationId.
  it("locationId filter narrows BOTH the count and findMany where clauses", async () => {
    db.inventory_logs.count.mockResolvedValue(0);
    db.inventory_logs.findMany.mockResolvedValue([] as never);

    await receipts({ window: win("2026-07-01", "2026-07-31"), locationId: 7, byteBudget: 100_000 });

    const findWhere = db.inventory_logs.findMany.mock.calls[0][0]!.where as Record<string, unknown>;
    const countWhere = db.inventory_logs.count.mock.calls[0][0]!.where as Record<string, unknown>;
    expect(findWhere.locationId).toBe(7);
    expect(countWhere.locationId).toBe(7);
  });

  it("omitting locationId leaves it out of the where clause (no accidental narrowing)", async () => {
    db.inventory_logs.count.mockResolvedValue(0);
    db.inventory_logs.findMany.mockResolvedValue([] as never);

    await receipts({ window: win("2026-07-01", "2026-07-31"), byteBudget: 100_000 });

    const where = db.inventory_logs.findMany.mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.locationId).toBeUndefined();
  });

  it(
    "is scoped to STOCK_IN with delta > 0 -- wrong-signed STOCK_IN (a receipt reversal) is EXCLUDED " +
      "(a detail listing must be real receipts; contrast getMovementSeries, which folds a wrong-signed " +
      "STOCK_IN into the same logType-keyed stockIn sum to keep net === SUM(delta))",
    async () => {
      db.inventory_logs.count.mockResolvedValue(0);
      db.inventory_logs.findMany.mockResolvedValue([] as never);

      await receipts({ window: win("2026-07-01", "2026-07-31"), byteBudget: 100_000 });

      const where = db.inventory_logs.findMany.mock.calls[0][0]!.where as Record<string, unknown>;
      expect(where.logType).toBe("STOCK_IN");
      expect(where.delta).toEqual({ gt: 0 });
    },
  );

  it("defaults offset to 0 and take to a fixed default limit when omitted", async () => {
    db.inventory_logs.count.mockResolvedValue(0);
    db.inventory_logs.findMany.mockResolvedValue([] as never);

    await receipts({ window: win("2026-07-01", "2026-07-31"), byteBudget: 100_000 });

    const findManyArgs = db.inventory_logs.findMany.mock.calls[0][0]!;
    expect(findManyArgs.skip).toBe(0);
    expect(findManyArgs.take).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// G2-4 — the filter echo's `mode` is TYPE-pinned per envelope. `filters.mode === mode`
// used to be a convention that three runtime assertions policed; a fourth envelope, or a
// copy-pasted filters block, could contradict its own discriminant and still compile.
// The assertions below are compile-time: `npx tsc --noEmit` is what runs them.
// ---------------------------------------------------------------------------

describe("G2-4 — MovementFilters<M> pins each envelope's mode at compile time", () => {
  it("accepts the matching literal and REJECTS a mismatched pair (tsc is the assertion)", async () => {
    const seriesFilters: MovementFilters<"series"> = {
      productId: null,
      productIds: null,
      locationId: null,
      mode: "series",
    };
    const receiptsFilters: MovementFilters<"receipts"> = {
      productId: null,
      productIds: null,
      locationId: null,
      mode: "receipts",
    };
    const byProductFilters: MovementFilters<"by_product"> = {
      productId: null,
      productIds: [1],
      locationId: null,
      mode: "by_product",
    };
    const mismatched: MovementFilters<"series"> = {
      productId: null,
      productIds: null,
      locationId: null,
      // @ts-expect-error — a receipts mode inside a SERIES filter echo is the exact
      // contract violation T4 forbids; tsc now refuses it.
      mode: "receipts",
    };

    expect([seriesFilters.mode, receiptsFilters.mode, byProductFilters.mode]).toEqual([
      "series",
      "receipts",
      "by_product",
    ]);
    // The runtime half stays pinned too: the REAL series envelope agrees with its own
    // discriminant (the by_product/receipts variants are pinned in their own suites).
    setRows([]);
    const res = await series({ window: win("2026-07-01", "2026-07-31"), grain: "day" });
    expect(res.filters.mode).toBe(res.mode);
    expect(mismatched.mode).toBe("receipts"); // the value is irrelevant; the pin is above
  });
});

describe("OC-9 classifier parity: movement's classify matches outbound-mix case-insensitivity", () => {
  // Both classifiers promise "never diverge". A lowercase legacy reasonCode must land in
  // classifiedLoss on BOTH sides — this pin holds movement's half of that promise.
  it("buckets a lowercase 'damage' ADJUSTMENT as classifiedLoss, like outbound-mix does", async () => {
    db.inventory_logs.findMany.mockResolvedValue([
      { delta: -3, logType: "ADJUSTMENT", reasonCode: "damage", changeTime: new Date("2026-08-01T00:00:00Z") },
    ] as never);
    const r = await series({ window: win("2026-08-01", "2026-08-01"), grain: "day" });
    expect(r.totals.classifiedLoss).toBe(-3);
    expect(r.totals.adjustmentUnclassified).toBe(0);
  });
});
