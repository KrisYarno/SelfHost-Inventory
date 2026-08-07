/**
 * @jest-environment node
 *
 * THE W2 INVARIANT CHARTER (assistant quality+reach lane, plan REV-5 W2 entry gate).
 *
 * Three of the four previously-UNSOUND invariant families land here as executable
 * test code BEFORE any W2 implementation:
 *
 *   - C12 outbound-mix partition — LIVE and RED at W2 entry (Task 2.1 makes it green).
 *   - C6 get_sales zero-vs-null   — `describe.skip`; Task 2.2 unskips it as its Step 1
 *     and verifies RED before implementing.
 *   - C9 compare_periods by_product zero-vs-null / unranked — `describe.skip`; Task 2.3
 *     unskips it as its Step 1.
 *
 * (The fourth family, C5xC11 reorder accounting, lives in ITS domain file —
 * __tests__/unit/lib/reports/reorder-coverage-invariant.test.ts — appended by Task 2.1
 * as a `describe.skip` and unskipped by Task 2.5. One file per domain; no cross-file
 * unskip.)
 *
 * C12 invariants (contract pack T1, BINDING):
 *   - bucket sum == SUM(|delta|) over the classified rows;
 *   - EVERY bucket asserted per fixture (a partition-sum assertion alone stays green
 *     under a misclassification — two buckets can swap and still add up);
 *   - a TRANSFER row or a non-negative row is a PRECONDITION VIOLATION: the classifier
 *     THROWS a plain Error rather than absorbing a caller bug into a bucket;
 *   - one CALLER-POPULATION test per consumer, proving the rows each consumer feeds in
 *     were filtered by that consumer's OWN predicate (an ADJUSTMENT row reasoned
 *     "CORRECTION" is in the PHYSICAL population and buckets to adjustmentUnclassified;
 *     the reorder-demand predicate drops it before the classifier ever sees it).
 */

import { mockReset, type DeepMockProxy } from "jest-mock-extended";
import { ZodError } from "zod";
import { Prisma, type PrismaClient } from "@prisma/client";

jest.mock("@/lib/prisma", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});

// tools.ts pulls these in at import time (the C6/C9 families drive the real tools);
// they must never reach a real prisma.
jest.mock("@/lib/products", () => ({ __esModule: true, getProductsWithQuantities: jest.fn() }));
jest.mock("@/lib/reports/low-stock", () => ({ __esModule: true, getLowStockReport: jest.fn() }));

import prisma from "@/lib/prisma";
import { classifyOutboundMix, productIdentities, type OutboundMix } from "@/lib/reports/outbound-mix";
import { getOperationsRows } from "@/lib/analytics/queries";
import { reorderDemand } from "@/lib/reports/demand";
import { assistantTools, testCtx } from "@/lib/assistant/tools";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);

/** The zero mix — every fixture asserts the FULL bucket record, never a subset. */
const ZERO: OutboundMix = {
  sale: 0,
  classifiedLoss: 0,
  adjustmentUnclassified: 0,
  correctionUnclassified: 0,
  countOut: 0,
  stockInReversal: 0,
};

const sumOf = (m: OutboundMix): number => Object.values(m).reduce((a, b) => a + b, 0);

beforeEach(() => {
  mockReset(db);
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// C12 — the partition (LIVE at W2 entry; RED until Task 2.1 lands the module)
// ---------------------------------------------------------------------------

describe("C12 classifyOutboundMix — the six-bucket partition (contract pack T1)", () => {
  it("partitions the canonical fixture, EVERY bucket asserted, sum == SUM(|delta|)", () => {
    const rows = [
      { delta: -5, logType: "SALE", reasonCode: null },
      { delta: -3, logType: "ADJUSTMENT", reasonCode: "DAMAGE" }, // classifiedLoss
      { delta: -7, logType: "ADJUSTMENT", reasonCode: null }, // adjustmentUnclassified
      { delta: -2, logType: "CORRECTION", reasonCode: null }, // correctionUnclassified
      { delta: -4, logType: "COUNT", reasonCode: null }, // countOut
      { delta: -6, logType: "STOCK_IN", reasonCode: null }, // stockInReversal (the gate-blocker row)
    ];
    const mix = classifyOutboundMix(rows);
    expect(mix).toEqual({
      sale: 5,
      classifiedLoss: 3,
      adjustmentUnclassified: 7,
      correctionUnclassified: 2,
      countOut: 4,
      stockInReversal: 6,
    });
    expect(mix.stockInReversal).toBe(6);
    expect(sumOf(mix)).toBe(27);
    expect(sumOf(mix)).toBe(rows.reduce((s, r) => s + Math.abs(r.delta), 0));
  });

  it("uses ABSOLUTE unit magnitudes (G3) — never the signed ledger delta", () => {
    const mix = classifyOutboundMix([{ delta: -12, logType: "SALE", reasonCode: null }]);
    expect(mix).toEqual({ ...ZERO, sale: 12 });
  });

  it("returns the all-zero mix for an empty row set", () => {
    expect(classifyOutboundMix([])).toEqual(ZERO);
  });

  it.each([
    ["DAMAGE"],
    ["THEFT"],
    ["EXPIRY"],
    ["COUNT"],
  ])("ADJUSTMENT reasoned %s is classifiedLoss, never adjustmentUnclassified", (reason) => {
    expect(classifyOutboundMix([{ delta: -9, logType: "ADJUSTMENT", reasonCode: reason }])).toEqual({
      ...ZERO,
      classifiedLoss: 9,
    });
  });

  it.each([
    ["DAMAGE"],
    ["THEFT"],
    ["EXPIRY"],
    ["COUNT"],
  ])("CORRECTION reasoned %s is classifiedLoss, never correctionUnclassified", (reason) => {
    expect(classifyOutboundMix([{ delta: -9, logType: "CORRECTION", reasonCode: reason }])).toEqual({
      ...ZERO,
      classifiedLoss: 9,
    });
  });

  it("an ADJUSTMENT reasoned 'CORRECTION' is adjustmentUnclassified (the reason is not a logType)", () => {
    expect(classifyOutboundMix([{ delta: -9, logType: "ADJUSTMENT", reasonCode: "CORRECTION" }])).toEqual({
      ...ZERO,
      adjustmentUnclassified: 9,
    });
  });

  it("an unrecognised reason falls to the logType's unclassified bucket", () => {
    expect(classifyOutboundMix([{ delta: -4, logType: "ADJUSTMENT", reasonCode: "SOMETHING_ELSE" }])).toEqual({
      ...ZERO,
      adjustmentUnclassified: 4,
    });
    expect(classifyOutboundMix([{ delta: -4, logType: "CORRECTION", reasonCode: "SOMETHING_ELSE" }])).toEqual({
      ...ZERO,
      correctionUnclassified: 4,
    });
  });

  // OC-9: the shrinkage set is UPPERCASE, so a lowercase reasonCode fell through to the
  // unclassified bucket — a REAL classified loss reported as unclassified depletion, in
  // the one place this lane exists to keep honest.
  it("matches the shrinkage set CASE-INSENSITIVELY ('damage' is classifiedLoss)", () => {
    expect(classifyOutboundMix([{ delta: -5, logType: "ADJUSTMENT", reasonCode: "damage" }])).toEqual({
      ...ZERO,
      classifiedLoss: 5,
    });
    expect(classifyOutboundMix([{ delta: -2, logType: "CORRECTION", reasonCode: "Theft" }])).toEqual({
      ...ZERO,
      classifiedLoss: 2,
    });
    // ...and a genuinely unrecognised reason is STILL unclassified (the normalization
    // widens the match, it does not soften the taxonomy).
    expect(classifyOutboundMix([{ delta: -3, logType: "ADJUSTMENT", reasonCode: "damaged" }])).toEqual({
      ...ZERO,
      adjustmentUnclassified: 3,
    });
  });

  it("an UNKNOWN logType mirrors movement's default (adjustmentUnclassified), never dropped", () => {
    // Unreachable for real rows (logType is the Prisma enum) — pinned so the two
    // classifiers can never diverge on the fallback.
    expect(classifyOutboundMix([{ delta: -8, logType: "WAT", reasonCode: null }])).toEqual({
      ...ZERO,
      adjustmentUnclassified: 8,
    });
  });

  it("THROWS a plain Error on a TRANSFER row (precondition violation, never bucketed)", () => {
    expect(() => classifyOutboundMix([{ delta: -3, logType: "TRANSFER", reasonCode: null }])).toThrow(Error);
    expect(() => classifyOutboundMix([{ delta: -3, logType: "TRANSFER", reasonCode: null }])).toThrow(
      /TRANSFER/,
    );
  });

  it("THROWS a plain Error on a non-negative row (delta 0 and delta > 0 alike)", () => {
    expect(() => classifyOutboundMix([{ delta: 0, logType: "SALE", reasonCode: null }])).toThrow(Error);
    expect(() => classifyOutboundMix([{ delta: 5, logType: "SALE", reasonCode: null }])).toThrow(Error);
  });

  it("the precondition throw is NOT an AppError-style tool error (no code/statusCode)", () => {
    try {
      classifyOutboundMix([{ delta: 1, logType: "SALE", reasonCode: null }]);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as { code?: unknown }).code).toBeUndefined();
      expect((err as { statusCode?: unknown }).statusCode).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// C12 — caller populations (one per consumer; the predicates differ BY DESIGN)
// ---------------------------------------------------------------------------

describe("C12 caller populations — each consumer feeds its OWN predicate's rows", () => {
  it("get_operations outboundMix30: the PHYSICAL population includes a CORRECTION-reasoned ADJUSTMENT", async () => {
    // The 30-day outbound read is the ONE regrouped read (productId, logType, reasonCode):
    // same scan, so the mix can never disagree with unitsOut30.
    db.product.findMany.mockResolvedValue([
      { id: 1, name: "Widget", costPrice: null, lowStockThreshold: null, product_locations: [{ quantity: 50 }] },
    ] as never);
    db.systemSetting.findUnique.mockResolvedValue(null as never);
    db.inventory_logs.findMany.mockResolvedValue([] as never);
    db.productStockSnapshot.findMany.mockResolvedValue([] as never);
    db.productStockSnapshot.aggregate.mockResolvedValue({ _min: { dayKey: null } } as never);
    db.inventory_logs.aggregate.mockResolvedValue({ _min: { changeTime: daysAgo(200) } } as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.inventory_logs.groupBy.mockImplementation((args: any) => {
      const by = (args.by ?? []) as string[];
      if (by.length === 3) {
        // The regrouped 30-day physical-outbound read.
        return Promise.resolve([
          { productId: 1, logType: "SALE", reasonCode: null, _sum: { delta: -10 }, _min: { changeTime: daysAgo(10) } },
          { productId: 1, logType: "ADJUSTMENT", reasonCode: "CORRECTION", _sum: { delta: -6 }, _min: { changeTime: daysAgo(4) } },
          { productId: 1, logType: "STOCK_IN", reasonCode: null, _sum: { delta: -2 }, _min: { changeTime: daysAgo(2) } },
        ]) as never;
      }
      return Promise.resolve([]) as never;
    });

    const { rows } = await getOperationsRows({ windowDays: 30 });
    const row = rows.find((r) => r.productId === 1)!;
    expect(row.unitsOut30).toBe(18);
    expect(row.outboundMix30).toEqual({
      ...ZERO,
      sale: 10,
      adjustmentUnclassified: 6, // the CORRECTION-REASONED row IS physical outbound
      stockInReversal: 2,
    });
    // NORMATIVE (spec C12): bucket sum == unitsOut30.
    expect(sumOf(row.outboundMix30!)).toBe(row.unitsOut30);
  });

  it("get_operations outboundMix30 is null EXACTLY when unitsOut30 is null", async () => {
    db.product.findMany.mockResolvedValue([
      { id: 1, name: "Idle", costPrice: null, lowStockThreshold: null, product_locations: [{ quantity: 5 }] },
    ] as never);
    db.systemSetting.findUnique.mockResolvedValue(null as never);
    db.inventory_logs.findMany.mockResolvedValue([] as never);
    db.inventory_logs.groupBy.mockResolvedValue([] as never);
    db.productStockSnapshot.findMany.mockResolvedValue([] as never);
    db.productStockSnapshot.aggregate.mockResolvedValue({ _min: { dayKey: null } } as never);
    db.inventory_logs.aggregate.mockResolvedValue({ _min: { changeTime: null } } as never);

    const { rows } = await getOperationsRows({ windowDays: 30 });
    expect(rows[0].unitsOut30).toBeNull();
    expect(rows[0].outboundMix30).toBeNull();
  });

  it("reorder demandMix: the reorder predicate DROPS the CORRECTION-reasoned row before the classifier", async () => {
    db.inventory_logs.findMany.mockResolvedValue([
      { productId: 1, delta: -10, changeTime: daysAgo(10), logType: "SALE", reasonCode: null },
      // Physical outbound, but NOT reorder demand — excluded by the LOCKED predicate.
      { productId: 1, delta: -6, changeTime: daysAgo(4), logType: "ADJUSTMENT", reasonCode: "CORRECTION" },
      { productId: 1, delta: -4, changeTime: daysAgo(2), logType: "ADJUSTMENT", reasonCode: "DAMAGE" },
    ] as never);

    const map = await reorderDemand([1], 90);
    const demand = map.get(1)!;
    expect(demand.demandUnits).toBe(14); // 10 + 4 — never the 6
    expect(demand.mix).toEqual({ ...ZERO, sale: 10, classifiedLoss: 4 });
    // NORMATIVE (spec C12): bucket sum == demandUnits.
    expect(sumOf(demand.mix!)).toBe(demand.demandUnits);
  });

  it("reorder demandMix is null when the product has no qualifying row (never a zero mix)", async () => {
    db.inventory_logs.findMany.mockResolvedValue([
      { productId: 1, delta: -6, changeTime: daysAgo(4), logType: "ADJUSTMENT", reasonCode: "CORRECTION" },
    ] as never);
    const map = await reorderDemand([1, 2], 90);
    expect(map.get(1)).toEqual({
      avgDailyDemand: null,
      outboundEvents: 0,
      daysCovered: 0,
      demandUnits: 0,
      mix: null,
    });
    expect(map.get(2)!.mix).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T2 — productIdentities: the ONE name/lifecycle lookup (2.2/2.3/2.4/3.1/3.2)
// ---------------------------------------------------------------------------

describe("T2 productIdentities — the shared name/lifecycle map", () => {
  it("maps id -> { name, lifecycle } with lifecycle derived from deletedAt", async () => {
    db.product.findMany.mockResolvedValue([
      { id: 1, name: "Active One", deletedAt: null },
      { id: 2, name: "Archived One", deletedAt: new Date("2026-01-01T00:00:00.000Z") },
    ] as never);
    const map = await productIdentities([1, 2]);
    expect(map.get(1)).toEqual({ name: "Active One", lifecycle: "active" });
    expect(map.get(2)).toEqual({ name: "Archived One", lifecycle: "deleted" });
  });

  it("reads id/name/deletedAt only and applies NO approval filter (callers pass scoped ids)", async () => {
    db.product.findMany.mockResolvedValue([] as never);
    await productIdentities([3, 3, 4]);
    const args = db.product.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
    };
    expect(args.select).toEqual({ id: true, name: true, deletedAt: true });
    expect(args.where).toEqual({ id: { in: [3, 4] } }); // deduped; no approvalStatus predicate
  });

  it("an ABSENT id has NO map entry (callers null it themselves)", async () => {
    db.product.findMany.mockResolvedValue([{ id: 1, name: "Only", deletedAt: null }] as never);
    const map = await productIdentities([1, 99]);
    expect(map.has(99)).toBe(false);
    expect(map.size).toBe(1);
  });

  it("returns an empty map for an empty id list WITHOUT querying", async () => {
    const map = await productIdentities([]);
    expect(map.size).toBe(0);
    expect(db.product.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// C6 — get_sales dataStart + zero-vs-null. OWNED BY TASK 2.2.
// Task 2.2 Step 1: unskip this describe, run it, VERIFY RED, then implement.
// ---------------------------------------------------------------------------

describe("C6 get_sales — salesDataStart / windowCoverage / includeZeroRows (Task 2.2)", () => {
  const CTX = testCtx({ companyIds: ["c1"] });

  /** Seed the get_sales read graph: coverage counts, the sales facts, and the
   *  approved-active catalog the zero-row population reads. */
  function seedSales(opts: {
    salesDataStart: string | null;
    facts?: Array<{ productId: number; _sum: Record<string, unknown> }>;
    catalog?: Array<{ id: number; name: string }>;
    firstSale?: Array<{ productId: number; _min: { dayKey: string } }>;
    /** OC-3: the PER-COMPANY first-fact days behind `salesDataStart` (which is their min). */
    companyStarts?: Array<{ companyId: string; _min: { dayKey: string } }>;
  }) {
    db.externalOrder.count.mockResolvedValue(0 as never);
    db.analyticsRebuildState.findUnique.mockResolvedValue(null as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.aggregate.mockResolvedValue({ _min: { dayKey: opts.salesDataStart } } as any);
    // THREE different groupBys now share this delegate — the per-company starts (by
    // companyId), the post-pagination firstSale evidence (_min), and the facts read —
    // so the seed dispatches on the SHAPE each one actually sends.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.groupBy.mockImplementation((args: any) => {
      if (args?.by?.[0] === "companyId") return Promise.resolve(opts.companyStarts ?? []) as never;
      if (args?._min) return Promise.resolve(opts.firstSale ?? []) as never;
      return Promise.resolve(opts.facts ?? []) as never;
    });
    db.product.findMany.mockResolvedValue((opts.catalog ?? []) as never);
  }

  const okData = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = await assistantTools.get_sales.run(args, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("not ok");
    return result.data as Record<string, unknown>;
  };

  it("coverage carries salesDataStart + windowCoverage + the always-on rowsNote", async () => {
    seedSales({ salesDataStart: "2020-01-01" });
    const data = await okData({ groupBy: "product", relativeDays: 30 });
    const coverage = data.coverage as Record<string, unknown>;
    expect(coverage.salesDataStart).toBe("2020-01-01");
    expect(coverage.windowCoverage).toBe("full");
    expect(coverage.rowsNote).toContain("includeZeroRows");
    expect(coverage.rowsNote).toContain("unattributedOrders");
  });

  it("windowCoverage is 'partial' when the window predates/straddles salesDataStart", async () => {
    seedSales({ salesDataStart: "2099-01-01" });
    const data = await okData({ groupBy: "product", relativeDays: 30 });
    expect((data.coverage as Record<string, unknown>).windowCoverage).toBe("partial");
  });

  it("windowCoverage is 'none' when the caller has NO attributed sales facts at all", async () => {
    seedSales({ salesDataStart: null });
    const data = await okData({ groupBy: "product", relativeDays: 30 });
    const coverage = data.coverage as Record<string, unknown>;
    expect(coverage.salesDataStart).toBeNull();
    expect(coverage.windowCoverage).toBe("none");
  });

  it("FULL coverage: a product with no facts emits a MEASURED zero row (0 / '0' / 0)", async () => {
    seedSales({
      salesDataStart: "2020-01-01",
      facts: [{ productId: 1, _sum: { orderedQty: 5, revenue: "10.00", orderCount: 2 } }],
      catalog: [
        { id: 1, name: "Sold" },
        { id: 2, name: "Silent" },
      ],
    });
    const data = await okData({ groupBy: "product", includeZeroRows: true, relativeDays: 30 });
    const rows = data.rows as Array<Record<string, unknown>>;
    const zero = rows.find((r) => r.productId === 2)!;
    expect(zero._sum).toEqual({ orderedQty: 0, revenue: "0", orderCount: 0 });
    expect(zero.reason).toBeUndefined(); // a measured 0 carries no reason
    expect(zero.name).toBe("Silent");
  });

  // OC-7: the synthesized zero row used to emit "0.00" while a MEASURED zero — a real
  // Prisma.Decimal(0) through serialize.ts — emits "0". Same value, two formats, and the
  // format was the only thing distinguishing a real row from a synthesized one.
  it("a synthesized zero's revenue matches what a REAL Decimal(0) serializes to", async () => {
    seedSales({
      salesDataStart: "2020-01-01",
      // A genuine measured zero: the fact row's revenue is a real Prisma.Decimal, which
      // is what the sales read returns in production (serialize.ts calls .toString()).
      facts: [
        {
          productId: 1,
          _sum: { orderedQty: 0, revenue: new Prisma.Decimal(0), orderCount: 0 },
        },
      ],
      catalog: [
        { id: 1, name: "Measured zero" },
        { id: 2, name: "Silent" },
      ],
    });
    const data = await okData({ groupBy: "product", includeZeroRows: true, relativeDays: 30 });
    const byId = Object.fromEntries(
      (data.rows as Array<Record<string, unknown>>).map((r) => [r.productId, r]),
    );
    const measured = (byId[1] as { _sum: { revenue: unknown } })._sum.revenue;
    const synthesized = (byId[2] as { _sum: { revenue: unknown } })._sum.revenue;
    expect(measured).toBe("0"); // Decimal(0).toString() — the format the tool really emits
    expect(synthesized).toBe(measured);
  });

  it("serializes a non-integer Decimal through the SAME path (no format drift)", async () => {
    seedSales({
      salesDataStart: "2020-01-01",
      facts: [
        {
          productId: 1,
          _sum: { orderedQty: 3, revenue: new Prisma.Decimal("12.50"), orderCount: 1 },
        },
      ],
      catalog: [{ id: 1, name: "Sold" }],
    });
    const data = await okData({ groupBy: "product", relativeDays: 30 });
    const row = (data.rows as Array<{ _sum: { revenue: unknown } }>)[0];
    // Decimal keeps its own canonical form ("12.5"): the tool relays .toString(), it does
    // not re-format money — so this is the string a consumer must be ready to parse.
    expect(row._sum.revenue).toBe(new Prisma.Decimal("12.50").toString());
  });

  it("PARTIAL coverage: the zero row's sums are NULL + a reason naming the recording boundary", async () => {
    seedSales({
      salesDataStart: "2099-01-01",
      catalog: [{ id: 2, name: "Silent" }],
    });
    const data = await okData({ groupBy: "product", includeZeroRows: true, relativeDays: 30 });
    const zero = (data.rows as Array<Record<string, unknown>>).find((r) => r.productId === 2)!;
    expect(zero._sum).toEqual({ orderedQty: null, revenue: null, orderCount: null });
    expect(zero.reason).toContain("2099-01-01");
  });

  it("NULL salesDataStart: the DISTINCT reason (the starts-<date> template has no truthful substitution)", async () => {
    seedSales({ salesDataStart: null, catalog: [{ id: 2, name: "Silent" }] });
    const data = await okData({ groupBy: "product", includeZeroRows: true, relativeDays: 30 });
    const zero = (data.rows as Array<Record<string, unknown>>).find((r) => r.productId === 2)!;
    expect(zero.reason).toBe("no attributed sales data recorded");
    expect(zero._sum).toEqual({ orderedQty: null, revenue: null, orderCount: null });
  });

  it("zero rows carry firstSaleDayKey as EVIDENCE (not a creation date), null when absent", async () => {
    seedSales({
      salesDataStart: "2020-01-01",
      catalog: [
        { id: 2, name: "Silent" },
        { id: 3, name: "Never" },
      ],
      firstSale: [{ productId: 2, _min: { dayKey: "2021-03-04" } }],
    });
    const data = await okData({ groupBy: "product", includeZeroRows: true, relativeDays: 30 });
    const byId = Object.fromEntries(
      (data.rows as Array<Record<string, unknown>>).map((r) => [r.productId, r]),
    );
    expect(byId[2].firstSaleDayKey).toBe("2021-03-04");
    expect(byId[3].firstSaleDayKey).toBeNull();
  });

  it("includeZeroRows is REJECTED with a hint at any grain but 'product' (G1 assert)", async () => {
    seedSales({ salesDataStart: "2020-01-01" });
    await expect(
      assistantTools.get_sales.run({ groupBy: "day", includeZeroRows: true }, CTX),
    ).rejects.toMatchObject({ errors: [expect.objectContaining({ message: expect.any(String) })] });
  });

  it("includeZeroRows is REJECTED with a hint when a productId is passed (G1 assert)", async () => {
    seedSales({ salesDataStart: "2020-01-01" });
    db.product.findFirst.mockResolvedValue({ id: 1, name: "P" } as never);
    await expect(
      assistantTools.get_sales.run({ groupBy: "product", productId: 1, includeZeroRows: true }, CTX),
    ).rejects.toBeDefined();
  });

  // -------------------------------------------------------------------------
  // OC-3 — MULTI-MEMBERSHIP coverage. `salesDataStart` is the EARLIEST across the
  // caller's companies, so a caller in two companies whose second one started
  // recording last month read the whole window as "full" — and every silence in that
  // company's window became a MEASURED zero for a period it has no data for.
  // -------------------------------------------------------------------------

  describe("OC-3 multi-membership: the LATEST-starting company governs zero legality", () => {
    const MULTI = testCtx({ companyIds: ["c1", "c2"] });

    const multiData = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const result = await assistantTools.get_sales.run(args, MULTI);
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("not ok");
      return result.data as Record<string, unknown>;
    };

    it("STAGGERED starts degrade the window to 'partial' and disclose the per-company starts", async () => {
      seedSales({
        // c1 has recorded since 2020; c2 only since a day inside the 30-day window.
        salesDataStart: "2020-01-01",
        companyStarts: [
          { companyId: "c1", _min: { dayKey: "2020-01-01" } },
          { companyId: "c2", _min: { dayKey: "2099-01-01" } },
        ],
        catalog: [{ id: 2, name: "Silent" }],
      });
      const data = await multiData({ groupBy: "product", includeZeroRows: true, relativeDays: 30 });
      const coverage = data.coverage as Record<string, unknown>;

      // The earliest start alone would have said "full" — and manufactured zeros.
      expect(coverage.windowCoverage).toBe("partial");
      expect(coverage.companyCoverage).toEqual([
        { companyId: "c1", salesDataStart: "2020-01-01" },
        { companyId: "c2", salesDataStart: "2099-01-01" },
      ]);
      expect(coverage.rowsNote).toContain(
        "coverage classified per company; the latest-starting company governs zero legality",
      );

      // ...and NO measured zero was manufactured for the late company's window.
      const zero = (data.rows as Array<Record<string, unknown>>).find((r) => r.productId === 2)!;
      expect(zero._sum).toEqual({ orderedQty: null, revenue: null, orderCount: null });
      expect(zero.reason).toEqual(expect.any(String));
    });

    it("SHARED starts keep 'full' coverage, measured zeros, and no per-company noise", async () => {
      seedSales({
        salesDataStart: "2020-01-01",
        companyStarts: [
          { companyId: "c1", _min: { dayKey: "2020-01-01" } },
          { companyId: "c2", _min: { dayKey: "2020-01-01" } },
        ],
        catalog: [{ id: 2, name: "Silent" }],
      });
      const data = await multiData({ groupBy: "product", includeZeroRows: true, relativeDays: 30 });
      const coverage = data.coverage as Record<string, unknown>;
      expect(coverage.windowCoverage).toBe("full");
      // Presence of companyCoverage IS the stagger signal — absent when they agree.
      expect(coverage.companyCoverage).toBeUndefined();
      expect(coverage.rowsNote).not.toContain("per company");
      const zero = (data.rows as Array<Record<string, unknown>>).find((r) => r.productId === 2)!;
      expect(zero._sum).toEqual({ orderedQty: 0, revenue: "0", orderCount: 0 });
    });

    it("a staggered set whose LATEST start still covers the window stays 'full'", async () => {
      seedSales({
        salesDataStart: "2020-01-01",
        companyStarts: [
          { companyId: "c1", _min: { dayKey: "2020-01-01" } },
          { companyId: "c2", _min: { dayKey: "2021-06-01" } }, // still well before the window
        ],
        catalog: [{ id: 2, name: "Silent" }],
      });
      const data = await multiData({ groupBy: "product", includeZeroRows: true, relativeDays: 30 });
      const coverage = data.coverage as Record<string, unknown>;
      expect(coverage.windowCoverage).toBe("full");
      // The starts DIFFER, so they are disclosed — the degradation is about coverage,
      // not about hiding the difference.
      expect(coverage.companyCoverage).toHaveLength(2);
      const zero = (data.rows as Array<Record<string, unknown>>).find((r) => r.productId === 2)!;
      expect(zero._sum).toEqual({ orderedQty: 0, revenue: "0", orderCount: 0 });
    });
  });
});

// ---------------------------------------------------------------------------
// C9 — compare_periods by_product. OWNED BY TASK 2.3.
// Task 2.3 Step 1: unskip this describe, run it, VERIFY RED, then implement.
// ---------------------------------------------------------------------------

describe("C9 compare_periods by_product — ranked deltas + unranked coverage rows (Task 2.3)", () => {
  const CTX = testCtx({ companyIds: ["c1"] });

  const okData = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = await assistantTools.compare_periods.run(args, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("not ok");
    return result.data as Record<string, unknown>;
  };

  /** Seed the sales source: one dataStart + per-product sums per period. */
  function seedSales(opts: {
    dataStart: string | null;
    a: Array<{ productId: number; _sum: { orderedQty: number } }>;
    b: Array<{ productId: number; _sum: { orderedQty: number } }>;
    names?: Array<{ id: number; name: string; deletedAt: Date | null }>;
  }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.aggregate.mockResolvedValue({ _min: { dayKey: opts.dataStart } } as any);
    let call = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.groupBy.mockImplementation(() =>
      Promise.resolve(call++ === 0 ? opts.a : opts.b) as never,
    );
    db.product.findMany.mockResolvedValue((opts.names ?? []) as never);
  }

  it("mode 'totals' rides on the scalar payload (ADDITIVE — the discriminant is new)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.inventory_logs.aggregate.mockResolvedValue({ _min: { changeTime: null }, _sum: { delta: null } } as any);
    const data = await okData({
      metric: "outbound_units",
      periodA: { relativeDays: 7 },
      periodB: { relativeDays: 7 },
    });
    expect(data.mode).toBe("totals");
  });

  it("ranks by |delta| desc, ties by delta desc then productId asc, direction BEFORE pagination", async () => {
    seedSales({
      dataStart: "2020-01-01",
      a: [
        { productId: 1, _sum: { orderedQty: 10 } },
        { productId: 2, _sum: { orderedQty: 10 } },
        { productId: 3, _sum: { orderedQty: 10 } },
      ],
      b: [
        { productId: 1, _sum: { orderedQty: 30 } }, // +20
        { productId: 2, _sum: { orderedQty: 5 } }, // -5
        { productId: 3, _sum: { orderedQty: 15 } }, // +5 (ties |5| with product 2)
      ],
      names: [
        { id: 1, name: "One", deletedAt: null },
        { id: 2, name: "Two", deletedAt: null },
        { id: 3, name: "Three", deletedAt: null },
      ],
    });
    const data = await okData({
      metric: "sales_units",
      periodA: { relativeDays: 7 },
      periodB: { relativeDays: 7 },
      groupBy: "product",
    });
    expect(data.mode).toBe("by_product");
    const rows = data.rows as Array<Record<string, unknown>>;
    // |20| first; then the |5| tie broken by delta desc (+5 before -5).
    expect(rows.map((r) => r.productId)).toEqual([1, 3, 2]);
    expect(rows[0].delta).toBe(20);
    expect(rows[0].name).toBe("One");
    expect(rows[0].lifecycle).toBe("active");
    expect(data.unranked).toEqual([]);
    expect(data.totalRows).toBe(3);
  });

  it("direction:'increase' filters the RANKED set before paging (totalRows is post-direction)", async () => {
    seedSales({
      dataStart: "2020-01-01",
      a: [
        { productId: 1, _sum: { orderedQty: 10 } },
        { productId: 2, _sum: { orderedQty: 10 } },
      ],
      b: [
        { productId: 1, _sum: { orderedQty: 30 } },
        { productId: 2, _sum: { orderedQty: 5 } },
      ],
      names: [
        { id: 1, name: "One", deletedAt: null },
        { id: 2, name: "Two", deletedAt: null },
      ],
    });
    const data = await okData({
      metric: "sales_units",
      periodA: { relativeDays: 7 },
      periodB: { relativeDays: 7 },
      groupBy: "product",
      direction: "increase",
    });
    expect((data.rows as unknown[]).length).toBe(1);
    expect(data.totalRows).toBe(1);
    expect((data.rows as Array<Record<string, unknown>>)[0].productId).toBe(1);
  });

  it("'started moving' is a RANKED row with a MEASURED a == 0 under full coverage", async () => {
    seedSales({
      dataStart: "2020-01-01",
      a: [], // no facts in period A — but the source covers it, so a is a measured 0
      b: [{ productId: 1, _sum: { orderedQty: 12 } }],
      names: [{ id: 1, name: "One", deletedAt: null }],
    });
    const data = await okData({
      metric: "sales_units",
      periodA: { relativeDays: 7 },
      periodB: { relativeDays: 7 },
      groupBy: "product",
    });
    const row = (data.rows as Array<Record<string, unknown>>)[0];
    expect(row.a).toBe(0);
    expect(row.b).toBe(12);
    expect(row.delta).toBe(12);
    expect(data.unranked).toEqual([]);
  });

  it("unranked is a COVERAGE ARTIFACT: a period predating the source moves EVERY product, all at once", async () => {
    seedSales({
      dataStart: "2099-01-01", // the source starts after both windows
      a: [],
      b: [{ productId: 1, _sum: { orderedQty: 12 } }],
      names: [{ id: 1, name: "One", deletedAt: null }],
    });
    const data = await okData({
      metric: "sales_units",
      periodA: { relativeDays: 7 },
      periodB: { relativeDays: 7 },
      groupBy: "product",
    });
    expect(data.rows).toEqual([]);
    const unranked = data.unranked as Array<Record<string, unknown>>;
    expect(unranked.length).toBeGreaterThan(0);
    expect(unranked[0].delta).toBeNull();
    expect(unranked[0].pctChange).toBeNull();
    expect(unranked[0].reasons).toBeDefined();
    expect(data.totalRows).toBe(0);
  });

  // These two assert on the ZodError MESSAGE, not merely "it rejected": an unseeded
  // deep mock throws a TypeError from the read graph, which would false-green a bare
  // `.rejects.toBeDefined()` while the assert was still missing.
  const hintOf = async (args: Record<string, unknown>): Promise<string> => {
    try {
      await assistantTools.compare_periods.run(args, CTX);
    } catch (err) {
      if (err instanceof ZodError) return err.errors[0]?.message ?? "";
      throw new Error(`expected a ZodError, got ${(err as Error).constructor.name}: ${(err as Error).message}`);
    }
    throw new Error("expected a rejection");
  };

  it("groupBy and productId are mutually exclusive (G1 assert)", async () => {
    db.product.findFirst.mockResolvedValue({ id: 1, name: "P" } as never);
    const message = await hintOf({
      metric: "sales_units",
      periodA: { relativeDays: 7 },
      periodB: { relativeDays: 7 },
      groupBy: "product",
      productId: 1,
    });
    expect(message).toMatch(/groupBy/);
    expect(message).toMatch(/productId/);
  });

  it("direction/limit/offset REQUIRE groupBy:'product' (G1 assert)", async () => {
    for (const extra of [{ direction: "increase" }, { limit: 5 }, { offset: 0 }]) {
      const message = await hintOf({
        metric: "sales_units",
        periodA: { relativeDays: 7 },
        periodB: { relativeDays: 7 },
        ...extra,
      });
      expect(message).toMatch(/groupBy/);
    }
  });

  it("JOINT byte fit — ranked-only (full coverage) shrinks the page, never a truncation notice", async () => {
    seedSales({
      dataStart: "2020-01-01",
      a: Array.from({ length: 40 }, (_, i) => ({ productId: i + 1, _sum: { orderedQty: 10 } })),
      b: Array.from({ length: 40 }, (_, i) => ({ productId: i + 1, _sum: { orderedQty: 10 + i } })),
      names: Array.from({ length: 40 }, (_, i) => ({
        id: i + 1,
        name: `Product ${"x".repeat(40)} ${i + 1}`,
        deletedAt: null,
      })),
    });
    const result = await assistantTools.compare_periods.run(
      { metric: "sales_units", periodA: { relativeDays: 7 }, periodB: { relativeDays: 7 }, groupBy: "product" },
      testCtx({ companyIds: ["c1"], remainingBytes: 5_000 }),
    );
    expect(result.status).toBe("ok"); // NEVER the last-resort truncation downgrade
    if (result.status !== "ok") return;
    const data = result.data as Record<string, unknown>;
    expect((data.rows as unknown[]).length).toBeLessThan(40);
    expect((data.rows as unknown[]).length).toBeGreaterThan(0);
    expect(data.nextOffset).not.toBeNull();
  });

  // Seam S8 (contract pack): get_sales' windowCoverage and compare_periods' per-period
  // resolution must classify ONE seeded source IDENTICALLY. Shared constants would be
  // setup, not verification — so both paths are DRIVEN here against the same dataStart.
  it.each([
    ["2020-01-01", "full", 0],
    ["2099-01-01", "partial", 1],
    [null, "none", 1],
  ])(
    "S8: dataStart %s classifies as %s in get_sales AND leaves compare's period unranked (%s)",
    async (dataStart, expected, unrankedCount) => {
      seedSales({
        dataStart: dataStart as string | null,
        a: [{ productId: 1, _sum: { orderedQty: 5 } }],
        b: [{ productId: 1, _sum: { orderedQty: 9 } }],
        names: [{ id: 1, name: "One", deletedAt: null }],
      });
      db.externalOrder.count.mockResolvedValue(0 as never);
      db.analyticsRebuildState.findUnique.mockResolvedValue(null as never);

      const sales = await assistantTools.get_sales.run({ groupBy: "product", relativeDays: 7 }, CTX);
      expect(sales.status).toBe("ok");
      if (sales.status !== "ok") return;
      const salesCoverage = (sales.data as { coverage: Record<string, unknown> }).coverage;
      expect(salesCoverage.windowCoverage).toBe(expected);

      const compare = await okData({
        metric: "sales_units",
        periodA: { relativeDays: 7 },
        periodB: { relativeDays: 7 },
        groupBy: "product",
      });
      // The SAME verdict, reached independently by the other surface.
      expect((compare.coverage as { periodCoverage: { a: string } }).periodCoverage.a).toBe(expected);
      expect((compare.unranked as unknown[]).length).toBe(unrankedCount);
    },
  );

  it("JOINT byte fit — unranked-only (period predates the source) shrinks the unranked array", async () => {
    seedSales({
      dataStart: "2099-01-01",
      a: [],
      b: Array.from({ length: 40 }, (_, i) => ({ productId: i + 1, _sum: { orderedQty: 10 } })),
      names: Array.from({ length: 40 }, (_, i) => ({
        id: i + 1,
        name: `Product ${"x".repeat(40)} ${i + 1}`,
        deletedAt: null,
      })),
    });
    const result = await assistantTools.compare_periods.run(
      { metric: "sales_units", periodA: { relativeDays: 7 }, periodB: { relativeDays: 7 }, groupBy: "product" },
      testCtx({ companyIds: ["c1"], remainingBytes: 5_000 }),
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const data = result.data as Record<string, unknown>;
    expect(data.rows).toEqual([]);
    expect((data.unranked as unknown[]).length).toBeGreaterThan(0);
    expect((data.unranked as unknown[]).length).toBeLessThan(40);
  });
});
