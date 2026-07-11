// Lane 3 (Task 5, W2-C): tier-1 Operations query math (spec D6 + R-L10/R-L11 +
// R-L15 coverage fixtures). Pure-function tests over a mocked prisma: every
// groupBy/aggregate call is dispatched by its `where`/aggregation shape so a
// single mock drives the whole getOperationsRows fan-out.

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
  sale30?: any[];
  sale90?: any[];
  inbound?: any[];
  outbound?: any[];
  shrink90?: any[];
  corrections90?: any[];
  snapshots?: any[];
  receiptMax?: any[];
  receiptRows?: any[];
  saleStart?: Date | null;
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
    if (w.logType === "SALE" && args._sum) {
      const gte = w.changeTime?.gte?.getTime?.() ?? 0;
      const sixtyAgo = Date.now() - 60 * DAY;
      return Promise.resolve(gte > sixtyAgo ? f.sale30 ?? [] : f.sale90 ?? []);
    }
    if (w.logType === "ADJUSTMENT" && w.reasonCode?.in && args._sum) {
      return Promise.resolve(f.shrink90 ?? []);
    }
    if (w.reasonCode === "CORRECTION" && args._count) return Promise.resolve(f.corrections90 ?? []);
    if (w.delta?.gt === 0 && args._max) return Promise.resolve(f.inbound ?? []);
    if (w.delta?.lt === 0 && args._max) return Promise.resolve(f.outbound ?? []);
    return Promise.resolve([]);
  });

  m.inventory_logs.aggregate.mockImplementation((args: any) => {
    const w = args.where ?? {};
    if (w.logType === "SALE") return Promise.resolve({ _min: { changeTime: f.saleStart ?? null } });
    if (w.logType === "STOCK_IN") {
      return Promise.resolve({ _min: { changeTime: f.receiptStart ?? null } });
    }
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

describe("getOperationsRows — SALE velocity + gross semantics (R-L11)", () => {
  test("unfulfillment leaves gross Units-out unchanged while the corrections counter moves", async () => {
    // The fulfillment wrote a -10 SALE row; a later unfulfillment wrote a +N
    // CORRECTION restock. Gross Units-out must stay 10 (never subtracted); the
    // positive-CORRECTION count surfaces alongside it.
    setupOps({
      products: [product()],
      saleStart: daysAgo(45),
      sale90: [{ productId: 1, _sum: { delta: -10 } }],
      sale30: [{ productId: 1, _sum: { delta: -10 } }],
      corrections90: [{ productId: 1, _count: { _all: 3 } }],
    });
    const { rows } = await getOperationsRows({ windowDays: 90 });
    expect(rows[0].unitsOut90).toBe(10);
    expect(rows[0].correctionsIn90).toBe(3);
  });

  test("velocity divides by min(30, days since SALE data started), never a flat 30", async () => {
    // SALE data started 10 days ago: 20 units / 10 days = 2.0/day (not 20/30).
    setupOps({
      products: [product()],
      saleStart: daysAgo(10),
      sale30: [{ productId: 1, _sum: { delta: -20 } }],
      sale90: [{ productId: 1, _sum: { delta: -20 } }],
    });
    const { rows } = await getOperationsRows({});
    expect(rows[0].avgDaily30).toBeCloseTo(2.0, 5);
    // days of supply = 50 / 2.0 = 25
    expect(rows[0].daysOfSupply).toBeCloseTo(25, 5);
  });
});

describe("getOperationsRows — accrual (zero SALE rows)", () => {
  test("no SALE rows => dataStarts.sale null and SALE metrics are null, never 0", async () => {
    setupOps({
      products: [product()],
      saleStart: null,
      sale30: [],
      sale90: [],
    });
    const { rows, dataStarts } = await getOperationsRows({});
    expect(dataStarts.sale).toBeNull();
    expect(rows[0].unitsOut30).toBeNull();
    expect(rows[0].unitsOut90).toBeNull();
    expect(rows[0].avgDaily30).toBeNull();
    expect(rows[0].daysOfSupply).toBeNull();
  });
});

describe("getOperationsRows — turns coverage floor (R-L10)", () => {
  const snapshotDays = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      productId: 1,
      dayKey: `2026-05-${String(i + 1).padStart(2, "0")}`,
      quantity: 100,
    }));

  test("coverage < 80% of the window => turns90 null, but coverage days are reported", async () => {
    setupOps({
      products: [product()],
      saleStart: daysAgo(90),
      sale90: [{ productId: 1, _sum: { delta: -180 } }],
      snapshots: snapshotDays(10), // 10 of 90 days ~ 11%
      snapshotStart: "2026-05-01",
    });
    const { rows } = await getOperationsRows({ windowDays: 90 });
    expect(rows[0].turns90).toBeNull();
    expect(rows[0].turnsCoverage).toEqual({ days: 10, windowDays: 90 });
  });

  test("coverage >= 80% => turns90 = |SALE out window| / avg daily snapshot qty", async () => {
    setupOps({
      products: [product()],
      saleStart: daysAgo(90),
      sale90: [{ productId: 1, _sum: { delta: -200 } }],
      snapshots: snapshotDays(80), // 80 of 90 days ~ 89%, avg qty 100
      snapshotStart: "2026-05-01",
    });
    const { rows } = await getOperationsRows({ windowDays: 90 });
    expect(rows[0].turnsCoverage).toEqual({ days: 80, windowDays: 90 });
    expect(rows[0].turns90).toBeCloseTo(200 / 100, 5);
  });

  test("no snapshot data at all => turnsCoverage null and turns90 null", async () => {
    setupOps({
      products: [product()],
      saleStart: daysAgo(90),
      sale90: [{ productId: 1, _sum: { delta: -200 } }],
      snapshots: [],
      snapshotStart: null,
    });
    const { rows } = await getOperationsRows({ windowDays: 90 });
    expect(rows[0].turnsCoverage).toBeNull();
    expect(rows[0].turns90).toBeNull();
  });
});

describe("getOperationsRows — latest receipt cost tie-break (R-L15)", () => {
  test("same-timestamp receipt tie is broken by the HIGHEST id", async () => {
    setupOps({
      products: [product()],
      receiptMax: [{ productId: 1, _max: { changeTime: daysAgo(2) } }],
      // findMany returns id-desc; the highest id (11 -> 700) must win over 10 -> 500.
      receiptRows: [
        { id: 11, productId: 1, unitCostCents: 700 },
        { id: 10, productId: 1, unitCostCents: 500 },
      ],
    });
    const { rows } = await getOperationsRows({});
    expect(rows[0].lastReceiptCostCents).toBe(700);
    // Pin the IN-fetch ordering that guarantees the tie-break.
    expect(m.inventory_logs.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ id: "desc" }] })
    );
  });

  test("no STOCK_IN row => lastReceiptCostCents null", async () => {
    setupOps({ products: [product()], receiptMax: [], receiptRows: [] });
    const { rows } = await getOperationsRows({});
    expect(rows[0].lastReceiptCostCents).toBeNull();
  });
});

describe("getOperationsRows — attention triage + UTC boundaries", () => {
  test("out > low > stale > ok with the shared inclusive predicate", async () => {
    setupOps({
      products: [
        product({ id: 1, product_locations: [{ quantity: 0 }] }), // out
        product({ id: 2, lowStockThreshold: 10, product_locations: [{ quantity: 10 }] }), // low (inclusive: qty==threshold)
        product({ id: 3, lowStockThreshold: 10, product_locations: [{ quantity: 50 }] }), // stale (no outbound)
        product({ id: 4, lowStockThreshold: 10, product_locations: [{ quantity: 50 }] }), // ok (recent outbound)
      ],
      outbound: [{ productId: 4, _max: { changeTime: daysAgo(5) } }],
      saleStart: daysAgo(30),
    });
    const { rows } = await getOperationsRows({});
    const byId = Object.fromEntries(rows.map((r) => [r.productId, r.attention]));
    expect(byId[1]).toBe("out");
    expect(byId[2]).toBe("low");
    expect(byId[3]).toBe("stale");
    expect(byId[4]).toBe("ok");
  });

  test("snapshot window start is a UTC dayKey and dataStarts.snapshot is the min dayKey", async () => {
    setupOps({ products: [product()], snapshotStart: "2026-04-15" });
    const { dataStarts } = await getOperationsRows({ windowDays: 90 });
    expect(dataStarts.snapshot).toBe("2026-04-15");
    const snapArg = m.productStockSnapshot.findMany.mock.calls[0][0];
    // A UTC YYYY-MM-DD key (10 chars), never a raw Date.
    expect(snapArg.where.dayKey.gte).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("getShrinkageSummary — reason buckets (D6)", () => {
  function setupShrink(grouped: any[], costs: any[], dataStart: Date | null) {
    m.inventory_logs.groupBy.mockResolvedValue(grouped);
    m.inventory_logs.aggregate.mockResolvedValue({ _min: { changeTime: dataStart } });
    m.product.findMany.mockResolvedValue(costs);
  }

  test("null reasonCode lands in the UNCLASSIFIED bucket; classes value at current cost", async () => {
    const start = daysAgo(30);
    setupShrink(
      [
        { productId: 1, reasonCode: "DAMAGE", _sum: { delta: -4 } },
        { productId: 1, reasonCode: null, _sum: { delta: -5 } },
        { productId: 1, reasonCode: "CORRECTION", _sum: { delta: -2 } },
        { productId: 1, reasonCode: "COUNT", _sum: { delta: -3 } },
      ],
      [{ id: 1, costPrice: 2.5 }], // 250 cents
      start
    );
    const { byReason, dataStart } = await getShrinkageSummary({ days: 90 });
    expect(byReason.DAMAGE).toEqual({ units: 4, valueAtCurrentCostCents: 1000 });
    expect(byReason.UNCLASSIFIED).toEqual({ units: 5, valueAtCurrentCostCents: 1250 });
    expect(byReason.CORRECTION.units).toBe(2);
    expect(byReason.COUNT.units).toBe(3);
    expect(byReason.THEFT).toEqual({ units: 0, valueAtCurrentCostCents: 0 });
    expect(dataStart).toBe(start.toISOString());
  });

  test("empty ledger => all buckets zero and dataStart null", async () => {
    setupShrink([], [], null);
    const { byReason, dataStart } = await getShrinkageSummary({ days: 90 });
    expect(dataStart).toBeNull();
    for (const k of Object.keys(byReason) as (keyof typeof byReason)[]) {
      expect(byReason[k]).toEqual({ units: 0, valueAtCurrentCostCents: 0 });
    }
    // No product cost fetch when there are no grouped rows.
    expect(m.product.findMany).not.toHaveBeenCalled();
  });
});

describe("getValuationSummary — coverage over in-stock only (D6)", () => {
  test("value at current cost sums all stock; receipt value + coverage over in-stock", async () => {
    m.product.findMany.mockResolvedValue([
      { id: 1, costPrice: 2.0, product_locations: [{ quantity: 10 }] }, // in stock, has receipt
      { id: 2, costPrice: 3.0, product_locations: [{ quantity: 5 }] }, // in stock, NO receipt
      { id: 3, costPrice: 4.0, product_locations: [{ quantity: 0 }] }, // out of stock -> excluded from coverage
    ]);
    // latestReceiptCostByProduct: product 1 only.
    m.inventory_logs.groupBy.mockResolvedValue([{ productId: 1, _max: { changeTime: daysAgo(3) } }]);
    m.inventory_logs.findMany.mockResolvedValue([{ id: 9, productId: 1, unitCostCents: 180 }]);

    const v = await getValuationSummary();
    // current cost: 10*200 + 5*300 + 0 = 3500
    expect(v.atCurrentCostCents).toBe(3500);
    // receipt cost: only product 1 (has receipt) -> 10*180 = 1800
    expect(v.atReceiptCostCents).toBe(1800);
    // coverage over in-stock products only: 1 of 2 (product 3 is out of stock)
    expect(v.receiptCoverage).toEqual({ have: 1, of: 2 });
  });

  test("no receipt-cost data => atReceiptCostCents null with 0/N coverage", async () => {
    m.product.findMany.mockResolvedValue([
      { id: 1, costPrice: 2.0, product_locations: [{ quantity: 10 }] },
    ]);
    m.inventory_logs.groupBy.mockResolvedValue([]);
    m.inventory_logs.findMany.mockResolvedValue([]);
    const v = await getValuationSummary();
    expect(v.atReceiptCostCents).toBeNull();
    expect(v.receiptCoverage).toEqual({ have: 0, of: 1 });
  });
});
