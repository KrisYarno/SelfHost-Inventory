/**
 * @jest-environment node
 *
 * Lane reorder-points — Task 5: the `reorder_report` assistant tool (D7 parity).
 *
 * Pins:
 *  - the tool returns the ReorderReport rows + assumptions + coverage + inventory
 *    PositionKnown:false, so the model can relay the runtime assumptions;
 *  - excluded (unavailable) products are named in the returned rows;
 *  - pagination via the Lane-6 limit/offset shape (returned/totalRows/nextOffset);
 *  - PARITY: the tool's rows are exactly the report's rows (same numbers as the web
 *    route, which calls the same getReorderReport) — A2 adds keys to the UNSIZED rows only;
 *  - the tool + its presentation are registered, and low_stock_report is disambiguated.
 *
 * A2 (pack C4, C5, C2): the recorded-order signal on the rows the report cannot size
 * (through the REAL order-signal module, prisma mocked), the counts block, the rule
 * definitions, the costed label, the mixed-scope envelope and its worst-case size.
 */

// The report is stubbed; the module's constants (definitions, notes) are the real ones.
jest.mock("@/lib/reports/reorder", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/reports/reorder"),
  getReorderReport: jest.fn(),
}));
// The order-signal read graph (approved-active scope + the per-company starts + the one
// grouped fact read) runs for real over these three delegates; the other data-layer
// imports of tools.ts are unused by this suite.
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { findMany: jest.fn() },
    productSalesFact: { aggregate: jest.fn(), groupBy: jest.fn() },
  },
}));
jest.mock("@/lib/products", () => ({ __esModule: true, getProductsWithQuantities: jest.fn() }));
jest.mock("@/lib/reports/low-stock", () => ({ __esModule: true, getLowStockReport: jest.fn() }));

import prisma from "@/lib/prisma";
import { assistantTools, TOOL_SCOPES, testCtx, byteBudget } from "@/lib/assistant/tools";
import { TOOL_PRESENTATION } from "@/lib/assistant/tool-presentation";
import {
  getReorderReport,
  REORDER_COSTED_NOTE,
  REORDER_COVERAGE_NOTE,
} from "@/lib/reports/reorder";
import {
  salesCoverageReason,
  SALES_COMPANY_COVERAGE_MEASURED_NOTE,
} from "@/lib/assistant/sales-coverage";
import { REORDER_DEMAND_DEFINITION } from "@/lib/reports/metrics-contract";
import { toDayKey } from "@/lib/analytics/dates";

const mockReport = getReorderReport as jest.Mock;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;
const CTX = testCtx();
const DAY_MS = 86_400_000;

const REPORT = {
  rows: [
    {
      status: "suggested",
      productId: 1,
      productName: "Widget",
      currentStock: 0,
      avgDailyDemand: 1.5,
      daysCovered: 30,
      leadTimeDays: 14,
      leadTimeSource: "default",
      bufferDays: 7,
      reorderPoint: 32,
      reorderPointSource: "computed",
      targetLevel: 42,
      grossReplenishmentNeed: 42,
      minOrderQuantity: 1,
      urgency: "OUT",
      costPrice: null,
      orderValue: null,
    },
    { status: "unavailable", productId: 2, productName: "Idle", currentStock: 5, reason: "no_demand_signal" },
  ],
  inventoryPositionKnown: false,
  assumptions: { windowDays: 90, bufferDaysDefault: 7, targetCoverageMultiple: 2, demandDefinition: "…" },
  coverage: { total: 2, suggested: 1, unavailable: 1, costed: 0 },
  coverageNote: "healthy note",
};

beforeEach(() => {
  jest.clearAllMocks();
  db.product.findMany.mockReset();
  db.productSalesFact.aggregate.mockReset();
  db.productSalesFact.groupBy.mockReset();
});

describe("reorder_report tool", () => {
  it("returns rows + assumptions + coverage + inventoryPositionKnown:false", async () => {
    mockReport.mockResolvedValue(REPORT);
    const result = await assistantTools.reorder_report.run({}, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const data = result.data as any;
    expect(data.inventoryPositionKnown).toBe(false);
    expect(data.assumptions).toEqual(REPORT.assumptions);
    // The report's coverage buckets are relayed unchanged; A2 adds labelled keys beside them.
    expect(data.coverage).toMatchObject(REPORT.coverage);
    // Excluded product is named in the rows.
    expect(data.rows.find((r: any) => r.productId === 2)).toMatchObject({
      status: "unavailable",
      productName: "Idle",
      reason: "no_demand_signal",
    });
    // Parity: the SIZED row is the report's row byte for byte (same numbers as the web
    // route); the unsized row is the report's row plus the order-signal keys (A2 C4) —
    // nothing of the report's is changed or dropped.
    expect(data.rows[0]).toEqual(REPORT.rows[0]);
    expect(data.rows[1]).toEqual({
      ...REPORT.rows[1],
      orderSignal: null,
      orderSignalReason: "no company access",
      outOfStockWithOrders: false, // stock 5 on hand
    });
  });

  it("paginates with the Lane-6 limit/offset shape", async () => {
    mockReport.mockResolvedValue(REPORT);
    const result = await assistantTools.reorder_report.run({ limit: 1, offset: 0 }, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const data = result.data as any;
    expect(data.returned).toBe(1);
    expect(data.totalRows).toBe(2);
    expect(data.nextOffset).toBe(1);
  });

  it("passes includeOkay through to the report", async () => {
    mockReport.mockResolvedValue(REPORT);
    await assistantTools.reorder_report.run({ includeOkay: false }, CTX);
    expect(mockReport).toHaveBeenCalledWith({ includeOkay: false });
  });
});

describe("registration + disambiguation", () => {
  it("is registered in TOOL_SCOPES and TOOL_PRESENTATION", () => {
    expect(TOOL_SCOPES.reorder_report).toBe("global");
    expect(TOOL_PRESENTATION.reorder_report).toBeDefined();
  });

  it("low_stock_report is disambiguated from the reorder report", () => {
    const desc = assistantTools.low_stock_report.description;
    expect(desc).toContain("reorder_report");
    expect(desc.toLowerCase()).toContain("threshold");
  });
});

// ===========================================================================
// A2 pack C4 — the order signal (Kris: flag + figures, never a quantity)
// ===========================================================================

/** The 90-day calendar window the tool computes: 90 UTC day keys ending today. */
function signalWindow() {
  const to = toDayKey(new Date());
  const from = toDayKey(new Date(new Date(`${to}T00:00:00.000Z`).getTime() - 89 * DAY_MS));
  return { from, to, days: 90 };
}
const daysBack = (n: number) => toDayKey(new Date(Date.now() - n * DAY_MS));

type Fact = { productId: number; companyId: string; dayKey: string; orderedQty: number; orderCount: number };

/** Answer the order-signal reads FROM a fact table, honoring each where clause. */
function seedFacts(opts: { facts: Fact[]; approvedActiveIds: number[] }) {
  db.product.findMany.mockResolvedValue(opts.approvedActiveIds.map((id) => ({ id })));
  const inScope = (where: Record<string, any>) =>
    opts.facts.filter(
      (f) =>
        (where.companyId?.in == null || where.companyId.in.includes(f.companyId)) &&
        (where.productId?.in == null || where.productId.in.includes(f.productId)) &&
        (where.dayKey?.gte == null || f.dayKey >= where.dayKey.gte) &&
        (where.dayKey?.lte == null || f.dayKey <= where.dayKey.lte),
    );
  db.productSalesFact.aggregate.mockImplementation(async (args: { where: Record<string, any> }) => ({
    _min: { dayKey: inScope(args.where).map((f) => f.dayKey).sort()[0] ?? null },
  }));
  db.productSalesFact.groupBy.mockImplementation(async (args: { by: string[]; where: Record<string, any> }) => {
    const rows = inScope(args.where);
    if (args.by[0] === "companyId") {
      const starts = new Map<string, string>();
      for (const f of rows) {
        const cur = starts.get(f.companyId);
        if (cur == null || f.dayKey < cur) starts.set(f.companyId, f.dayKey);
      }
      return Array.from(starts, ([companyId, dayKey]) => ({ companyId, _min: { dayKey } }));
    }
    const sums = new Map<number, { orderedQty: number; orderCount: number }>();
    for (const f of rows) {
      const cur = sums.get(f.productId) ?? { orderedQty: 0, orderCount: 0 };
      sums.set(f.productId, { orderedQty: cur.orderedQty + f.orderedQty, orderCount: cur.orderCount + f.orderCount });
    }
    return Array.from(sums, ([productId, sum]) => ({ productId, _sum: sum }));
  });
}

const suggested = (productId: number, urgency: string, extra: Record<string, unknown> = {}) => ({
  status: "suggested",
  productId,
  productName: `Sized ${productId}`,
  currentStock: urgency === "OUT" ? 0 : 3,
  avgDailyDemand: 1,
  daysCovered: 30,
  leadTimeDays: 14,
  leadTimeSource: "default",
  bufferDays: 7,
  reorderPoint: 21,
  reorderPointSource: "computed",
  targetLevel: 28,
  grossReplenishmentNeed: 28,
  minOrderQuantity: 1,
  urgency,
  costPrice: 2,
  orderValue: 56,
  demandUnits: 30,
  demandMix: null,
  ...extra,
});
const unsized = (
  productId: number,
  currentStock: number,
  reason: "no_demand_signal" | "insufficient_history" = "no_demand_signal",
) => ({ status: "unavailable", productId, productName: `Unsized ${productId}`, currentStock, reason });

function reportOf(rows: Array<Record<string, unknown>>, coverage: Record<string, unknown> = {}) {
  return {
    rows,
    inventoryPositionKnown: false,
    assumptions: {
      windowDays: 90,
      bufferDaysDefault: 7,
      targetCoverageMultiple: 2,
      demandDefinition: REORDER_DEMAND_DEFINITION,
    },
    coverage: {
      total: rows.length,
      suggested: rows.filter((r) => r.status === "suggested").length,
      unavailable: rows.filter((r) => r.status === "unavailable").length,
      healthy: 0,
      approachingOmitted: 0,
      costed: rows.filter((r) => r.status === "suggested" && r.costPrice != null).length,
      ...coverage,
    },
    coverageNote: REORDER_COVERAGE_NOTE,
  };
}

async function run(args: Record<string, unknown>, companyIds: string[], remainingBytes?: number) {
  const result = await assistantTools.reorder_report.run(
    args,
    testCtx({ companyIds, ...(remainingBytes != null ? { remainingBytes } : {}) }),
  );
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return { data: result.data as any, meta: result.meta };
}

const rowOf = (data: any, productId: number) => data.rows.find((r: any) => r.productId === productId);

const SIZING_KEYS = [
  "avgDailyDemand",
  "daysCovered",
  "leadTimeDays",
  "bufferDays",
  "reorderPoint",
  "reorderPointSource",
  "targetLevel",
  "grossReplenishmentNeed",
  "minOrderQuantity",
  "urgency",
  "costPrice",
  "orderValue",
];

describe("A2 C4 — full coverage", () => {
  const FULL = { approvedActiveIds: [1, 2, 3], facts: [] as Fact[] };
  beforeEach(() => {
    FULL.facts = [
      // c1 has recorded since long before the window: silence is a measured zero.
      { productId: 3, companyId: "c1", dayKey: "2020-01-01", orderedQty: 1, orderCount: 1 },
      // CJC/IPA's shape: 0 on hand, 14 units over 7 orders in the window.
      { productId: 2, companyId: "c1", dayKey: daysBack(60), orderedQty: 6, orderCount: 3 },
      { productId: 2, companyId: "c1", dayKey: daysBack(5), orderedQty: 8, orderCount: 4 },
    ];
  });

  it("14 units / 7 orders at stock 0: the figures, flagged, listed on page 1 AND page 2, no sizing keys", async () => {
    seedFacts(FULL);
    mockReport.mockResolvedValue(reportOf([suggested(1, "OUT"), unsized(2, 0), unsized(3, 0)]));

    const page1 = (await run({ limit: 1, offset: 0 }, ["c1"])).data;
    const page2 = (await run({ limit: 1, offset: 1 }, ["c1"])).data;
    // Page 1 holds only the sized row; page 2 holds the flagged one.
    expect(page1.rows.map((r: any) => r.productId)).toEqual([1]);
    const row = rowOf(page2, 2);
    expect(row).toEqual({
      status: "unavailable",
      productId: 2,
      productName: "Unsized 2",
      currentStock: 0,
      reason: "no_demand_signal",
      orderSignal: { orderedUnits: 14, orders: 7 },
      outOfStockWithOrders: true,
    });
    for (const key of SIZING_KEYS) expect(row).not.toHaveProperty(key);
    // The envelope list is the same on every page — the model cannot page past it.
    for (const page of [page1, page2]) {
      expect(page.outOfStockWithOrdersProducts).toEqual([
        { productId: 2, productName: "Unsized 2", orderedUnits: 14, orders: 7 },
      ]);
      expect(page.outOfStockWithOrdersOmitted).toBe(0);
      expect(page.counts.outOfStockWithOrders).toBe(1);
      expect(page.coverage.orderSignalCoverage).toBe("full");
    }
  });

  it("no fact row under full coverage is a MEASURED zero: {0, 0}, not flagged", async () => {
    seedFacts(FULL);
    mockReport.mockResolvedValue(reportOf([unsized(3, 0)]));
    const { data } = await run({}, ["c1"]);
    expect(rowOf(data, 3)).toMatchObject({
      orderSignal: { orderedUnits: 0, orders: 0 },
      outOfStockWithOrders: false,
    });
    expect(rowOf(data, 3)).not.toHaveProperty("orderSignalReason");
    expect(data.counts.outOfStockWithOrders).toBe(0);
    expect(data.counts.orderSignalUnknown).toBe(0);
  });

  it("stock on hand is never flagged, whatever was ordered; insufficient_history rows carry the signal too", async () => {
    seedFacts(FULL);
    mockReport.mockResolvedValue(reportOf([unsized(2, 4, "insufficient_history")]));
    const { data } = await run({}, ["c1"]);
    expect(rowOf(data, 2)).toMatchObject({
      reason: "insufficient_history",
      orderSignal: { orderedUnits: 14, orders: 7 },
      outOfStockWithOrders: false,
    });
    expect(data.outOfStockWithOrdersProducts).toEqual([]);
  });

  it("the sized and requested-id rows carry NO order-signal key", async () => {
    seedFacts(FULL);
    mockReport.mockResolvedValue(
      reportOf([
        suggested(1, "OUT"),
        { status: "unavailable", productId: 9, productName: "Archived", currentStock: null, reason: "not_active" },
        { status: "unavailable", productId: 4242, productName: null, currentStock: null, reason: "unknown_id" },
      ]),
    );
    const { data } = await run({ productIds: [1, 9, 4242] }, ["c1"]);
    for (const row of data.rows) {
      expect(row).not.toHaveProperty("orderSignal");
      expect(row).not.toHaveProperty("outOfStockWithOrders");
    }
  });

  it("reads ONLY the unsized products, in the caller's companies, over the echoed window", async () => {
    seedFacts(FULL);
    mockReport.mockResolvedValue(reportOf([suggested(1, "OUT"), unsized(2, 0), unsized(3, 0)]));
    const { data } = await run({}, ["c1"]);
    const window = signalWindow();
    expect(data.coverage.orderSignalWindow).toEqual(window);
    const signalRead = db.productSalesFact.groupBy.mock.calls
      .map((c: any[]) => c[0])
      .find((a: any) => a.by[0] === "productId");
    expect(signalRead.where).toEqual({
      productId: { in: [2, 3] },
      companyId: { in: ["c1"] },
      dayKey: { gte: window.from, lte: window.to },
    });
  });
});

describe("A2 C4 — partial and absent coverage", () => {
  it("company-kind partial, no fact row: null + get_sales' reason, unknown, counted in orderSignalUnknown", async () => {
    // c1 recorded since 2020; c2 never recorded — covered caller-wide, degraded per company.
    seedFacts({
      approvedActiveIds: [2, 5],
      facts: [
        { productId: 2, companyId: "c1", dayKey: "2020-01-01", orderedQty: 1, orderCount: 1 },
        { productId: 2, companyId: "c1", dayKey: daysBack(3), orderedQty: 4, orderCount: 2 },
      ],
    });
    mockReport.mockResolvedValue(reportOf([unsized(2, 0), unsized(5, 0)]));
    const { data } = await run({}, ["c1", "c2"]);
    const window = signalWindow();

    expect(data.coverage.orderSignalCoverage).toBe("partial");
    // The per-company starts are relayed, with the measured-sums rule, as compare does.
    const perCompany = data.coverage.orderSignalCompanyCoverage;
    expect(perCompany.map((c: any) => c.companyId)).toEqual(["c1", "c2"]);
    expect(perCompany.map((c: any) => c.salesDataStart)).toEqual(["2020-01-01", null]);
    expect(data.coverage.orderSignalCompanyCoverageNote).toBe(SALES_COMPANY_COVERAGE_MEASURED_NOTE);

    // A recorded sum stands (a true statement about recorded facts)...
    expect(rowOf(data, 2)).toMatchObject({ orderSignal: { orderedUnits: 4, orders: 2 }, outOfStockWithOrders: true });
    expect(rowOf(data, 2)).not.toHaveProperty("orderSignalRecordedSince");
    // ...a missing one is UNKNOWN, in get_sales' own words over the same inputs.
    expect(rowOf(data, 5)).toEqual({
      ...unsized(5, 0),
      orderSignal: null,
      orderSignalReason: salesCoverageReason("2020-01-01", window.from, perCompany),
      outOfStockWithOrders: null,
    });
    expect(data.counts.outOfStockWithOrders).toBe(1); // a lower bound
    expect(data.counts.orderSignalUnknown).toBe(1);
  });

  it("window-kind partial, a fact row: the sums + the day order records began", async () => {
    const start = daysBack(20);
    seedFacts({
      approvedActiveIds: [2, 5],
      facts: [{ productId: 2, companyId: "c1", dayKey: start, orderedQty: 9, orderCount: 3 }],
    });
    mockReport.mockResolvedValue(reportOf([unsized(2, 0), unsized(5, 0)]));
    const { data } = await run({}, ["c1"]);
    expect(data.coverage.orderSignalCoverage).toBe("partial");
    expect(rowOf(data, 2)).toMatchObject({
      orderSignal: { orderedUnits: 9, orders: 3 },
      orderSignalRecordedSince: start,
      outOfStockWithOrders: true,
    });
    // Without a fact row the window kind is unknown too — never a zero.
    expect(rowOf(data, 5)).toMatchObject({
      orderSignal: null,
      orderSignalReason: salesCoverageReason(start, signalWindow().from),
      outOfStockWithOrders: null,
    });
    // One company: nothing staggered, so no per-company list and no measured note.
    expect(data.coverage).not.toHaveProperty("orderSignalCompanyCoverage");
    expect(data.coverage).not.toHaveProperty("orderSignalCompanyCoverageNote");
  });

  it("window-kind with staggered companies lists each company's start", async () => {
    seedFacts({
      approvedActiveIds: [2],
      facts: [
        { productId: 2, companyId: "c1", dayKey: daysBack(40), orderedQty: 2, orderCount: 1 },
        { productId: 2, companyId: "c2", dayKey: daysBack(8), orderedQty: 3, orderCount: 1 },
      ],
    });
    mockReport.mockResolvedValue(reportOf([unsized(2, 0)]));
    const { data } = await run({}, ["c1", "c2"]);
    expect(rowOf(data, 2)).toMatchObject({
      orderSignal: { orderedUnits: 5, orders: 2 },
      orderSignalRecordedSince: daysBack(40),
    });
    expect(data.coverage.orderSignalCompanyCoverage.map((c: any) => c.salesDataStart)).toEqual([
      daysBack(40),
      daysBack(8),
    ]);
    expect(data.coverage).not.toHaveProperty("orderSignalCompanyCoverageNote");
  });

  it("no company access: null + 'no company access' on every unsized row, the count null, NO read", async () => {
    mockReport.mockResolvedValue(reportOf([unsized(2, 0), unsized(5, 3)]));
    const { data } = await run({}, []);
    expect(rowOf(data, 2)).toMatchObject({
      orderSignal: null,
      orderSignalReason: "no company access",
      outOfStockWithOrders: null,
    });
    expect(rowOf(data, 5)).toMatchObject({ orderSignal: null, outOfStockWithOrders: false });
    expect(data.coverage.orderSignalCoverage).toBe("none");
    expect(data.counts.outOfStockWithOrders).toBeNull();
    expect(data.counts.orderSignalUnknown).toBe(2);
    expect(data.outOfStockWithOrdersProducts).toEqual([]);
    expect(db.product.findMany).not.toHaveBeenCalled();
    expect(db.productSalesFact.aggregate).not.toHaveBeenCalled();
    expect(db.productSalesFact.groupBy).not.toHaveBeenCalled();
  });

  it("no unsized row at all: nothing needed a signal — a measured 0, no coverage class, NO read", async () => {
    mockReport.mockResolvedValue(reportOf([suggested(1, "OUT"), suggested(2, "REORDER_NOW")]));
    const { data } = await run({}, ["c1"]);
    expect(data.counts.outOfStockWithOrders).toBe(0);
    expect(data.counts.orderSignalUnknown).toBe(0);
    expect(data.coverage).not.toHaveProperty("orderSignalCoverage");
    expect(data.outOfStockWithOrdersProducts).toEqual([]);
    expect(db.productSalesFact.groupBy).not.toHaveBeenCalled();
  });

  it("companies with no order records at all: none, get_sales' no-data reason", async () => {
    seedFacts({ approvedActiveIds: [2], facts: [] });
    mockReport.mockResolvedValue(reportOf([unsized(2, 0)]));
    const { data } = await run({}, ["c1"]);
    expect(data.coverage.orderSignalCoverage).toBe("none");
    expect(rowOf(data, 2)).toMatchObject({
      orderSignal: null,
      orderSignalReason: salesCoverageReason(null, signalWindow().from),
    });
    expect(data.counts.outOfStockWithOrders).toBeNull();
  });

  it("an UNAPPROVED product's older fact does not move the start (it would have read full)", async () => {
    const facts: Fact[] = [
      { productId: 99, companyId: "c1", dayKey: "2019-01-01", orderedQty: 50, orderCount: 5 },
      { productId: 2, companyId: "c1", dayKey: daysBack(10), orderedQty: 3, orderCount: 1 },
    ];
    seedFacts({ approvedActiveIds: [2, 5], facts });
    mockReport.mockResolvedValue(reportOf([unsized(2, 0), unsized(5, 0)]));
    const { data } = await run({}, ["c1"]);
    expect(data.coverage.orderSignalCoverage).toBe("partial");
    expect(rowOf(data, 2).orderSignalRecordedSince).toBe(daysBack(10));
    // ...so product 5's silence stays unknown instead of becoming a measured zero.
    expect(rowOf(data, 5).orderSignal).toBeNull();
    // Non-vacuity: were 99 in the approved-active scope, the same rows would read full.
    seedFacts({ approvedActiveIds: [2, 5, 99], facts });
    expect((await run({}, ["c1"])).data.coverage.orderSignalCoverage).toBe("full");
  });
});

describe("A2 C4 — the envelope list", () => {
  it("21 flagged products: 20 listed (most units first, then productId) + outOfStockWithOrdersOmitted 1", async () => {
    const ids = Array.from({ length: 21 }, (_, i) => 100 + i);
    seedFacts({
      approvedActiveIds: ids,
      facts: [
        { productId: 999, companyId: "c1", dayKey: "2020-01-01", orderedQty: 1, orderCount: 1 },
        // Units fall with the id, except two ties at 5 units (ids 115 and 116).
        ...ids.map((id) => ({
          productId: id,
          companyId: "c1",
          dayKey: daysBack(2),
          orderedQty: id === 116 ? 5 : 21 - (id - 100),
          orderCount: 1,
        })),
      ],
    });
    // approvedActiveIds must hold 999's fact in scope for the start: include it.
    db.product.findMany.mockResolvedValue([...ids, 999].map((id) => ({ id })));
    mockReport.mockResolvedValue(reportOf(ids.map((id) => unsized(id, 0))));
    const { data } = await run({ limit: 5 }, ["c1"]);

    expect(data.coverage.orderSignalCoverage).toBe("full");
    expect(data.counts.outOfStockWithOrders).toBe(21);
    expect(data.outOfStockWithOrdersProducts).toHaveLength(20);
    expect(data.outOfStockWithOrdersOmitted).toBe(1);
    const listed = data.outOfStockWithOrdersProducts.map((p: any) => p.productId);
    // 100 (21 units) first ... 115 and 116 tie at 5 units -> by productId ... 120 (1 unit) omitted.
    expect(listed.slice(0, 3)).toEqual([100, 101, 102]);
    expect(listed.slice(14, 17)).toEqual([114, 115, 116]);
    expect(listed).not.toContain(120);
    expect(data.outOfStockWithOrdersProducts[0]).toEqual({
      productId: 100,
      productName: "Unsized 100",
      orderedUnits: 21,
      orders: 1,
    });
    // The rows themselves are a 5-row page; the list is never paged.
    expect(data.rows).toHaveLength(5);
  });
});

describe("A2 C4 — mixed scope", () => {
  it("meta.scope is 'mixed' with a section scope map; the STATIC entry stays global", async () => {
    mockReport.mockResolvedValue(reportOf([unsized(2, 0)]));
    const { data, meta } = await run({}, []);
    expect(meta.scope).toBe("mixed");
    expect(TOOL_SCOPES.reorder_report).toBe("global");
    expect(data.coverage.sectionScopes).toEqual({ rows: "global", orderSignal: "company" });
    expect(data.coverage.orderSignalDefinition).toBe(
      "orderSignal = units and orders attributed to this product in your companies' order " +
        "records over a 90-day calendar window (coverage.orderSignalWindow), shown only for " +
        "products the report cannot size. These are recorded orders, fulfilled or not — not a " +
        "count of currently open orders, and not the stock-outflow figures the report sizes " +
        "from; they are never added to them and never used to suggest a quantity. " +
        "outOfStockWithOrders marks a product with no stock now and recorded orders in that " +
        "window: the report cannot suggest a quantity, so it needs a manual decision. null = " +
        "the order records cannot tell (orderSignalReason says why); orderSignalRecordedSince = " +
        "the figures cover only the days since order records began.",
    );
  });

  it("the description states the order signal and the mixed scope in the contract's words", () => {
    const d = assistantTools.reorder_report.description;
    expect(d).toContain(
      "'unavailable' rows carry no sizing numbers — only a reason (no_demand_signal | " +
        "insufficient_history) and, from your companies' order records over a 90-day calendar " +
        "window, orderSignal (units and orders recorded) with outOfStockWithOrders when stock is " +
        "0; up to 20 out-of-stock-with-orders products are listed on every page " +
        "(counts.outOfStockWithOrders counts all). Recorded orders are a separate fact family — " +
        "never added to the stock-outflow figures and never a quantity. Results are mixed-scope: " +
        "rows are global, orderSignal is your companies'.",
    );
    expect(d).not.toContain("'unavailable' rows carry NO numbers");
  });
});

// ===========================================================================
// A2 pack C2 — counts, over the whole result
// ===========================================================================

describe("A2 C2 — reorder counts", () => {
  const ROWS = () => [
    suggested(1, "OUT"),
    suggested(2, "OUT"),
    suggested(3, "CRITICAL"),
    suggested(4, "REORDER_NOW"),
    suggested(5, "APPROACHING"),
    unsized(6, 0),
    unsized(7, 2),
    unsized(8, 0, "insufficient_history"),
    { status: "unavailable", productId: 9, productName: "Archived", currentStock: null, reason: "not_active" },
  ];

  it("counts every row of the result on a 2-row page, with its scope note", async () => {
    mockReport.mockResolvedValue(reportOf(ROWS(), { requested: { requested: 9, notActive: 1, unknownIds: 0 } }));
    const { data } = await run({ limit: 2, productIds: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, []);
    expect(data.rows).toHaveLength(2);
    expect(data.counts).toEqual({
      // productIds emits approaching AND healthy rows, so both keys are present.
      suggested: { OUT: 2, CRITICAL: 1, REORDER_NOW: 1, APPROACHING: 1, OK: 0 },
      // not_active stays in coverage.requested only.
      unavailable: { no_demand_signal: 2, insufficient_history: 1 },
      unavailableAtZeroStock: 2,
      outOfStockWithOrders: null, // no company access
      orderSignalUnknown: 3,
    });
    expect(data.countsNote).toBe(
      "counts cover every row of this result, not only this page; approaching and healthy " +
        "products that are not listed are counted in coverage.approachingOmitted and " +
        "coverage.healthy. Under partial order-record coverage outOfStockWithOrders is a lower " +
        "bound (orderSignalUnknown counts the products the records cannot tell about). Use " +
        "these for how many; never count rows yourself.",
    );
    const keys = Object.keys(data);
    expect(keys.indexOf("counts")).toBeLessThan(keys.indexOf("coverage"));
    expect(keys.indexOf("countsNote")).toBe(keys.indexOf("counts") + 1);
  });

  it("APPROACHING appears only when approaching rows are emitted; OK only when healthy rows are", async () => {
    const rows = ROWS().filter((r) => r.productId !== 9);
    const tiers = async (args: Record<string, unknown>) => {
      mockReport.mockResolvedValue(reportOf(rows));
      return Object.keys((await run(args, [])).data.counts.suggested);
    };
    // The tool's default emits approaching (includeOkay defaults to true), never healthy.
    expect(await tiers({})).toEqual(["OUT", "CRITICAL", "REORDER_NOW", "APPROACHING"]);
    expect(await tiers({ includeOkay: false })).toEqual(["OUT", "CRITICAL", "REORDER_NOW"]);
    expect(await tiers({ includeHealthy: true })).toEqual(["OUT", "CRITICAL", "REORDER_NOW", "APPROACHING", "OK"]);
    expect(await tiers({ includeOkay: false, includeHealthy: true })).toEqual([
      "OUT",
      "CRITICAL",
      "REORDER_NOW",
      "OK",
    ]);
  });

  it("an emitted OK row is counted under OK", async () => {
    mockReport.mockResolvedValue(reportOf([suggested(1, "OK"), suggested(2, "OUT")]));
    const { data } = await run({ includeHealthy: true }, []);
    expect(data.counts.suggested).toEqual({ OUT: 1, CRITICAL: 0, REORDER_NOW: 0, APPROACHING: 0, OK: 1 });
  });
});

// ===========================================================================
// A2 pack C5 — the rules ride with the rows
// ===========================================================================

describe("A2 C5 — definitions and the costed label", () => {
  it("definitions.urgency and definitions.reorderPoint, exactly", async () => {
    mockReport.mockResolvedValue(reportOf([suggested(1, "OUT")]));
    const { data } = await run({}, []);
    expect(data.definitions).toEqual({
      urgency:
        "OUT = stock 0 or less. CRITICAL = stock below lead-time demand (average daily demand × " +
        "lead time). REORDER_NOW = stock at or below the reorder point. APPROACHING = stock " +
        "above the reorder point but at or below 1.2 × it. Checked in that order; a product none " +
        "of them fits is healthy, and appears as a row (urgency OK) only when requested or " +
        "includeHealthy is set.",
      reorderPoint:
        "reorderPointSource 'computed' = average daily demand × (lead time + buffer days), " +
        "rounded up; 'override' = a reorder point set by hand on the product.",
    });
    // The rows carry the field the definition names.
    expect(data.rows[0].reorderPointSource).toBe("computed");
  });

  it("coverage.costedNote rides beside costed where total, suggested and costed all differ", async () => {
    const rows = [
      suggested(1, "OUT"),
      suggested(2, "CRITICAL", { costPrice: null, orderValue: null }),
      suggested(3, "REORDER_NOW", { costPrice: null, orderValue: null }),
    ];
    mockReport.mockResolvedValue(reportOf(rows, { total: 7, healthy: 4 }));
    const { data } = await run({}, []);
    expect(data.coverage).toMatchObject({ total: 7, suggested: 3, costed: 1 });
    expect(data.coverage.costedNote).toBe(
      "costed counts the suggested rows that have a cost price, out of the suggested rows " +
        "(coverage.suggested) — not out of the whole catalog (coverage.total). Every product's " +
        "unit cost is on the valuation tool's product rows.",
    );
    expect(data.coverage.costedNote).toBe(REORDER_COSTED_NOTE);
    expect(data.coverageNote).toBe(REORDER_COVERAGE_NOTE);
  });
});

// ===========================================================================
// A2 pack C4 (A2-G2S-22 / A2-G1R3-13) — the envelope's WORST case still leaves the rows
// their page: a full 20-entry list with 255-character names (schema.prisma:55), every note
// at its longest (company-kind partial: the per-company starts + the measured note), and
// the requested block.
// ===========================================================================

describe("A2 C4 — the worst-case envelope", () => {
  /** tools.ts's ENVELOPE_RESERVE_BYTES (not exported): the room every list tool leaves its
   *  envelope when it fits the page. */
  const ENVELOPE_RESERVE_BYTES = 8_192;
  let NAME = "N".repeat(255);
  const ids = Array.from({ length: 25 }, (_, i) => 1000 + i);
  const envelopeBytesOf = (data: any) => Buffer.byteLength(JSON.stringify({ ...data, rows: [] }), "utf8");
  afterEach(() => {
    NAME = "N".repeat(255);
  });

  async function worstCase(remainingBytes?: number) {
    // Company-kind partial over five companies: c0 records since 2020, the rest never did.
    const companies = ["c0", "c1", "c2", "c3", "c4"].map((c) => `${c}${"x".repeat(23)}`);
    seedFacts({
      approvedActiveIds: ids,
      facts: [
        { productId: 1, companyId: companies[0], dayKey: "2020-01-01", orderedQty: 1, orderCount: 1 },
        ...ids.map((id) => ({
          productId: id,
          companyId: companies[0],
          dayKey: daysBack(1),
          orderedQty: 99_999,
          orderCount: 9_999,
        })),
      ],
    });
    db.product.findMany.mockResolvedValue([1, ...ids].map((id) => ({ id })));
    const rows = ids.map((id) => ({ ...unsized(id, 0), productName: NAME }));
    mockReport.mockResolvedValue(
      reportOf(rows, { requested: { requested: 20, notActive: 20, unknownIds: 20 } }),
    );
    const result = await assistantTools.reorder_report.run(
      { includeHealthy: true, limit: 50 },
      testCtx({ companyIds: companies, ...(remainingBytes != null ? { remainingBytes } : {}) }),
    );
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    return result;
  }

  it("the worst case really is the worst case (non-vacuity)", async () => {
    const { data } = (await worstCase()) as { data: any };
    expect(data.outOfStockWithOrdersProducts).toHaveLength(20);
    expect(data.outOfStockWithOrdersOmitted).toBe(5);
    expect(data.outOfStockWithOrdersProducts.every((p: any) => p.productName.length === 255)).toBe(true);
    expect(data.coverage.orderSignalCompanyCoverage).toHaveLength(5);
    expect(data.coverage.orderSignalCompanyCoverageNote).toBe(SALES_COMPANY_COVERAGE_MEASURED_NOTE);
    expect(data.coverage.requested).toBeDefined();
  });

  it("names up to 120 characters: the WHOLE worst-case envelope stays under the fixed reserve", async () => {
    NAME = "N".repeat(120);
    const { data } = (await worstCase()) as { data: any };
    expect(data.outOfStockWithOrdersProducts).toHaveLength(20);
    expect(envelopeBytesOf(data)).toBeLessThan(ENVELOPE_RESERVE_BYTES);
  });

  it("255-character names outweigh the reserve, so the page is fit to the MEASURED envelope", async () => {
    // Recorded (A2 M2): ~10.4 KB at 20 x 255-character names — the list alone is ~6.5 KB,
    // so no envelope carrying it can sit under the 8 KiB reserve. The page gives way.
    const { data, meta } = (await worstCase()) as { data: any; meta: { bytes: number } };
    const envelope = envelopeBytesOf(data);
    expect(envelope).toBeGreaterThan(ENVELOPE_RESERVE_BYTES);
    expect(meta.bytes).toBeLessThanOrEqual(65_536);
    // All 25 rows fit the full budget beside it here; the tight budgets below shrink them.
    expect(data.returned).toBe(25);
  });

  it("the result never exceeds the byte budget it was given, at full and at tight budgets", async () => {
    for (const remaining of [65_536, 24_576, 16_384, 14_000]) {
      const result = await worstCase(remaining);
      expect({ remaining, fits: result.meta.bytes <= byteBudget(testCtx({ remainingBytes: remaining })) }).toEqual({
        remaining,
        fits: true,
      });
      // ...and it still answers with rows (degrade to a smaller page, never to nothing).
      expect((result.data as any).returned).toBeGreaterThan(0);
    }
  });
});
