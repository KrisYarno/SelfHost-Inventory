// Lane 3 (Task 5) + Lane 6 (Task 8 / L-TRUTH): tier-1 Operations query math over a
// mocked prisma. Every groupBy/aggregate call is dispatched by its `where`/aggregation
// shape so a single mock drives the whole getOperationsRows fan-out.
//
// Lane 6 truthfulness pins (review B1/B2/B3, spec D-T2/T3/T4):
//   * cost null propagation + null valuation (not $0.00)
//   * classified-only shrinkage; unclassified outbound is coverage, never loss
//   * ONE outbound predicate (delta<0, non-TRANSFER); per-product null, never a 0
//     fallback; velocity denominator clamped to the window actually covered
//   * the live hazard is dead: one SALE row cannot flip other products to 0 nor
//     collapse the denominator.

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { findMany: jest.fn() },
    systemSetting: { findUnique: jest.fn() },
    inventory_logs: { groupBy: jest.fn(), findMany: jest.fn(), aggregate: jest.fn() },
    productStockSnapshot: { findMany: jest.fn(), aggregate: jest.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getOperationsRows, getShrinkageSummary, getValuationSummary } from "@/lib/analytics/queries";

const m = prisma as unknown as {
  product: { findMany: jest.Mock };
  systemSetting: { findUnique: jest.Mock };
  inventory_logs: { groupBy: jest.Mock; findMany: jest.Mock; aggregate: jest.Mock };
  productStockSnapshot: { findMany: jest.Mock; aggregate: jest.Mock };
};

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

interface OpsFixtures {
  products?: any[];
  systemSetting?: { value: string } | null;
  outbound30?: any[];
  outbound90?: any[];
  inbound?: any[];
  lastOutbound?: any[];
  shrink90?: any[];
  corrections90?: any[];
  snapshots?: any[];
  receiptMax?: any[];
  receiptRows?: any[];
  saleStart?: Date | null;
  outboundStart?: Date | null;
  adjustmentStart?: Date | null;
  receiptStart?: Date | null;
  snapshotStart?: string | null;
}

function setupOps(f: OpsFixtures) {
  m.product.findMany.mockResolvedValue(f.products ?? []);
  m.systemSetting.findUnique.mockResolvedValue(f.systemSetting ?? null);
  m.inventory_logs.findMany.mockResolvedValue(f.receiptRows ?? []);
  m.productStockSnapshot.findMany.mockResolvedValue(f.snapshots ?? []);
  m.productStockSnapshot.aggregate.mockResolvedValue({ _min: { dayKey: f.snapshotStart ?? null } });

  m.inventory_logs.groupBy.mockImplementation((args: any) => {
    const w = args.where ?? {};
    if (w.logType === "STOCK_IN" && args._max) return Promise.resolve(f.receiptMax ?? []);
    if (w.reasonCode?.in && args._sum) return Promise.resolve(f.shrink90 ?? []); // classified shrink90
    if (w.reasonCode === "CORRECTION" && args._count) return Promise.resolve(f.corrections90 ?? []);
    if (w.delta?.gt === 0 && args._max) return Promise.resolve(f.inbound ?? []);
    // OUTBOUND predicate = delta<0 AND logType != TRANSFER.
    if (w.logType?.not === "TRANSFER" && args._max) return Promise.resolve(f.lastOutbound ?? []);
    if (w.logType?.not === "TRANSFER" && args._sum) {
      const gte = w.changeTime?.gte?.getTime?.() ?? 0;
      const sixtyAgo = Date.now() - 60 * DAY;
      return Promise.resolve(gte > sixtyAgo ? f.outbound30 ?? [] : f.outbound90 ?? []);
    }
    return Promise.resolve([]);
  });

  m.inventory_logs.aggregate.mockImplementation((args: any) => {
    const w = args.where ?? {};
    if (w.logType === "SALE") return Promise.resolve({ _min: { changeTime: f.saleStart ?? null } });
    if (w.logType === "STOCK_IN") return Promise.resolve({ _min: { changeTime: f.receiptStart ?? null } });
    if (w.logType?.not === "TRANSFER") return Promise.resolve({ _min: { changeTime: f.outboundStart ?? null } });
    if (w.logType?.in) return Promise.resolve({ _min: { changeTime: f.adjustmentStart ?? null } });
    return Promise.resolve({ _min: { changeTime: null } });
  });
}

const product = (over: Partial<any> = {}) => ({
  id: 1,
  name: "Widget",
  costPrice: 2.5, // 250 cents
  lowStockThreshold: null,
  product_locations: [{ quantity: 50 }],
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe("getOperationsRows — ONE outbound predicate + per-product null (review B3 / D-T4)", () => {
  test("units-out is a product's summed non-transfer outflow; velocity divides by the covered window", async () => {
    // The product's OWN first in-window outbound was ~10 days ago: 20 units / 10 days =
    // 2.0/day (never a flat 30). +1min of slack keeps elapsed just under 10 full days so
    // ceil() lands on 10 deterministically (a bare daysAgo(10) sits exactly on the day
    // boundary and is sub-ms-drift fragile under load).
    setupOps({
      products: [product()],
      outboundStart: new Date(Date.now() - 10 * DAY + 60_000),
      outbound30: [
        { productId: 1, _sum: { delta: -20 }, _min: { changeTime: new Date(Date.now() - 10 * DAY + 60_000) } },
      ],
      outbound90: [{ productId: 1, _sum: { delta: -20 } }],
    });
    const { rows } = await getOperationsRows({});
    expect(rows[0].unitsOut30).toBe(20);
    expect(rows[0].avgDailyOutbound30).toBeCloseTo(2.0, 5);
    expect(rows[0].daysOfSupply).toBeCloseTo(25, 5); // 50 / 2.0
  });

  test("PER-PRODUCT DENOMINATOR (spec §2 D2): 19 units in the last 5 days of a 30-day window => 3.8/day, not 19/30", async () => {
    // The whole point of the per-product days-covered denominator: a product whose
    // outbound all landed recently divides by the days it ACTUALLY covered (5), not the
    // flat window (30). 19/5 = 3.8 (the truthful recent-onset velocity); 19/30 = 0.633
    // would understate it. +1min slack so ceil() lands on 5 deterministically.
    setupOps({
      products: [product()], // 50 on hand
      outboundStart: daysAgo(200),
      outbound30: [
        { productId: 1, _sum: { delta: -19 }, _min: { changeTime: new Date(Date.now() - 5 * DAY + 60_000) } },
      ],
      outbound90: [{ productId: 1, _sum: { delta: -19 } }],
    });
    const { rows } = await getOperationsRows({});
    expect(rows[0].unitsOut30).toBe(19);
    expect(rows[0].avgDailyOutbound30).toBeCloseTo(3.8, 5); // 19 / 5, NOT 19 / 30
    expect(rows[0].daysOfSupply).toBeCloseTo(50 / 3.8, 5);
  });

  test("a product with NO outbound row contributes null, not 0", async () => {
    setupOps({
      products: [product({ id: 1 }), product({ id: 2 })],
      outboundStart: daysAgo(200),
      // only product 1 moved
      outbound30: [{ productId: 1, _sum: { delta: -30 }, _min: { changeTime: daysAgo(25) } }],
      outbound90: [{ productId: 1, _sum: { delta: -30 } }],
    });
    const { rows } = await getOperationsRows({});
    const byId = Object.fromEntries(rows.map((r) => [r.productId, r]));
    expect(byId[1].unitsOut30).toBe(30);
    expect(byId[2].unitsOut30).toBeNull();
    expect(byId[2].unitsOut90).toBeNull();
    expect(byId[2].avgDailyOutbound30).toBeNull();
  });

  test("HAZARD PINNED: one SALE row does NOT flip other products to 0 nor inflate the denominator", async () => {
    // Prod shape: a year of negative ADJUSTMENT outflow already exists, then a single
    // SALE row lands for product 1. Under the old global `hasSaleData` flag, EVERY other
    // product would flip null -> 0 and the denominator would collapse to 1 (velocity up
    // to 30x). With the shared outbound predicate and per-product nulls, product 2 stays
    // null; product 1's OWN first in-window event predates the window edge, so its
    // days-covered clamps to 30 => 5/30, NOT 5/1.
    setupOps({
      products: [product({ id: 1 }), product({ id: 2 })],
      outboundStart: daysAgo(365),
      // the lone SALE row, as outbound; first in-window movement clamps to the 30d edge
      outbound30: [{ productId: 1, _sum: { delta: -5 }, _min: { changeTime: daysAgo(60) } }],
      outbound90: [{ productId: 1, _sum: { delta: -5 } }],
    });
    const { rows } = await getOperationsRows({});
    const byId = Object.fromEntries(rows.map((r) => [r.productId, r]));
    expect(byId[2].unitsOut30).toBeNull(); // NOT a confident 0
    expect(byId[1].unitsOut30).toBe(5);
    // daysCovered clamps to windowDays=30 (first event predates the window), so 5/30.
    expect(byId[1].avgDailyOutbound30).toBeCloseTo(5 / 30, 6);
  });

  test("no outbound data at all => every product's units-out is null", async () => {
    setupOps({
      products: [product()],
      outboundStart: null,
      outbound30: [],
      outbound90: [],
    });
    const { rows, dataStarts } = await getOperationsRows({});
    expect(dataStarts.outbound).toBeNull();
    expect(rows[0].unitsOut30).toBeNull();
    expect(rows[0].unitsOut90).toBeNull();
    expect(rows[0].avgDailyOutbound30).toBeNull();
    expect(rows[0].daysOfSupply).toBeNull();
  });

  test("last-outbound uses the SAME predicate (transfers excluded from the _max query)", async () => {
    setupOps({ products: [product()], outboundStart: daysAgo(30) });
    await getOperationsRows({});
    // The lastOutbound groupBy must carry the non-transfer filter.
    const maxCalls = m.inventory_logs.groupBy.mock.calls.filter(
      ([a]: any[]) => a._max && a.where?.logType?.not === "TRANSFER",
    );
    expect(maxCalls.length).toBeGreaterThan(0);
  });
});

describe("getOperationsRows — cost null propagation (review B2 / D-T2)", () => {
  test("a NULL-cost product yields a null shrinkage value, never units x $0", async () => {
    setupOps({
      products: [product({ costPrice: null })],
      adjustmentStart: daysAgo(40),
      shrink90: [{ productId: 1, _sum: { delta: -4 } }],
    });
    const { rows } = await getOperationsRows({ windowDays: 90 });
    expect(rows[0].shrinkage90).toEqual({ units: 4, valueAtCurrentCostCents: null });
  });

  test("an explicit cost values shrinkage at current cost", async () => {
    setupOps({
      products: [product({ costPrice: 2.5 })], // 250 cents
      adjustmentStart: daysAgo(40),
      shrink90: [{ productId: 1, _sum: { delta: -4 } }],
    });
    const { rows } = await getOperationsRows({ windowDays: 90 });
    expect(rows[0].shrinkage90).toEqual({ units: 4, valueAtCurrentCostCents: 1000 });
  });
});

describe("getOperationsRows — turns coverage floor (R-L10)", () => {
  const snapshotDays = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      productId: 1,
      dayKey: `2026-05-${String(i + 1).padStart(2, "0")}`,
      quantity: 100,
    }));

  test("coverage < 80% of the window => turns null, but coverage days + window are reported", async () => {
    setupOps({
      products: [product()],
      outboundStart: daysAgo(90),
      outbound90: [{ productId: 1, _sum: { delta: -180 } }],
      snapshots: snapshotDays(10),
      snapshotStart: "2026-05-01",
    });
    const { rows } = await getOperationsRows({ windowDays: 90 });
    expect(rows[0].turns).toBeNull();
    expect(rows[0].turnsWindowDays).toBe(90); // always known, even when turns is null
    expect(rows[0].turnsCoverage).toEqual({ days: 10, windowDays: 90 });
  });

  test("coverage >= 80% => turns = |outbound over window| / avg daily snapshot qty", async () => {
    setupOps({
      products: [product()],
      outboundStart: daysAgo(90),
      outbound90: [{ productId: 1, _sum: { delta: -200 } }],
      snapshots: snapshotDays(80),
      snapshotStart: "2026-05-01",
    });
    const { rows } = await getOperationsRows({ windowDays: 90 });
    expect(rows[0].turnsCoverage).toEqual({ days: 80, windowDays: 90 });
    expect(rows[0].turnsWindowDays).toBe(90);
    expect(rows[0].turns).toBeCloseTo(200 / 100, 5);
  });
});

describe("getOperationsRows — latest receipt cost tie-break (R-L15)", () => {
  test("same-timestamp receipt tie is broken by the HIGHEST id", async () => {
    setupOps({
      products: [product()],
      receiptMax: [{ productId: 1, _max: { changeTime: daysAgo(2) } }],
      receiptRows: [
        { id: 11, productId: 1, unitCostCents: 700 },
        { id: 10, productId: 1, unitCostCents: 500 },
      ],
    });
    const { rows } = await getOperationsRows({});
    expect(rows[0].lastReceiptCostCents).toBe(700);
    expect(m.inventory_logs.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ id: "desc" }] }),
    );
  });

  test("no STOCK_IN row => lastReceiptCostCents null", async () => {
    setupOps({ products: [product()], receiptMax: [], receiptRows: [] });
    const { rows } = await getOperationsRows({});
    expect(rows[0].lastReceiptCostCents).toBeNull();
  });
});

describe("getOperationsRows — attention triage + data-starts", () => {
  test("out > low > stale > ok with the shared inclusive predicate", async () => {
    setupOps({
      products: [
        product({ id: 1, product_locations: [{ quantity: 0 }] }), // out
        product({ id: 2, lowStockThreshold: 10, product_locations: [{ quantity: 10 }] }), // low
        product({ id: 3, lowStockThreshold: 10, product_locations: [{ quantity: 50 }] }), // stale
        product({ id: 4, lowStockThreshold: 10, product_locations: [{ quantity: 50 }] }), // ok
      ],
      lastOutbound: [{ productId: 4, _max: { changeTime: daysAgo(5) } }],
      outboundStart: daysAgo(30),
    });
    const { rows } = await getOperationsRows({});
    const byId = Object.fromEntries(rows.map((r) => [r.productId, r.attention]));
    expect(byId[1]).toBe("out");
    expect(byId[2]).toBe("low");
    expect(byId[3]).toBe("stale");
    expect(byId[4]).toBe("ok");
  });

  test("dataStarts exposes both `outbound` (velocity source) and the narrower `sale`", async () => {
    const outStart = daysAgo(200);
    const saleStart = daysAgo(5);
    setupOps({
      products: [product()],
      outboundStart: outStart,
      saleStart,
      snapshotStart: "2026-04-15",
    });
    const { dataStarts, velocityDefinition } = await getOperationsRows({ windowDays: 90 });
    expect(dataStarts.outbound).toBe(outStart.toISOString());
    expect(dataStarts.sale).toBe(saleStart.toISOString());
    expect(dataStarts.snapshot).toBe("2026-04-15");
    // Result-level velocity definition (spec §2 D3): the physicalOutbound prose that
    // must accompany avgDailyOutbound30 wherever it is surfaced.
    expect(velocityDefinition).toContain("Physical outbound");
    const snapArg = m.productStockSnapshot.findMany.mock.calls[0][0];
    expect(snapArg.where.dayKey.gte).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("getShrinkageSummary — classified loss only + unclassified coverage (review B1 / D-T3)", () => {
  function setupShrink(
    grouped: any[],
    costs: any[],
    dataStart: Date | null,
    reasonTrackingStart: Date | null = null,
  ) {
    m.inventory_logs.groupBy.mockResolvedValue(grouped);
    m.inventory_logs.aggregate.mockImplementation((args: any) => {
      const w = args.where ?? {};
      if (w.reasonCode && "not" in w.reasonCode) {
        return Promise.resolve({ _min: { changeTime: reasonTrackingStart } });
      }
      return Promise.resolve({ _min: { changeTime: dataStart } });
    });
    m.product.findMany.mockResolvedValue(costs);
  }

  test("THE 16k LIE IS DEAD: 16,138 unclassified units => shrinkage total 0 + coverage note", async () => {
    // The prod shape: every legacy outbound ADJUSTMENT has a null reasonCode. None of
    // it is classifiable loss — it is how the business ships product.
    setupShrink(
      [{ productId: 1, reasonCode: null, _sum: { delta: -16138 } }],
      [{ id: 1, costPrice: null }],
      daysAgo(365),
      null, // no reason tracking has ever happened
    );
    const s = await getShrinkageSummary({ days: 365 });
    expect(s.totalUnits).toBe(0);
    expect(s.byReason.DAMAGE.units).toBe(0);
    // Classified loss is 0, so its cost-coverage is 0/0; the 16,138 lives in coverage.
    expect(s.costCoverage).toEqual({ costedUnits: 0, totalUnits: 0 });
    expect(s.coverage.unclassifiedOutboundUnits).toBe(16138);
    expect(s.coverage.reasonTrackingStartedAt).toBeNull();
  });

  test("classified reasons (incl COUNT) bucket as loss; CORRECTION + null go to coverage", async () => {
    const reasonStart = daysAgo(20);
    setupShrink(
      [
        { productId: 1, reasonCode: "DAMAGE", _sum: { delta: -4 } },
        { productId: 1, reasonCode: "COUNT", _sum: { delta: -3 } },
        { productId: 1, reasonCode: "CORRECTION", _sum: { delta: -2 } },
        { productId: 1, reasonCode: null, _sum: { delta: -5 } },
      ],
      [{ id: 1, costPrice: 2.5 }], // 250 cents
      daysAgo(30),
      reasonStart,
    );
    const s = await getShrinkageSummary({ days: 90 });
    expect(s.byReason.DAMAGE).toEqual({
      units: 4,
      valueAtCurrentCostCents: 1000,
      costCoverage: { costedUnits: 4, totalUnits: 4 },
    });
    expect(s.byReason.COUNT).toEqual({
      units: 3,
      valueAtCurrentCostCents: 750,
      costCoverage: { costedUnits: 3, totalUnits: 3 },
    });
    expect(s.byReason.THEFT).toEqual({
      units: 0,
      valueAtCurrentCostCents: null,
      costCoverage: { costedUnits: 0, totalUnits: 0 },
    });
    expect((s.byReason as any).CORRECTION).toBeUndefined();
    expect((s.byReason as any).UNCLASSIFIED).toBeUndefined();
    expect(s.totalUnits).toBe(7); // 4 + 3, NOT the 2 CORRECTION or 5 null
    // Total cost-coverage (spec §3 E4): all 7 classified units carried a known cost.
    expect(s.costCoverage).toEqual({ costedUnits: 7, totalUnits: 7 });
    expect(s.coverage.unclassifiedOutboundUnits).toBe(7); // 2 + 5
    expect(s.coverage.reasonTrackingStartedAt).toBe(reasonStart.toISOString());
  });

  test("no cost on file => bucket value is null, never units x $0 (B2)", async () => {
    setupShrink(
      [{ productId: 1, reasonCode: "DAMAGE", _sum: { delta: -4 } }],
      [{ id: 1, costPrice: null }],
      daysAgo(30),
    );
    const s = await getShrinkageSummary({ days: 90 });
    expect(s.byReason.DAMAGE).toEqual({
      units: 4,
      valueAtCurrentCostCents: null,
      // no cost on file: 0 of the 4 units are costed (spec §3 E4).
      costCoverage: { costedUnits: 0, totalUnits: 4 },
    });
    expect(s.totalValueAtCurrentCostCents).toBeNull();
    expect(s.costCoverage).toEqual({ costedUnits: 0, totalUnits: 4 });
  });

  test("empty ledger => all buckets zero, total 0, coverage empty, dataStart null", async () => {
    setupShrink([], [], null);
    const s = await getShrinkageSummary({ days: 90 });
    expect(s.dataStart).toBeNull();
    expect(s.totalUnits).toBe(0);
    expect(s.costCoverage).toEqual({ costedUnits: 0, totalUnits: 0 });
    expect(s.coverage.unclassifiedOutboundUnits).toBe(0);
    for (const k of Object.keys(s.byReason) as (keyof typeof s.byReason)[]) {
      expect(s.byReason[k]).toEqual({
        units: 0,
        valueAtCurrentCostCents: null,
        costCoverage: { costedUnits: 0, totalUnits: 0 },
      });
    }
    expect(m.product.findMany).not.toHaveBeenCalled();
  });
});

describe("getValuationSummary — null valuation + cost coverage (review B2 / D-T2)", () => {
  test("NO cost on file (prod: 0 of N) => atCurrentCostCents null, costCoverage { valued: 0, of: N }", async () => {
    m.product.findMany.mockResolvedValue([
      { id: 1, costPrice: null, product_locations: [{ quantity: 10 }] },
      { id: 2, costPrice: null, product_locations: [{ quantity: 5 }] },
    ]);
    m.inventory_logs.groupBy.mockResolvedValue([]);
    m.inventory_logs.findMany.mockResolvedValue([]);

    const v = await getValuationSummary();
    expect(v.atCurrentCostCents).toBeNull(); // NOT $0.00
    expect(v.costCoverage).toEqual({ valued: 0, of: 2 });
  });

  test("partial cost coverage sums only the valued products", async () => {
    m.product.findMany.mockResolvedValue([
      { id: 1, costPrice: 2.0, product_locations: [{ quantity: 10 }] }, // valued
      { id: 2, costPrice: null, product_locations: [{ quantity: 5 }] }, // unknown
    ]);
    m.inventory_logs.groupBy.mockResolvedValue([]);
    m.inventory_logs.findMany.mockResolvedValue([]);

    const v = await getValuationSummary();
    expect(v.atCurrentCostCents).toBe(2000); // 10 x 200; product 2 excluded
    expect(v.costCoverage).toEqual({ valued: 1, of: 2 });
  });

  test("receipt cost + coverage over in-stock only (the D-T1 reference block)", async () => {
    m.product.findMany.mockResolvedValue([
      { id: 1, costPrice: 2.0, product_locations: [{ quantity: 10 }] }, // in stock, has receipt
      { id: 2, costPrice: 3.0, product_locations: [{ quantity: 5 }] }, // in stock, NO receipt
      { id: 3, costPrice: 4.0, product_locations: [{ quantity: 0 }] }, // out of stock -> excluded
    ]);
    m.inventory_logs.groupBy.mockResolvedValue([{ productId: 1, _max: { changeTime: daysAgo(3) } }]);
    m.inventory_logs.findMany.mockResolvedValue([{ id: 9, productId: 1, unitCostCents: 180 }]);

    const v = await getValuationSummary();
    expect(v.atReceiptCostCents).toBe(1800); // 10 x 180
    expect(v.receiptCoverage).toEqual({ have: 1, of: 2 });
    expect(v.costCoverage).toEqual({ valued: 3, of: 3 });
  });
});
