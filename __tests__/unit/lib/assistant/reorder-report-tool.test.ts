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
 * A2 M4 (pack C1, C7): remainingRows, and the sales-freshness note on the order figures
 * (the REAL run-history read over a mocked delegate) — both inside the worst case.
 * A2 FR1 (pack C14): an unlinked product is `not_linked`, never a measured 0; the window's
 * unlinked orders are counted; short reason codes explained once in the envelope; the
 * unknown-flag count — all through the REAL order-signal module, inside the worst case.
 * A2 FR2 (pack C15): the page never takes more than the room the measured envelope leaves —
 * pinned THROUGH THE ADAPTER across a budget sweep; the run history is answered by a
 * query-faithful fake; the failed-attempt freshness wording.
 * A2 FR3 (pack C16): a no-fact product linked after the last FULL sales rebuild is
 * `not_yet_attributed`, never a measured 0 — one run-history read serving the freshness note
 * and that cutoff; the fake models each run's `mode`; inside the worst case.
 */

// `ai` (v7) is ESM-only; createAiTools only stores def+execute, never invokes ai's
// tool() body, so a passthrough is faithful (same stub the adapter suites use).
jest.mock("ai", () => ({ __esModule: true, tool: (def: unknown) => def }));
// The report is stubbed; the module's constants (definitions, notes) are the real ones.
jest.mock("@/lib/reports/reorder", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/reports/reorder"),
  getReorderReport: jest.fn(),
}));
// The order-signal read graph (approved-active scope + the per-company starts and, A2 C8,
// their names + the one grouped fact read) runs for real over these delegates; the other
// data-layer imports of tools.ts are unused by this suite.
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { findMany: jest.fn() },
    productSalesFact: { aggregate: jest.fn(), groupBy: jest.fn() },
    company: { findMany: jest.fn() },
    // A2 C7 / C15: the sales rebuild run history behind the freshness note (the newest
    // success, then the attempts after it).
    analyticsRebuildRun: { findFirst: jest.fn(), findMany: jest.fn() },
    // A2 C14: the caller's stores (from its orders), the listing reads behind "linked", and
    // the window's orders with an unattributable line.
    externalOrder: { groupBy: jest.fn(), count: jest.fn() },
    productLink: { findMany: jest.fn() },
    bundleComponent: { findMany: jest.fn() },
  },
}));
jest.mock("@/lib/products", () => ({ __esModule: true, getProductsWithQuantities: jest.fn() }));
jest.mock("@/lib/reports/low-stock", () => ({ __esModule: true, getLowStockReport: jest.fn() }));

import prisma from "@/lib/prisma";
import { assistantTools, TOOL_SCOPES, testCtx, byteBudget } from "@/lib/assistant/tools";
import { createAiTools } from "@/lib/assistant/tool-adapters";
import type { ToolContext as ResolvedContext } from "@/lib/assistant/context";
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
/** A2 C7: one sales rebuild run that finished `hoursAgo` hours before now. A2 C16: `mode` is
 *  the run's own ('nightly' | 'full' | 'backfill'); the default is the nightly. */
function salesRun(status: string, hoursAgo: number, skippedReason: string | null = null, mode = "nightly") {
  const finishedAt = new Date(Date.now() - hoursAgo * 3_600_000);
  return { status, startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt, skippedReason, mode };
}
type RunRow = ReturnType<typeof salesRun>;
type RunQuery = {
  where?: Record<string, unknown>;
  orderBy?: Record<string, string>;
  take?: number;
  select?: Record<string, boolean>;
};
/**
 * A2 C15: the sales run table, answered QUERY-FAITHFULLY — `where` (equality, `in`, `gt`, and
 * `not` with SQL's NULL rule: a NULL column never matches `<>`), `orderBy` startedAt, `take`
 * and `select` — so a read that asks the wrong question gets the wrong answer here too. An
 * operator it does not model throws rather than matching silently.
 */
function seedRuns(runs: RunRow[]) {
  const scalar = (v: unknown) => (v instanceof Date ? v.getTime() : v);
  const holds = (field: unknown, cond: unknown): boolean =>
    cond === null || typeof cond !== "object" || cond instanceof Date
      ? scalar(field) === scalar(cond)
      : Object.entries(cond).every(([op, arg]) => {
          if (op === "in") return (arg as unknown[]).some((v) => scalar(v) === scalar(field));
          if (op === "gt") return field != null && (scalar(field) as number) > (scalar(arg) as number);
          if (op === "not") return arg === null ? field != null : field != null && scalar(field) !== scalar(arg);
          throw new Error(`run fake: unmodelled operator ${op}`);
        });
  const query = ({ where = {}, orderBy, take, select }: RunQuery = {}) => {
    const rows: Array<Record<string, unknown>> = runs
      // A2 C16: every seeded run carries its mode (salesRun defaults it to the nightly).
      .map((run) => ({ job: "sales", ...run }))
      .filter((run: Record<string, unknown>) =>
        Object.entries(where).every(([key, cond]) => holds(run[key], cond)),
      );
    for (const [key, dir] of Object.entries(orderBy ?? {})) {
      if (key !== "startedAt") throw new Error(`run fake: unmodelled orderBy ${key}`);
      const sign = dir === "asc" ? 1 : -1;
      rows.sort((a, b) => sign * ((a.startedAt as Date).getTime() - (b.startedAt as Date).getTime()));
    }
    const page = take == null ? rows : rows.slice(0, take);
    if (!select) return page;
    const keys = Object.keys(select).filter((k) => select[k]);
    return page.map((row) => Object.fromEntries(keys.map((k) => [k, row[k]])));
  };
  db.analyticsRebuildRun.findFirst.mockImplementation(
    async (args?: RunQuery) => query({ ...args, take: 1 })[0] ?? null,
  );
  db.analyticsRebuildRun.findMany.mockImplementation(async (args?: RunQuery) => query(args));
}
/** A2 C15: neither run-history read was issued. */
function expectNoRunRead() {
  expect(db.analyticsRebuildRun.findFirst).not.toHaveBeenCalled();
  expect(db.analyticsRebuildRun.findMany).not.toHaveBeenCalled();
}
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
  db.company.findMany.mockReset();
  // A2 C8: the caller's companies by name (the per-company starts carry them).
  db.company.findMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
    args.where.id.in.map((id) => ({ id, name: `Company ${id}` })),
  );
  // A2 C7: a 2-hour-old successful sales rebuild — fresh, so no note unless a test says so.
  db.analyticsRebuildRun.findFirst.mockReset();
  db.analyticsRebuildRun.findMany.mockReset();
  seedRuns([salesRun("SUCCEEDED", 2)]);
  // A2 C14: by default every product is LINKED on the caller's one store and no order has an
  // unattributable line, so a missing fact row under full coverage is a measured 0 unless a
  // test seeds otherwise (seedListings).
  db.externalOrder.groupBy.mockReset();
  db.externalOrder.groupBy.mockResolvedValue([{ integrationId: "store-1" }]);
  db.externalOrder.count.mockReset();
  db.externalOrder.count.mockResolvedValue(0);
  db.productLink.findMany.mockReset();
  db.productLink.findMany.mockImplementation(async (args: { where: { internalProductId: { in: number[] } } }) =>
    args.where.internalProductId.in.map((internalProductId) => ({ internalProductId })),
  );
  db.bundleComponent.findMany.mockReset();
  db.bundleComponent.findMany.mockResolvedValue([]);
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
      // A2 C14: a short code on the row; its sentence rides once in coverage.
      orderSignalReason: "no_company_access",
      outOfStockWithOrders: false, // stock 5 on hand
    });
    expect(data.coverage.orderSignalReasons).toEqual({ no_company_access: "no company access" });
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
    // ...a missing one is UNKNOWN (A2 C14: a short code on the row), explained once in the
    // envelope in get_sales' own words over the same inputs.
    expect(rowOf(data, 5)).toEqual({
      ...unsized(5, 0),
      orderSignal: null,
      orderSignalReason: "not_recorded",
      outOfStockWithOrders: null,
    });
    expect(data.coverage.orderSignalReasons).toEqual({
      not_recorded: salesCoverageReason("2020-01-01", window.from, perCompany),
    });
    expect(data.counts.outOfStockWithOrders).toBe(1); // a lower bound
    expect(data.counts.outOfStockWithOrdersUnknown).toBe(1); // ...and the gap in it
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
      orderSignalReason: "not_recorded",
      outOfStockWithOrders: null,
    });
    expect(data.coverage.orderSignalReasons).toEqual({
      not_recorded: salesCoverageReason(start, signalWindow().from),
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

  it("no company access: null + 'no_company_access' on every unsized row, the count null, NO read", async () => {
    mockReport.mockResolvedValue(reportOf([unsized(2, 0), unsized(5, 3)]));
    const { data } = await run({}, []);
    expect(rowOf(data, 2)).toMatchObject({
      orderSignal: null,
      orderSignalReason: "no_company_access",
      outOfStockWithOrders: null,
    });
    expect(rowOf(data, 5)).toMatchObject({
      orderSignal: null,
      orderSignalReason: "no_company_access",
      outOfStockWithOrders: false,
    });
    expect(data.coverage.orderSignalReasons).toEqual({ no_company_access: "no company access" });
    expect(data.coverage.orderSignalCoverage).toBe("none");
    expect(data.counts.outOfStockWithOrders).toBeNull();
    // A2 C14: only the out-of-stock row's flag is unknown; the in-stock one is false.
    expect(data.counts.outOfStockWithOrdersUnknown).toBe(1);
    expect(data.counts.orderSignalUnknown).toBe(2);
    expect(data.outOfStockWithOrdersProducts).toEqual([]);
    expect(data.coverage).not.toHaveProperty("orderSignalUnlinkedOrders");
    expect(db.product.findMany).not.toHaveBeenCalled();
    expect(db.productSalesFact.aggregate).not.toHaveBeenCalled();
    expect(db.productSalesFact.groupBy).not.toHaveBeenCalled();
    expect(db.externalOrder.groupBy).not.toHaveBeenCalled();
    expect(db.externalOrder.count).not.toHaveBeenCalled();
  });

  it("no unsized row at all: nothing needed a signal — a measured 0, no coverage class, NO read", async () => {
    mockReport.mockResolvedValue(reportOf([suggested(1, "OUT"), suggested(2, "REORDER_NOW")]));
    const { data } = await run({}, ["c1"]);
    expect(data.counts.outOfStockWithOrders).toBe(0);
    // A2 C14: the unknown-flag count follows the same rule (the D5 signalNeeded rule).
    expect(data.counts.outOfStockWithOrdersUnknown).toBe(0);
    expect(data.counts.orderSignalUnknown).toBe(0);
    expect(data.coverage).not.toHaveProperty("orderSignalCoverage");
    expect(data.coverage).not.toHaveProperty("orderSignalReasons");
    expect(data.coverage).not.toHaveProperty("orderSignalUnlinkedOrders");
    expect(data.outOfStockWithOrdersProducts).toEqual([]);
    expect(db.productSalesFact.groupBy).not.toHaveBeenCalled();
    expect(db.externalOrder.groupBy).not.toHaveBeenCalled();
  });

  it("companies with no order records at all: none, get_sales' no-data reason", async () => {
    seedFacts({ approvedActiveIds: [2], facts: [] });
    mockReport.mockResolvedValue(reportOf([unsized(2, 0)]));
    const { data } = await run({}, ["c1"]);
    expect(data.coverage.orderSignalCoverage).toBe("none");
    expect(rowOf(data, 2)).toMatchObject({ orderSignal: null, orderSignalReason: "not_recorded" });
    expect(data.coverage.orderSignalReasons).toEqual({
      not_recorded: salesCoverageReason(null, signalWindow().from),
    });
    expect(data.counts.outOfStockWithOrders).toBeNull();
    // Coverage none: absence is already unknown, so no link check and no unlinked count.
    expect(db.externalOrder.groupBy).not.toHaveBeenCalled();
    expect(db.externalOrder.count).not.toHaveBeenCalled();
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

// ===========================================================================
// A2 pack C14 (A2-OCC-1 / OCC-3 / OCC-5) — an unlinked product is never a measured 0; the
// unlinked orders are counted; short codes explained once; the unknown-flag count
// ===========================================================================

/** A2 C16: a seeded listing's creation instant when the fixture does not name one — long
 *  before any seeded run, so the not-yet-attributed rule only fires where a test says so. */
const LISTED_LONG_AGO = new Date("2025-01-01T00:00:00.000Z");

/** The caller's stores (by company, from its orders), its listings, and the window's
 *  unlinked-order count — answered honoring the where clauses the module sends, and (A2 C16)
 *  with the columns each read SELECTS: a listing's createdAt directly, a component's through
 *  its bundle listing. */
function seedListings(opts: {
  stores: Record<string, string[]>;
  links?: Array<{ productId: number; store: string; createdAt?: Date }>;
  components?: Array<{ productId: number; store: string; createdAt?: Date }>;
  unlinkedOrders?: number;
}) {
  db.externalOrder.groupBy.mockImplementation(async (args: { where: { companyId: { in: string[] } } }) =>
    Object.entries(opts.stores)
      .filter(([companyId]) => args.where.companyId.in.includes(companyId))
      .flatMap(([, stores]) => stores)
      .map((integrationId) => ({ integrationId })),
  );
  const listingRead =
    (rows: Array<{ productId: number; store: string; createdAt?: Date }>, viaBundleListing: boolean) =>
    async (args: { where: Record<string, any>; select: Record<string, any> }) =>
      rows
        .filter(
          (row) =>
            args.where.internalProductId.in.includes(row.productId) &&
            (args.where.integrationId ?? args.where.productLink.integrationId).in.includes(row.store),
        )
        .map((row) => {
          const createdAt = row.createdAt ?? LISTED_LONG_AGO;
          return {
            internalProductId: row.productId,
            ...(!viaBundleListing && args.select.createdAt ? { createdAt } : {}),
            ...(viaBundleListing && args.select.productLink?.select?.createdAt ? { productLink: { createdAt } } : {}),
          };
        });
  db.productLink.findMany.mockImplementation(listingRead(opts.links ?? [], false));
  db.bundleComponent.findMany.mockImplementation(listingRead(opts.components ?? [], true));
  db.externalOrder.count.mockResolvedValue(opts.unlinkedOrders ?? 0);
}

const NOT_LINKED_SENTENCE =
  "no listing of it is linked on a store with recorded orders in your companies, so its orders cannot be attributed";

describe("A2 C14 — not_linked: an unlinked product is never a measured 0", () => {
  /** c1 has recorded since 2020 (full coverage); products 3 and 4 have no fact in the window. */
  const FULL = {
    approvedActiveIds: [3, 4],
    facts: [{ productId: 3, companyId: "c1", dayKey: "2020-01-01", orderedQty: 1, orderCount: 1 }] as Fact[],
  };

  it("full coverage, out of stock, unlinked, no fact row -> null + not_linked + flag null; its LINKED sibling is a measured {0, 0}", async () => {
    seedFacts(FULL);
    seedListings({ stores: { c1: ["s1"] }, links: [{ productId: 3, store: "s1" }] });
    mockReport.mockResolvedValue(reportOf([unsized(3, 0), unsized(4, 0)]));
    const { data } = await run({}, ["c1"]);
    expect(data.coverage.orderSignalCoverage).toBe("full");
    expect(rowOf(data, 3)).toEqual({ ...unsized(3, 0), orderSignal: { orderedUnits: 0, orders: 0 }, outOfStockWithOrders: false });
    expect(rowOf(data, 4)).toEqual({
      ...unsized(4, 0),
      orderSignal: null,
      orderSignalReason: "not_linked",
      outOfStockWithOrders: null,
    });
    expect(data.coverage.orderSignalReasons).toEqual({ not_linked: NOT_LINKED_SENTENCE });
    expect(data.counts).toMatchObject({ outOfStockWithOrders: 0, outOfStockWithOrdersUnknown: 1, orderSignalUnknown: 1 });
  });

  it("a product linked ONLY through a bundle component on the caller's store is linked: a measured 0", async () => {
    seedFacts(FULL);
    seedListings({ stores: { c1: ["s1"] }, components: [{ productId: 4, store: "s1" }] });
    mockReport.mockResolvedValue(reportOf([unsized(4, 0)]));
    const { data } = await run({}, ["c1"]);
    expect(rowOf(data, 4)).toMatchObject({ orderSignal: { orderedUnits: 0, orders: 0 }, outOfStockWithOrders: false });
    expect(rowOf(data, 4)).not.toHaveProperty("orderSignalReason");
    expect(data.coverage).not.toHaveProperty("orderSignalReasons");
  });

  it("a product linked ONLY on another company's store is not_linked (non-vacuity: on the caller's store it is a 0)", async () => {
    seedFacts(FULL);
    mockReport.mockResolvedValue(reportOf([unsized(4, 0)]));
    seedListings({ stores: { c1: ["s1"], c2: ["s2"] }, links: [{ productId: 4, store: "s2" }] });
    expect(rowOf((await run({}, ["c1"])).data, 4)).toMatchObject({ orderSignal: null, orderSignalReason: "not_linked" });
    seedListings({ stores: { c1: ["s1"], c2: ["s2"] }, links: [{ productId: 4, store: "s1" }] });
    expect(rowOf((await run({}, ["c1"])).data, 4)).toMatchObject({ orderSignal: { orderedUnits: 0, orders: 0 } });
  });

  it("partial coverage: unlinked -> not_linked, linked -> not_recorded; both sentences ride once", async () => {
    const start = daysBack(20);
    seedFacts({
      approvedActiveIds: [2, 3, 4],
      facts: [{ productId: 2, companyId: "c1", dayKey: start, orderedQty: 9, orderCount: 3 }],
    });
    seedListings({ stores: { c1: ["s1"] }, links: [{ productId: 3, store: "s1" }] });
    mockReport.mockResolvedValue(reportOf([unsized(2, 0), unsized(3, 0), unsized(4, 6)]));
    const { data } = await run({}, ["c1"]);
    expect(data.coverage.orderSignalCoverage).toBe("partial");
    expect(rowOf(data, 2)).toMatchObject({ orderSignal: { orderedUnits: 9, orders: 3 }, orderSignalRecordedSince: start });
    expect(rowOf(data, 3)).toMatchObject({ orderSignal: null, orderSignalReason: "not_recorded", outOfStockWithOrders: null });
    expect(rowOf(data, 4)).toMatchObject({ orderSignal: null, orderSignalReason: "not_linked", outOfStockWithOrders: false });
    expect(data.coverage.orderSignalReasons).toEqual({
      not_recorded: salesCoverageReason(start, signalWindow().from),
      not_linked: NOT_LINKED_SENTENCE,
    });
    // OCC-3: the in-stock unknown (4) is in orderSignalUnknown only.
    expect(data.counts).toMatchObject({ outOfStockWithOrders: 1, outOfStockWithOrdersUnknown: 1, orderSignalUnknown: 2 });
  });

  it("the reasons cover the RESULT, not the page: a page of sized rows still explains the codes beyond it", async () => {
    seedFacts(FULL);
    seedListings({ stores: { c1: ["s1"] } });
    mockReport.mockResolvedValue(reportOf([suggested(1, "OUT"), unsized(4, 0)]));
    const page1 = (await run({ limit: 1 }, ["c1"])).data;
    expect(page1.rows.map((r: any) => r.productId)).toEqual([1]);
    expect(page1.coverage.orderSignalReasons).toEqual({ not_linked: NOT_LINKED_SENTENCE });
    expect(page1.counts.outOfStockWithOrdersUnknown).toBe(1);
  });

  it("the window's unlinked orders: coverage.orderSignalUnlinkedOrders + the note, exactly; none -> neither key", async () => {
    seedFacts(FULL);
    seedListings({ stores: { c1: ["s1"] }, links: [{ productId: 3, store: "s1" }], unlinkedOrders: 3 });
    mockReport.mockResolvedValue(reportOf([unsized(3, 0)]));
    const { data } = await run({}, ["c1"]);
    expect(data.coverage.orderSignalUnlinkedOrders).toBe(3);
    // A2 C17 (A2-QA-2): the note names both unattributable line kinds the count now covers.
    expect(data.coverage.orderSignalUnlinkedNote).toBe(
      "3 orders in this window have at least one line the sales figures cannot attribute to a " +
        "product (a store listing not linked to a product, or a bundle line recorded without its " +
        "components); those lines are not in orderSignal, so a 0 can hide orders.",
    );
    // The count is the caller's companies' over the echoed window (the module pins the rest).
    const where = db.externalOrder.count.mock.calls[0][0].where;
    expect(where.companyId).toEqual({ in: ["c1"] });
    expect(where.OR[0].externalCreatedAt.gte).toEqual(new Date(`${signalWindow().from}T00:00:00.000Z`));
    seedListings({ stores: { c1: ["s1"] }, links: [{ productId: 3, store: "s1" }], unlinkedOrders: 0 });
    const clean = (await run({}, ["c1"])).data;
    expect(clean.coverage).not.toHaveProperty("orderSignalUnlinkedOrders");
    expect(clean.coverage).not.toHaveProperty("orderSignalUnlinkedNote");
  });
});

// ===========================================================================
// A2 pack C16 (A2-FD1-1) — a product linked after the last FULL sales rebuild is not a
// measured 0: linking back-fills the old order lines without a rebuild, the nightly re-reads
// only its rolling days plus days whose ORDERS changed, and only the full re-reads every day
// ===========================================================================

const NOT_YET_ATTRIBUTED_SENTENCE =
  "linked to a store listing after the last full sales rebuild, so orders on that listing may " +
  "not be counted yet";

describe("A2 C16 — not_yet_attributed: a link newer than the last full sales rebuild is never a measured 0", () => {
  /** c1 has recorded since 2020 (full coverage); products 3 and 4 have no fact in the window. */
  const FULL = {
    approvedActiveIds: [3, 4],
    facts: [{ productId: 3, companyId: "c1", dayKey: "2020-01-01", orderedQty: 1, orderCount: 1 }] as Fact[],
  };
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
  /** The last FULL success started ~100 hours ago; a fresh nightly finished 2 hours ago. */
  const FULL_RUN = salesRun("SUCCEEDED", 100, null, "full");
  const NIGHTLY_RUN = salesRun("SUCCEEDED", 2);

  it("a no-fact, out-of-stock product whose only link is newer than the last full success -> null + not_yet_attributed + flag null", async () => {
    seedFacts(FULL);
    seedRuns([FULL_RUN, NIGHTLY_RUN]);
    seedListings({
      stores: { c1: ["s1"] },
      links: [
        { productId: 3, store: "s1", createdAt: hoursAgo(20) }, // after the full run started
        { productId: 4, store: "s1", createdAt: hoursAgo(200) }, // before it
      ],
    });
    mockReport.mockResolvedValue(reportOf([unsized(3, 0), unsized(4, 0)]));
    const { data } = await run({}, ["c1"]);
    expect(data.coverage.orderSignalCoverage).toBe("full");
    expect(rowOf(data, 3)).toEqual({
      ...unsized(3, 0),
      orderSignal: null,
      orderSignalReason: "not_yet_attributed",
      outOfStockWithOrders: null,
    });
    // The same link OLDER than the cutoff: the full rebuild read its orders — a measured 0.
    expect(rowOf(data, 4)).toEqual({ ...unsized(4, 0), orderSignal: { orderedUnits: 0, orders: 0 }, outOfStockWithOrders: false });
    expect(data.coverage.orderSignalReasons).toEqual({ not_yet_attributed: NOT_YET_ATTRIBUTED_SENTENCE });
    expect(data.counts).toMatchObject({ outOfStockWithOrders: 0, outOfStockWithOrdersUnknown: 1, orderSignalUnknown: 1 });
  });

  it("its bundle-only twin: a component of a bundle listing made after the cutoff (the listing's createdAt)", async () => {
    seedFacts(FULL);
    seedRuns([FULL_RUN]);
    seedListings({ stores: { c1: ["s1"] }, components: [{ productId: 4, store: "s1", createdAt: hoursAgo(20) }] });
    mockReport.mockResolvedValue(reportOf([unsized(4, 0)]));
    const { data } = await run({}, ["c1"]);
    expect(rowOf(data, 4)).toMatchObject({ orderSignal: null, orderSignalReason: "not_yet_attributed", outOfStockWithOrders: null });
    // Non-vacuity: the same bundle listing made before the cutoff is a measured 0.
    seedListings({ stores: { c1: ["s1"] }, components: [{ productId: 4, store: "s1", createdAt: hoursAgo(200) }] });
    expect(rowOf((await run({}, ["c1"])).data, 4)).toMatchObject({ orderSignal: { orderedUnits: 0, orders: 0 } });
  });

  it("a nightly success NEWER than the link, but no newer full: still not_yet_attributed", async () => {
    seedFacts(FULL);
    // The link was made 20 hours ago; the nightly that finished 2 hours ago does not re-read
    // the old days its back-filled lines sit on. Only the full one (100 hours ago) did.
    seedRuns([FULL_RUN, NIGHTLY_RUN]);
    seedListings({ stores: { c1: ["s1"] }, links: [{ productId: 3, store: "s1", createdAt: hoursAgo(20) }] });
    mockReport.mockResolvedValue(reportOf([unsized(3, 0)]));
    expect(rowOf((await run({}, ["c1"])).data, 3)).toMatchObject({ orderSignal: null, orderSignalReason: "not_yet_attributed" });
    // Non-vacuity: once a FULL success starts after the link, it is a measured 0 again.
    seedRuns([FULL_RUN, salesRun("SUCCEEDED", 2, null, "full")]);
    expect(rowOf((await run({}, ["c1"])).data, 3)).toMatchObject({ orderSignal: { orderedUnits: 0, orders: 0 } });
  });

  it("the newest of a product's links decides: an old link beside a new one is still not_yet_attributed", async () => {
    seedFacts(FULL);
    seedRuns([FULL_RUN]);
    seedListings({
      stores: { c1: ["s1"] },
      links: [{ productId: 3, store: "s1", createdAt: hoursAgo(500) }],
      components: [{ productId: 3, store: "s1", createdAt: hoursAgo(20) }],
    });
    mockReport.mockResolvedValue(reportOf([unsized(3, 0)]));
    expect(rowOf((await run({}, ["c1"])).data, 3)).toMatchObject({ orderSignal: null, orderSignalReason: "not_yet_attributed" });
  });

  it("no full success on record: the rule does not apply (a measured 0 under full coverage)", async () => {
    seedFacts(FULL);
    seedRuns([NIGHTLY_RUN]);
    seedListings({ stores: { c1: ["s1"] }, links: [{ productId: 3, store: "s1", createdAt: hoursAgo(1) }] });
    mockReport.mockResolvedValue(reportOf([unsized(3, 0)]));
    const { data } = await run({}, ["c1"]);
    expect(rowOf(data, 3)).toMatchObject({ orderSignal: { orderedUnits: 0, orders: 0 }, outOfStockWithOrders: false });
    expect(data.coverage).not.toHaveProperty("orderSignalReasons");
  });

  it("no state (a throwing run-history read): the rule does not apply, and no note", async () => {
    seedFacts(FULL);
    seedListings({ stores: { c1: ["s1"] }, links: [{ productId: 3, store: "s1", createdAt: hoursAgo(1) }] });
    db.analyticsRebuildRun.findFirst.mockRejectedValue(new Error("analytics_rebuild_runs unreachable"));
    mockReport.mockResolvedValue(reportOf([unsized(3, 0)]));
    const { data } = await run({}, ["c1"]);
    expect(rowOf(data, 3)).toMatchObject({ orderSignal: { orderedUnits: 0, orders: 0 } });
    expect(data.coverage).not.toHaveProperty("salesFreshnessNote");
  });

  it("a product WITH a fact row keeps its recorded sum, whatever its link's age", async () => {
    seedFacts({
      approvedActiveIds: [3],
      facts: [
        { productId: 3, companyId: "c1", dayKey: "2020-01-01", orderedQty: 1, orderCount: 1 },
        { productId: 3, companyId: "c1", dayKey: daysBack(3), orderedQty: 5, orderCount: 2 },
      ],
    });
    seedRuns([FULL_RUN]);
    seedListings({ stores: { c1: ["s1"] }, links: [{ productId: 3, store: "s1", createdAt: hoursAgo(20) }] });
    mockReport.mockResolvedValue(reportOf([unsized(3, 0)]));
    expect(rowOf((await run({}, ["c1"])).data, 3)).toMatchObject({ orderSignal: { orderedUnits: 5, orders: 2 }, outOfStockWithOrders: true });
  });

  it("partial coverage: a linked no-fact product newer than the cutoff is not_yet_attributed; unlinked stays not_linked", async () => {
    const start = daysBack(20);
    seedFacts({
      approvedActiveIds: [2, 3, 4, 5],
      facts: [{ productId: 2, companyId: "c1", dayKey: start, orderedQty: 9, orderCount: 3 }],
    });
    seedRuns([FULL_RUN]);
    seedListings({
      stores: { c1: ["s1"] },
      links: [
        { productId: 3, store: "s1", createdAt: hoursAgo(20) },
        { productId: 5, store: "s1", createdAt: hoursAgo(200) },
      ],
    });
    mockReport.mockResolvedValue(reportOf([unsized(2, 0), unsized(3, 0), unsized(4, 0), unsized(5, 0)]));
    const { data } = await run({}, ["c1"]);
    expect(data.coverage.orderSignalCoverage).toBe("partial");
    expect(rowOf(data, 3)).toMatchObject({ orderSignal: null, orderSignalReason: "not_yet_attributed", outOfStockWithOrders: null });
    expect(rowOf(data, 4)).toMatchObject({ orderSignal: null, orderSignalReason: "not_linked" });
    expect(rowOf(data, 5)).toMatchObject({ orderSignal: null, orderSignalReason: "not_recorded" });
    expect(data.coverage.orderSignalReasons).toEqual({
      not_yet_attributed: NOT_YET_ATTRIBUTED_SENTENCE,
      not_linked: NOT_LINKED_SENTENCE,
      not_recorded: salesCoverageReason(start, signalWindow().from),
    });
  });

  it("ONE state read per call serves both the freshness note and the cutoff", async () => {
    seedFacts(FULL);
    const stale = salesRun("SUCCEEDED", 30, null, "full");
    seedRuns([stale]);
    seedListings({ stores: { c1: ["s1"] }, links: [{ productId: 3, store: "s1", createdAt: hoursAgo(20) }] });
    mockReport.mockResolvedValue(reportOf([unsized(3, 0)]));
    const { data } = await run({}, ["c1"]);
    // Both consumers of the one read: the stale note AND the cutoff.
    expect(data.coverage.salesFreshnessNote).toContain("more than a day ago");
    expect(rowOf(data, 3)).toMatchObject({ orderSignalReason: "not_yet_attributed" });
    // One salesRebuildState: its newest-success read, its full-success read, its attempts read.
    expect(db.analyticsRebuildRun.findFirst).toHaveBeenCalledTimes(2);
    expect(db.analyticsRebuildRun.findMany).toHaveBeenCalledTimes(1);
    const reads = db.analyticsRebuildRun.findFirst.mock.calls.map((c: any[]) => c[0].where);
    expect(reads).toEqual([
      { job: "sales", status: "SUCCEEDED", finishedAt: { not: null } },
      { job: "sales", status: "SUCCEEDED", mode: "full", finishedAt: { not: null } },
    ]);
  });

  it("no company access: the rule never reads the run history (no state, no rule)", async () => {
    mockReport.mockResolvedValue(reportOf([unsized(3, 0)]));
    seedRuns([FULL_RUN]);
    const { data } = await run({}, []);
    expect(rowOf(data, 3)).toMatchObject({ orderSignal: null, orderSignalReason: "no_company_access" });
    expectNoRunRead();
  });
});

// ===========================================================================
// A2 pack C7 — the order figures carry the sales-freshness note (material staleness only;
// never for a caller with no companies; only when there ARE order figures; non-fatal)
// ===========================================================================

describe("A2 C7 — coverage.salesFreshnessNote on the reorder order signal", () => {
  const FULL = { approvedActiveIds: [2], facts: [{ productId: 2, companyId: "c1", dayKey: "2020-01-01", orderedQty: 1, orderCount: 1 }] };

  it("a 30-hour-old success: the stale note; a 20-hour-old one: none", async () => {
    seedFacts(FULL);
    mockReport.mockResolvedValue(reportOf([unsized(2, 0)]));
    const stale = salesRun("SUCCEEDED", 30);
    seedRuns([stale]);
    expect((await run({}, ["c1"])).data.coverage.salesFreshnessNote).toBe(
      `The last successful sales rebuild finished at ${stale.finishedAt.toISOString()}, more than a ` +
        `day ago; orders recorded after that are not counted yet.`,
    );
    seedRuns([salesRun("SUCCEEDED", 20)]);
    expect((await run({}, ["c1"])).data.coverage).not.toHaveProperty("salesFreshnessNote");
  });

  it("a FAILED run (NULL skippedReason) after the success: 'did not succeed'; a lock-held ABORTED row is ignored", async () => {
    seedFacts(FULL);
    mockReport.mockResolvedValue(reportOf([unsized(2, 0)]));
    const success = salesRun("SUCCEEDED", 20);
    seedRuns([salesRun("FAILED", 1), success]);
    // A2 C15 (A2-CR-4): no "as of" claim — a failed attempt can leave some days rebuilt.
    expect((await run({}, ["c1"])).data.coverage.salesFreshnessNote).toBe(
      `The latest sales rebuild attempt did not succeed; the last successful rebuild finished at ` +
        `${success.finishedAt.toISOString()}, and orders recorded since then may be missing or only ` +
        `partly counted.`,
    );
    seedRuns([salesRun("ABORTED", 1, "lock-held"), success]);
    expect((await run({}, ["c1"])).data.coverage).not.toHaveProperty("salesFreshnessNote");
  });

  it("no company access: no note and NO run-history read", async () => {
    mockReport.mockResolvedValue(reportOf([unsized(2, 0)]));
    seedRuns([salesRun("SUCCEEDED", 30)]);
    const { data } = await run({}, []);
    expect(data.coverage).not.toHaveProperty("salesFreshnessNote");
    expectNoRunRead();
  });

  it("no unsized row (no order figures in the payload): no note and NO run-history read", async () => {
    mockReport.mockResolvedValue(reportOf([suggested(1, "OUT")]));
    seedRuns([salesRun("SUCCEEDED", 30)]);
    const { data } = await run({}, ["c1"]);
    expect(data.coverage).not.toHaveProperty("salesFreshnessNote");
    expectNoRunRead();
  });

  it("a throwing run-history read: no note, and the order signal is intact", async () => {
    seedFacts(FULL);
    mockReport.mockResolvedValue(reportOf([unsized(2, 0)]));
    db.analyticsRebuildRun.findFirst.mockRejectedValue(new Error("analytics_rebuild_runs unreachable"));
    const { data } = await run({}, ["c1"]);
    expect(data.coverage).not.toHaveProperty("salesFreshnessNote");
    expect(data.coverage.orderSignalCoverage).toBe("full");
    expect(rowOf(data, 2)).toMatchObject({ orderSignal: { orderedUnits: 0, orders: 0 } });
  });

  it("A2 C1: remainingRows counts the rows after the page, right after nextOffset", async () => {
    mockReport.mockResolvedValue(reportOf([suggested(1, "OUT"), suggested(2, "CRITICAL"), suggested(3, "REORDER_NOW")]));
    const page1 = (await run({ limit: 1 }, ["c1"])).data;
    expect(page1).toMatchObject({ returned: 1, totalRows: 3, nextOffset: 1, remainingRows: 2 });
    const keys = Object.keys(page1);
    expect(keys.indexOf("remainingRows")).toBe(keys.indexOf("nextOffset") + 1);
    const last = (await run({ limit: 1, offset: 2 }, ["c1"])).data;
    expect(last).toMatchObject({ returned: 1, nextOffset: null, remainingRows: 0 });
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
    // A2 C17 (A2-QA-5): the newest orders are not facts yet, so a 0 is "none recorded before then".
    expect(data.coverage.orderSignalDefinition).toBe(
      "orderSignal = units and orders attributed to this product in your companies' order " +
        "records over a 90-day calendar window (coverage.orderSignalWindow), shown only for " +
        "products the report cannot size. Orders since the last sales rebuild (usually today's, " +
        "and before the nightly rebuild yesterday's too) are not counted yet, so a 0 means none " +
        "recorded before then. These are recorded orders, fulfilled or not — not a " +
        "count of currently open orders, and not the stock-outflow figures the report sizes " +
        "from; they are never added to them and never used to suggest a quantity. " +
        "outOfStockWithOrders marks a product with no stock now and recorded orders in that " +
        "window: the report cannot suggest a quantity, so it needs a manual decision. null = " +
        "the order records cannot tell; orderSignalReason is a code that " +
        "coverage.orderSignalReasons explains; orderSignalRecordedSince = the figures cover " +
        "only the days since order records began.",
    );
  });

  it("the description states the order signal and the mixed scope in the contract's words", () => {
    const d = assistantTools.reorder_report.description;
    expect(d).toContain(
      "'unavailable' rows carry no sizing numbers — only a reason (no_demand_signal | " +
        "insufficient_history) and, from your companies' order records over a 90-day calendar " +
        "window, orderSignal (units and orders recorded) with outOfStockWithOrders when stock is " +
        "0; up to 20 out-of-stock-with-orders products — among the products the report cannot " +
        "size — are listed on every page (counts.outOfStockWithOrders counts all of those). " +
        "Recorded orders are a separate fact family — " +
        "never added to the stock-outflow figures and never a quantity. Results are mixed-scope: " +
        "rows are global, orderSignal is your companies'.",
    );
    expect(d).not.toContain("'unavailable' rows carry NO numbers");
    // A2 C14 (A2-OCC-6): the old "counts all" overstated the count's scope.
    expect(d).not.toContain("(counts.outOfStockWithOrders counts all).");
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
      // A2 C14: the two zero-stock unsized rows (6, 8); the in-stock one (7) is false.
      outOfStockWithOrdersUnknown: 2,
      orderSignalUnknown: 3,
    });
    expect(data.countsNote).toBe(
      "counts cover every row of this result, not only this page; approaching and healthy " +
        "products that are not listed are counted in coverage.approachingOmitted and " +
        "coverage.healthy. outOfStockWithOrders is a lower bound whenever " +
        "outOfStockWithOrdersUnknown is above 0 — outOfStockWithOrdersUnknown counts the " +
        "out-of-stock products the order records cannot tell about. Use these for how many; " +
        "never count rows yourself.",
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
// the requested block. A2 C8 (M3): the per-company starts now carry each company's NAME,
// so the worst case also gives every company a 191-character name (`companies.name` is
// VARCHAR(191), migration 20251212_add_multitenancy_tables).
// ===========================================================================

describe("A2 C4 — the worst-case envelope", () => {
  /** tools.ts's ENVELOPE_RESERVE_BYTES (not exported): the room every list tool leaves its
   *  envelope when it fits the page. */
  const ENVELOPE_RESERVE_BYTES = 8_192;
  let NAME = "N".repeat(255);
  const ids = Array.from({ length: 25 }, (_, i) => 1000 + i);
  /** A2 C14: unsized products with no fact row — one linked, one not; A2 C16: and one linked
   *  after the last full sales rebuild started. */
  const NO_FACT_IDS = [2000, 2001, 2002];
  const envelopeBytesOf = (data: any) => Buffer.byteLength(JSON.stringify({ ...data, rows: [] }), "utf8");
  afterEach(() => {
    NAME = "N".repeat(255);
  });

  async function worstCase(remainingBytes?: number) {
    // Company-kind partial over five companies: c0 records since 2020, the rest never did.
    const companies = ["c0", "c1", "c2", "c3", "c4"].map((c) => `${c}${"x".repeat(23)}`);
    db.company.findMany.mockResolvedValue(companies.map((id) => ({ id, name: "C".repeat(191) })));
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
    db.product.findMany.mockResolvedValue([1, ...ids, ...NO_FACT_IDS].map((id) => ({ id })));
    // A2 M4 (pack C7): the LONGEST freshness note — a stale success with a newer attempt
    // that did not succeed (A2 C15: "..., more than a day ago, and a later attempt did not
    // succeed; ..." — 195 characters with its instant, still the longest of the four).
    // A2 C16: plus an older FULL success, the cutoff the not_yet_attributed rule reads.
    seedRuns([salesRun("FAILED", 1), salesRun("SUCCEEDED", 30), salesRun("SUCCEEDED", 200, null, "full")]);
    // A2 FR1 (pack C14): BOTH reason codes a covered caller can carry — a linked no-fact
    // product (not_recorded: get_sales' company-kind sentence, naming the four silent
    // 191-character companies) and an unlinked one (not_linked) — plus the unlinked-orders
    // note at a seven-digit count.
    // A2 FR3 (pack C16): and the third code — a no-fact product linked an hour ago, after the
    // last full success started (not_yet_attributed).
    seedListings({
      stores: { [companies[0]]: ["s0"] },
      links: [
        { productId: NO_FACT_IDS[0], store: "s0" },
        { productId: NO_FACT_IDS[2], store: "s0", createdAt: new Date(Date.now() - 3_600_000) },
      ],
      unlinkedOrders: 9_999_999,
    });
    const rows = [...ids, ...NO_FACT_IDS].map((id) => ({ ...unsized(id, 0), productName: NAME }));
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
    expect(data.coverage.orderSignalCompanyCoverage.every((c: any) => c.name.length === 191)).toBe(true);
    expect(data.coverage.orderSignalCompanyCoverageNote).toBe(SALES_COMPANY_COVERAGE_MEASURED_NOTE);
    expect(data.coverage.requested).toBeDefined();
    // A2 FR1: both codes' sentences (the long one names the companies) and the unlinked note.
    // A2 FR3: and the third code a covered caller can carry, not_yet_attributed.
    expect(Object.keys(data.coverage.orderSignalReasons).sort()).toEqual([
      "not_linked",
      "not_recorded",
      "not_yet_attributed",
    ]);
    expect(data.coverage.orderSignalReasons.not_recorded).toContain("C".repeat(191));
    expect(data.coverage.orderSignalUnlinkedOrders).toBe(9_999_999);
    expect(data.coverage.orderSignalUnlinkedNote).toContain("9999999 orders in this window");
    // A2 M4: the two keys M4 adds ride in the worst case — the freshness note at its longest.
    expect(data.coverage.salesFreshnessNote).toMatch(
      /^The last successful sales rebuild finished at .+, more than a day ago, and a later attempt did not succeed; orders recorded since then may be missing or only partly counted\.$/,
    );
    expect(data).toHaveProperty("remainingRows");
  });

  // Recorded (A2 M3): the five 191-character company names add ~0.95 KB, so the product-
  // name length up to which the whole worst case stays under the reserve fell from 120
  // (M2, no company names: ~7.8 KB) to ~92 (at 120 it is now ~8.7 KB). Past it the page is
  // fit to the MEASURED envelope (the two pins below) — the budget is never exceeded.
  // Recorded (A2 M4): remainingRows (~19 B) and the longest freshness note (~190 B, the
  // stale sentence + "did not succeed") move it again, to 80 characters: 8,175 B at 80,
  // 8,195 B at 81, 8,375 B at 90 (11,675 B at 255).
  // Recorded (A2 FR1, pack C14): the worst case now also carries both reason codes' sentences
  // once — not_recorded is get_sales' company-kind sentence, which names the four silent
  // 191-character companies (~0.98 KB) — the not_linked sentence, the unlinked-orders note at
  // a seven-digit count and outOfStockWithOrdersUnknown: +1,468 B at 80 characters (9,643 B).
  // The threshold moves to 7 characters: 8,043 B at 0, 8,183 B at 7, 8,203 B at 8, 9,643 B at
  // 80 (13,143 B at 255). Past it the page is fit to the MEASURED envelope, as before.
  // Recorded (A2 FR2, pack C15): the longest freshness note is now the one stale + failed
  // sentence (195 characters, 11 more than the old stale sentence + "did not succeed"); with
  // the orchestrator's FR1 wording fixes the worst case measures 8,047 B at 0, 8,187 B at 7,
  // 8,207 B at 8, 9,647 B at 80 (13,147 B at 255) — the threshold stays at 7 characters. Under
  // C15 the side of the reserve no longer matters for safety: the row budget never exceeds the
  // room the measured envelope leaves (the adapter sweep at the end of this file).
  // Recorded (A2 FR3, pack C16): the worst case now also carries the third reason code a
  // covered caller can carry — not_yet_attributed's sentence, once (+158 B). It measures
  // 8,205 B at 0 characters, 8,345 B at 7, 9,805 B at 80 (13,305 B at 255): over the fixed
  // reserve at EVERY name length, so the worst case always takes the measured-room fit (C15).
  // The pin below holds that fact and the budget safety at the shortest names.
  it("the worst case outweighs the fixed reserve at every name length now, and still fits its budget", async () => {
    NAME = "";
    const { data } = (await worstCase()) as { data: any };
    expect(data.outOfStockWithOrdersProducts).toHaveLength(20);
    expect(envelopeBytesOf(data)).toBeGreaterThan(ENVELOPE_RESERVE_BYTES);
    for (const remaining of [65_536, 16_384, 12_000, 9_000]) {
      const result = await worstCase(remaining);
      expect({ remaining, fits: result.meta.bytes <= byteBudget(testCtx({ remainingBytes: remaining })) }).toEqual({
        remaining,
        fits: true,
      });
      expect((result.data as any).returned).toBeGreaterThan(0);
    }
  });

  it("255-character names outweigh the reserve, so the page is fit to the MEASURED envelope", async () => {
    // Recorded (A2 M2): ~10.4 KB at 20 x 255-character names — the list alone is ~6.5 KB,
    // so no envelope carrying it can sit under the 8 KiB reserve. The page gives way.
    // (A2 M3: ~11.4 KB once the five company names ride in orderSignalCompanyCoverage;
    // A2 M4: 11,675 B with remainingRows and the longest freshness note; A2 FR1: 13,143 B
    // with both reason sentences and the unlinked-orders note; A2 FR3: 13,305 B with the
    // not_yet_attributed sentence.)
    const { data, meta } = (await worstCase()) as { data: any; meta: { bytes: number } };
    const envelope = envelopeBytesOf(data);
    expect(envelope).toBeGreaterThan(ENVELOPE_RESERVE_BYTES);
    expect(meta.bytes).toBeLessThanOrEqual(65_536);
    // All 28 rows (A2 FR3: a third no-fact product) fit the full budget beside it here; the
    // tight budgets below shrink them.
    expect(data.returned).toBe(28);
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

// ===========================================================================
// A2 pack C15 (A2-CR-3) — the page never takes more than the room the MEASURED envelope
// leaves. Pinned THROUGH THE ADAPTER (createAiTools with a real budget.remaining), the only
// place an over-budget result is discarded whole: an envelope just under the 8 KiB reserve
// used to keep the 4 KiB row floor, so at a 12,000 B budget the result reached 12,058 B
// (codex's probe) and the model got a truncation notice instead of a page.
// ===========================================================================

describe("A2 C15 — reorder's page fits the measured room, through the adapter", () => {
  /** tools.ts's ENVELOPE_RESERVE_BYTES and MIN_RANK_PAGE_BYTES (not exported). */
  const ENVELOPE_RESERVE_BYTES = 8_192;
  const MIN_RANK_PAGE_BYTES = 4_096;
  const COMPANIES = ["c0", "c1", "c2", "c3", "c4"].map((c) => `${c}${"x".repeat(23)}`);
  const ADAPTER_CTX = { userId: 1, tokenId: null, surface: "web", companyIds: COMPANIES } as unknown as ResolvedContext;
  const ARGS = { includeHealthy: true, limit: 50 };
  const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  /** What ships around the rows (rows: []). */
  const envelopeBytesOf = (data: any) => bytesOf({ ...data, rows: [] });
  /** The tool's own measurement: rows: [] and the widest counters (A2 C1 / C4). */
  const measuredEnvelopeOf = (data: any) =>
    bytesOf({
      ...data,
      rows: [],
      returned: data.totalRows,
      nextOffset: data.totalRows >= 1000 ? data.totalRows : null,
      remainingRows: data.totalRows,
    });

  /**
   * Codex's probe: 25 unsized products at 0 stock with recorded orders in c0 only, over five
   * 191-character companies of which only c0 records (a company-kind partial), and a 30-hour-
   * old success (the stale freshness note, a string C15 leaves unchanged). With 80-character
   * names the whole envelope sits just UNDER the reserve — measured 8,163 B at `df6c83d`,
   * where this probe shipped 12,105 B at a 12,000 B budget and the adapter discarded it; with
   * 255-character names it is well over the reserve.
   *
   * A2 FR3 (pack C16): `notYetAttributed` adds one no-fact product at 0 stock whose listing was
   * made after the last FULL sales success started — so the sweep also weighs C16's code and
   * sentence (the plain probe has a fact row for every product and never reaches them).
   *
   * A2 FR5 (pack C17) — RECORDED: the order-signal definition's newest-orders sentence moved
   * the 80-character probe OVER the reserve (8,351 B), so the just-under probe now uses
   * `UNDER_RESERVE_NAMES` = 70-character names: 8,151 B (41 B under; 72 characters is 8,191 B),
   * and 8,307 B with the not-yet-attributed product (over, as FR3's case needs). Each character
   * of name length is 20 B here (the 20 listed out-of-stock-with-orders products).
   */
  const UNDER_RESERVE_NAMES = 70;
  function seedProbe(nameLength: number, notYetAttributed = false) {
    const ids = Array.from({ length: 25 }, (_, i) => 1000 + i);
    const extra = notYetAttributed ? [2002] : [];
    seedRuns(
      notYetAttributed
        ? [salesRun("SUCCEEDED", 30), salesRun("SUCCEEDED", 200, null, "full")]
        : [salesRun("SUCCEEDED", 30)],
    );
    if (notYetAttributed) {
      seedListings({
        stores: { [COMPANIES[0]]: ["s0"] },
        links: [{ productId: 2002, store: "s0", createdAt: new Date(Date.now() - 3_600_000) }],
      });
    }
    db.company.findMany.mockResolvedValue(COMPANIES.map((id) => ({ id, name: "C".repeat(191) })));
    seedFacts({
      approvedActiveIds: ids,
      facts: [
        { productId: 1, companyId: COMPANIES[0], dayKey: "2020-01-01", orderedQty: 1, orderCount: 1 },
        ...ids.map((id) => ({
          productId: id,
          companyId: COMPANIES[0],
          dayKey: daysBack(1),
          orderedQty: 99_999,
          orderCount: 9_999,
        })),
      ],
    });
    db.product.findMany.mockResolvedValue([1, ...ids, ...extra].map((id) => ({ id })));
    mockReport.mockResolvedValue(
      reportOf([...ids, ...extra].map((id) => ({ ...unsized(id, 0), productName: "N".repeat(nameLength) }))),
    );
  }

  /** One turn through the adapter with `remaining` bytes left. */
  async function viaAdapter(remaining: number): Promise<any> {
    const set = createAiTools(ADAPTER_CTX, { remaining }, jest.fn().mockResolvedValue(undefined) as never);
    return (set.reorder_report as unknown as { execute: (args: unknown) => Promise<unknown> }).execute(ARGS);
  }

  it("codex's probe at a 12,000 B budget: ok, within budget, with rows — never discarded whole", async () => {
    seedProbe(UNDER_RESERVE_NAMES);
    const result = await viaAdapter(12_000);
    expect({ status: result.status, bytes: result.meta.bytes }).toEqual({
      status: "ok",
      bytes: expect.any(Number),
    });
    expect(result.meta.bytes).toBeLessThanOrEqual(12_000);
    expect(result.data.returned).toBeGreaterThanOrEqual(1);
    // Non-vacuity: this IS the under-reserve case, where the old floor applied.
    expect(measuredEnvelopeOf(result.data)).toBeLessThan(ENVELOPE_RESERVE_BYTES);
    expect(12_000 - ENVELOPE_RESERVE_BYTES).toBeLessThan(MIN_RANK_PAGE_BYTES);
    expect(result.data.coverage.orderSignalCompanyCoverageNote).toBe(SALES_COMPANY_COVERAGE_MEASURED_NOTE);
    expect(result.data.coverage.salesFreshnessNote).toContain("more than a day ago");
  });

  it.each([
    ["just under the reserve (70-character names)", UNDER_RESERVE_NAMES, "under", false],
    ["over the reserve (255-character names)", 255, "over", false],
    // A2 FR3 (pack C16): the just-under probe plus a not-yet-attributed product — its code's
    // sentence takes the envelope over the reserve.
    ["over the reserve with a not-yet-attributed product (70-character names)", UNDER_RESERVE_NAMES, "over", true],
  ])("a 250 B budget sweep with the envelope %s: every result ok and within budget, and the page shrinks", async (_label, nameLength, side, notYetAttributed) => {
    seedProbe(nameLength, notYetAttributed);
    const full = await viaAdapter(65_536);
    expect(full.status).toBe("ok");
    if (notYetAttributed) {
      // Non-vacuity: the C16 code and its sentence really ride in this sweep's envelope.
      expect(full.data.rows.find((r: any) => r.productId === 2002)).toMatchObject({ orderSignalReason: "not_yet_attributed" });
      expect(full.data.coverage.orderSignalReasons).toHaveProperty("not_yet_attributed");
    }
    const measured = measuredEnvelopeOf(full.data);
    expect(side === "under" ? measured < ENVELOPE_RESERVE_BYTES : measured > ENVELOPE_RESERVE_BYTES).toBe(true);
    // The smallest budget at which the envelope plus one row fits: the one-row page's own size.
    const first = full.data.rows[0];
    const start = bytesOf({
      ...full.data,
      rows: [first],
      returned: 1,
      nextOffset: 1,
      remainingRows: full.data.totalRows - 1,
    });
    const points: Array<{ budget: number; status: string; bytes: number; rows: number }> = [];
    for (let budget = start; budget <= 16_384; budget += 250) {
      const result = await viaAdapter(budget);
      points.push({ budget, status: result.status, bytes: result.meta.bytes, rows: result.data?.returned ?? 0 });
      if (result.status === "ok") {
        // The measured envelope never under-counts what ships around the rows.
        expect(envelopeBytesOf(result.data)).toBeLessThanOrEqual(measured);
        expect(result.meta.bytes).toBe(bytesOf(result.data));
      }
    }
    // The sweep crosses the point where the reserve rule's 4 KiB floor stops binding.
    expect(points[0].budget).toBeLessThan(ENVELOPE_RESERVE_BYTES + MIN_RANK_PAGE_BYTES);
    expect(points[points.length - 1].budget).toBeGreaterThan(ENVELOPE_RESERVE_BYTES + MIN_RANK_PAGE_BYTES);
    // Every result is a page that fits — never the adapter's truncation notice.
    expect(points.filter((p) => p.status !== "ok" || p.bytes > p.budget || p.rows < 1)).toEqual([]);
    // The page shrinks (never a vacuous all-one-row sweep), and more room never returns fewer rows.
    const rows = points.map((p) => p.rows);
    expect(rows[0]).toBe(1);
    expect(Math.max(...rows)).toBeGreaterThan(1);
    expect(rows.every((n, i) => i === 0 || n >= rows[i - 1])).toBe(true);
  });
});
