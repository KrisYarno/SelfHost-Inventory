/**
 * @jest-environment node
 *
 * assistant toolsuite breadth — W3-A: the composite core (lib/assistant/composites.ts,
 * spec §5 T-360 get_product_overview + T-SNAP get_business_snapshot).
 *
 * Pins the composition contract:
 *  - Server-side composition calls the MODULE functions directly (never tool defs).
 *  - EVERY section degrades INDEPENDENTLY: a thrown/thin section becomes
 *    status:"unavailable" + a reason, and NEVER breaks the sibling sections.
 *  - Each section carries its OWN scope ("global"|"company"); sales/order sections are
 *    company-scoped via ctx.companyIds regardless of the outer "mixed" tool label.
 *  - Sections are SUMMARIES (scalar KPIs, <=3 location rows, totals-only movement).
 *  - A pending-review / soft-deleted / absent productId resolves to { found: false }
 *    (the tool maps that to notFound).
 */

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    // quality+reach Task 3.1: the snapshot's sales section reads the approved-ACTIVE id
    // set (its C13 policy row) before summing facts, so `product.findMany` is now part of
    // this composite's read graph.
    product: { findUnique: jest.fn(), findMany: jest.fn(async () => []) },
    product_locations: { findMany: jest.fn() },
    location: { findMany: jest.fn() },
    // A2 C6 / C10: the REAL valuation and movement modules are swapped in by the pins that
    // need them (the latest-receipt read and the ledger read); benign defaults otherwise.
    inventory_logs: { aggregate: jest.fn(), groupBy: jest.fn(async () => []), findMany: jest.fn(async () => []) },
    productSalesFact: { aggregate: jest.fn() },
  },
}));
jest.mock("@/lib/assistant/resolve-product", () => ({ __esModule: true, resolveAssistantProduct: jest.fn() }));
jest.mock("@/lib/analytics/valuation", () => ({ __esModule: true, getValuation: jest.fn() }));
jest.mock("@/lib/reports/policy", () => ({ __esModule: true, getPolicy: jest.fn() }));
jest.mock("@/lib/reports/movement", () => ({ __esModule: true, getMovementSeries: jest.fn() }));
jest.mock("@/lib/reports/inventory-summary", () => ({ __esModule: true, getInventorySummary: jest.fn() }));
// The report is stubbed; its note constants (A2 C5's costedNote) are the real ones.
jest.mock("@/lib/reports/reorder", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/reports/reorder"),
  getReorderReport: jest.fn(),
}));
jest.mock("@/lib/assistant/freshness", () => ({ __esModule: true, getFreshness: jest.fn() }));
jest.mock("@/lib/reports/order-pipeline", () => ({ __esModule: true, getOrderPipeline: jest.fn() }));
// A2 C7: the sales run history is injected (salesRebuildState); the note's wording rule
// (salesFreshnessNote) is the REAL one, so these pins read the strings the tool ships.
jest.mock("@/lib/assistant/sales-coverage", () => ({
  __esModule: true,
  callerScopedSalesCoverage: jest.fn(),
  salesRebuildState: jest.fn(),
  salesFreshnessNote: jest.requireActual("@/lib/assistant/sales-coverage").salesFreshnessNote,
}));
jest.mock("@/lib/stock-threshold", () => ({
  __esModule: true,
  getLowStockDefault: jest.fn(async () => 10),
  effectiveLowStockThreshold: (raw: number | null | undefined, def: number) => (raw == null ? def : raw),
  isLowStock: (qty: number, thr: number) => thr > 0 && qty > 0 && qty <= thr,
}));

import prisma from "@/lib/prisma";
import { resolveAssistantProduct } from "@/lib/assistant/resolve-product";
import { getValuation } from "@/lib/analytics/valuation";
import { getPolicy } from "@/lib/reports/policy";
import { getMovementSeries } from "@/lib/reports/movement";
import { getInventorySummary } from "@/lib/reports/inventory-summary";
import { getReorderReport } from "@/lib/reports/reorder";
import { getFreshness } from "@/lib/assistant/freshness";
import { getOrderPipeline } from "@/lib/reports/order-pipeline";
import { callerScopedSalesCoverage, salesRebuildState } from "@/lib/assistant/sales-coverage";
import { getProductOverview, getBusinessSnapshot } from "@/lib/assistant/composites";
import { PHYSICAL_OUTBOUND_DEFINITION } from "@/lib/reports/metrics-contract";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;
const mResolve = resolveAssistantProduct as jest.Mock;
const mVal = getValuation as jest.Mock;
const mPolicy = getPolicy as jest.Mock;
const mMove = getMovementSeries as jest.Mock;
const mSummary = getInventorySummary as jest.Mock;
const mReorder = getReorderReport as jest.Mock;
const mFresh = getFreshness as jest.Mock;
const mPipeline = getOrderPipeline as jest.Mock;
const mCoverage = callerScopedSalesCoverage as jest.Mock;
const mRebuildRuns = salesRebuildState as jest.Mock;

const NOW = new Date("2026-07-14T00:00:00.000Z");
const DAY_MS = 86_400_000;
const CTX = { companyIds: ["c1"], byteBudget: 65_536 };
const HOUR_MS = 3_600_000;
/** A2 C7: a success `hours` before NOW (ISO UTC), as salesRebuildState reports it. */
const succeededHoursAgo = (hours: number, failedSince = false) => ({
  lastSucceededAt: new Date(NOW.getTime() - hours * HOUR_MS).toISOString(),
  latestAttemptFailedAfterSuccess: failedSince,
});

/** Wire every collaborator to a benign happy-path default; individual tests override. */
function seedHappy() {
  mResolve.mockResolvedValue({ id: 1, name: "TIRZ 30" });
  db.product.findUnique.mockResolvedValue({
    name: "TIRZ 30",
    baseName: "TIRZ",
    variant: "30",
    lowStockThreshold: null,
    product_locations: [{ quantity: 12 }, { quantity: 3 }],
  });
  db.product_locations.findMany.mockResolvedValue([
    { locationId: 1, quantity: 12 },
    { locationId: 2, quantity: 3 },
  ]);
  db.location.findMany.mockResolvedValue([
    { id: 1, name: "Main" },
    { id: 2, name: "Annex" },
  ]);
  db.inventory_logs.aggregate.mockResolvedValue({
    _sum: { delta: -60 },
    _min: { changeTime: new Date(NOW.getTime() - 20 * DAY_MS) },
  });
  db.productSalesFact.aggregate.mockResolvedValue({ _sum: { orderedQty: 40, revenue: "1234.50" } });
  mVal.mockResolvedValue({
    groupBy: "product",
    rows: [{ productId: 1, name: "TIRZ 30", units: 15, atCurrentCostCents: 3000, atReceiptCostCents: 2900, atRetailCents: 6000, marginCents: 3000 }],
    coverage: { costedProducts: 1, ofProducts: 1, costedUnits: 15, ofUnits: 15, retailPricedProducts: 1, retailPricedUnits: 15, receiptCostedProducts: 1, receiptCostedUnits: 15, marginProducts: 1, marginUnits: 15 },
  });
  mPolicy.mockResolvedValue({
    global: { lowStockDefault: 10, reorder: { defaultLeadTimeDays: 7 }, minEvidenceEvents: 3 },
    product: { productId: 1, name: "TIRZ 30", lowStockThreshold: { effective: 10, raw: null, source: "system_default" } },
  });
  mMove.mockResolvedValue({
    grain: "day",
    window: { from: "2026-06-15", to: "2026-07-14", days: 30, source: "relative" },
    points: [{ key: "2026-07-01", sale: -5, net: -5 }],
    totals: { stockIn: 20, sale: -60, net: -40 },
    coverage: { unclassifiedLegacyNote: "legacy note", reasonCodeNullRows: 2 },
  });
  mCoverage.mockResolvedValue({ unattributedOrders: 4, bundleRevenue: "excluded", lastRebuildAt: "2026-07-14T00:00:00.000Z" });
  // A2 C7: a 2-hour-old success — fresh, so no note unless a test makes it stale.
  mRebuildRuns.mockResolvedValue(succeededHoursAgo(2));
  // Snapshot collaborators
  mSummary.mockResolvedValue({
    unitsOnHand: 500,
    productCount: 80,
    stockStateCounts: { in_stock: 60, low: 12, out: 8 },
    valuation: { groupBy: "total", rows: [{ units: 500, atCurrentCostCents: 100000, atReceiptCostCents: null, atRetailCents: 200000, marginCents: null }], coverage: { costedProducts: 60, ofProducts: 80, costedUnits: 400, ofUnits: 500, retailPricedProducts: 70, retailPricedUnits: 480, receiptCostedProducts: 0, receiptCostedUnits: 0, marginProducts: 0, marginUnits: 0 } },
  });
  mReorder.mockResolvedValue({
    rows: [],
    inventoryPositionKnown: false,
    assumptions: { windowDays: 90, bufferDaysDefault: 7, targetCoverageMultiple: 2, demandDefinition: "demand def" },
    coverage: { total: 80, suggested: 5, unavailable: 20, costed: 3 },
  });
  mFresh.mockResolvedValue({
    rebuild: {
      lastRunAt: "2026-07-14T00:00:00.000Z",
      lastSucceededAt: "2026-07-13T00:05:00.000Z",
      sourceWatermark: "2026-07-13T00:00:00.000Z",
    },
    sales: { unattributedOrders: 4, scope: "caller-companies" },
    fulfillmentSync: { enabled: null, reason: "not observable from this process", cursor: "2026-07-10T00:00:00.000Z", backfill: "complete" },
    dataStarts: {},
    snapshots: { flaggedPairs: 0, scope: "global" },
    notTracked: ["a", "b"],
  });
  mPipeline.mockResolvedValue({
    window: { from: "2026-06-15", to: "2026-07-14", days: 30, source: "relative" },
    groupBy: "status",
    orders: [{ key: "pending", currency: "USD", orderCount: 3, totalCents: 15000 }],
    items: [{ key: "pending", currency: "USD", units: 9, unmappedItems: 0 }],
    aging: { days0to7: 1, days8to30: 2, days31plus: 0 },
    coverage: { timestampFallbacks: 0, refundsNote: "refunds are not netted", currencies: ["USD"], finalStatuses: ["fulfilled", "cancelled"] },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  seedHappy();
});

describe("getProductOverview — composition (spec §5 T-360)", () => {
  it("assembles every section with its own scope; sales30 is company-scoped", async () => {
    const r = await getProductOverview(1, CTX, NOW);
    expect(r.found).toBe(true);
    if (!r.found) return;

    // identity: resolveAssistantProduct data + stockState rule (12+3 = 15 on hand, in_stock).
    expect(r.identity.status).toBe("ok");
    expect(r.identity.scope).toBe("global");
    expect(r.identity.name).toBe("TIRZ 30");
    expect(r.identity.currentStock).toBe(15);
    expect(r.identity.stockState).toBe("in_stock");

    // velocity: contract rate (60 units / 20 days-covered = 3/day) + the shared definition.
    expect(r.velocity.status).toBe("ok");
    expect(r.velocity.avgDailyOutbound).toBeCloseTo(3);
    expect(r.velocity.usageKnown).toBe(true);
    expect(r.velocity.velocityDefinition).toBe(PHYSICAL_OUTBOUND_DEFINITION);

    // valuation: the product's own row + coverage, relayed verbatim from getValuation.
    expect(r.valuation.status).toBe("ok");
    expect((r.valuation.row as { units: number }).units).toBe(15);
    expect((r.valuation.coverage as { ofUnits: number }).ofUnits).toBe(15);

    // movement30: totals ONLY (a summary — never the full points list).
    expect(r.movement30.status).toBe("ok");
    expect((r.movement30.totals as { net: number }).net).toBe(-40);
    expect(r.movement30.points).toBeUndefined();
    // G2-3: the composite passes the approved id set like every other historical read —
    // the SQL boundary no longer relies on the caller having resolved the product first.
    expect(mMove.mock.calls[0][0]).toMatchObject({
      productId: 1,
      approvedIds: expect.any(Array),
    });

    // sales30 is COMPANY-scoped and reads ProductSalesFact + caller-scoped coverage.
    expect(r.sales30.scope).toBe("company");
    expect(r.sales30.orderedUnits).toBe(40);
    expect((r.sales30.coverage as { unattributedOrders: number }).unattributedOrders).toBe(4);

    // policy present; the top-level coverage lists every section's scope, none degraded.
    expect(r.policy.status).toBe("ok");
    expect(r.coverage.sectionScopes.sales30).toBe("company");
    expect(r.coverage.sectionScopes.velocity).toBe("global");
    expect(r.coverage.degradedSections).toEqual([]);
  });

  // A2 pack C6 (seam S10): the overview's valuation row is getValuation's PRODUCT row, so it
  // carries the stored unit prices — pinned through the REAL module, on the review #4 shape:
  // a product with nothing on hand, whose money totals are 0 and whose prices are not.
  it("valuation.row carries currentUnitCostCents / unitRetailCents from the REAL valuation module", async () => {
    const real = jest.requireActual("@/lib/analytics/valuation") as {
      getValuation: (opts: { productId?: number; groupBy?: string }) => Promise<unknown>;
    };
    mVal.mockImplementation(real.getValuation);
    db.product.findMany.mockResolvedValue([
      {
        id: 1,
        name: "TIRZ 30",
        costPrice: 0,
        retailPrice: 89.5,
        product_locations: [{ locationId: 1, quantity: 0, locations: { name: "Main" } }],
      },
    ]);
    const r = await getProductOverview(1, CTX, NOW);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.valuation.status).toBe("ok");
    expect(mVal).toHaveBeenCalledWith({ productId: 1, groupBy: "product" });
    expect(r.valuation.row).toEqual({
      productId: 1,
      name: "TIRZ 30",
      units: 0,
      atCurrentCostCents: null, // a stored cost of 0 adds no cost total (today's rule)
      atReceiptCostCents: null,
      atRetailCents: 0,
      marginCents: null,
      currentUnitCostCents: 0, // recorded as free
      unitRetailCents: 8950,
    });
  });

  // A2 pack C10 (seam S11): movement30 relays the module's coverage, whose unclassified-
  // outbound note is now OPTIONAL — present only when a reason-less outbound row is in the
  // 30 days. Pinned through the REAL movement module both ways.
  describe("movement30 relays the optional unclassified-outbound note (REAL movement module)", () => {
    const NOTE =
      "Outbound adjustments without a reason code (deductions recorded against an order, or " +
      "with no reason given) are counted as unclassified outbound here — not as sales and not " +
      "as loss in these figures.";
    const useRealMovement = () => {
      const real = jest.requireActual("@/lib/reports/movement") as {
        getMovementSeries: (opts: unknown) => Promise<unknown>;
      };
      mMove.mockImplementation(real.getMovementSeries);
    };
    const at = new Date(NOW.getTime() - 3 * DAY_MS);

    it("a reason-less outbound adjustment in the window: the note rides, with its count", async () => {
      useRealMovement();
      db.inventory_logs.findMany.mockResolvedValue([
        { delta: -4, changeTime: at, logType: "ADJUSTMENT", reasonCode: null },
        { delta: -1, changeTime: at, logType: "SALE", reasonCode: null },
      ]);
      const r = await getProductOverview(1, CTX, NOW);
      expect(r.found).toBe(true);
      if (!r.found) return;
      expect(r.movement30.status).toBe("ok");
      const coverage = r.movement30.coverage as Record<string, unknown>;
      expect(coverage.reasonCodeNullRows).toBe(1);
      expect(coverage.unclassifiedLegacyNote).toBe(NOTE);
    });

    it("none in the window: no note key at all", async () => {
      useRealMovement();
      db.inventory_logs.findMany.mockResolvedValue([
        { delta: -3, changeTime: at, logType: "ADJUSTMENT", reasonCode: "DAMAGE" },
      ]);
      const r = await getProductOverview(1, CTX, NOW);
      expect(r.found).toBe(true);
      if (!r.found) return;
      const coverage = r.movement30.coverage as Record<string, unknown>;
      expect(coverage.reasonCodeNullRows).toBe(0);
      expect(coverage).not.toHaveProperty("unclassifiedLegacyNote");
    });
  });

  it("out-of-stock product reads stockState 'out' (0 wins over low)", async () => {
    db.product.findUnique.mockResolvedValue({ name: "X", baseName: null, variant: null, lowStockThreshold: 5, product_locations: [{ quantity: 0 }] });
    const r = await getProductOverview(1, CTX, NOW);
    expect(r.found && r.identity.currentStock).toBe(0);
    expect(r.found && r.identity.stockState).toBe("out");
  });

  it("no outbound signal => avgDailyOutbound null (never a fabricated 0/day), definition still relayed", async () => {
    db.inventory_logs.aggregate.mockResolvedValue({ _sum: { delta: null }, _min: { changeTime: null } });
    const r = await getProductOverview(1, CTX, NOW);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.velocity.avgDailyOutbound).toBeNull();
    expect(r.velocity.usageKnown).toBe(false);
    expect(r.velocity.velocityDefinition).toBe(PHYSICAL_OUTBOUND_DEFINITION);
  });

  it("stockByLocation caps at 3 rows and notes when more locations exist", async () => {
    db.product_locations.findMany.mockResolvedValue([
      { locationId: 1, quantity: 10 },
      { locationId: 2, quantity: 8 },
      { locationId: 3, quantity: 6 },
      { locationId: 4, quantity: 4 },
    ]);
    db.location.findMany.mockResolvedValue([
      { id: 1, name: "A" }, { id: 2, name: "B" }, { id: 3, name: "C" }, { id: 4, name: "D" },
    ]);
    const r = await getProductOverview(1, CTX, NOW);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect((r.stockByLocation.locations as unknown[]).length).toBe(3);
    expect(r.stockByLocation.totalLocations).toBe(4);
    expect(typeof r.stockByLocation.note).toBe("string");
  });

  it("policy section caps locationMinimums at 3 rows + a note when more exist (item 3)", async () => {
    // A product with FIVE per-location minimums — the overview is a SUMMARY, so the policy
    // section relays only the top MAX_LOCATION_ROWS and notes the rest (mirrors
    // stockByLocation); the full list stays behind get_inventory_policy.
    mPolicy.mockResolvedValue({
      global: { lowStockDefault: 10, reorder: { defaultLeadTimeDays: 7 }, minEvidenceEvents: 3 },
      product: {
        productId: 1,
        name: "TIRZ 30",
        lowStockThreshold: { effective: 10, raw: null, source: "system_default" },
        locationMinimums: [
          { locationId: 1, minQuantity: 5, locationName: "Main" },
          { locationId: 2, minQuantity: 4, locationName: "Annex" },
          { locationId: 3, minQuantity: 3, locationName: "Back room" },
          { locationId: 4, minQuantity: 2, locationName: "Van" },
          { locationId: 5, minQuantity: 1, locationName: null },
        ],
      },
    });
    const r = await getProductOverview(1, CTX, NOW);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.policy.status).toBe("ok");
    const product = r.policy.product as { locationMinimums: unknown[] };
    expect(product.locationMinimums.length).toBe(3);
    // A2 C8: the relayed minimums keep their location names.
    expect(product.locationMinimums).toEqual([
      { locationId: 1, minQuantity: 5, locationName: "Main" },
      { locationId: 2, minQuantity: 4, locationName: "Annex" },
      { locationId: 3, minQuantity: 3, locationName: "Back room" },
    ]);
    // The note discloses the TRUE total so the cap is never silent.
    expect(typeof r.policy.note).toBe("string");
    expect(r.policy.note as string).toContain("5");
  });

  it("policy section leaves locationMinimums untouched (no note) when <= 3 exist", async () => {
    mPolicy.mockResolvedValue({
      global: { lowStockDefault: 10, reorder: { defaultLeadTimeDays: 7 }, minEvidenceEvents: 3 },
      product: {
        productId: 1,
        name: "TIRZ 30",
        lowStockThreshold: { effective: 10, raw: null, source: "system_default" },
        locationMinimums: [
          { locationId: 1, minQuantity: 5 },
          { locationId: 2, minQuantity: 4 },
        ],
      },
    });
    const r = await getProductOverview(1, CTX, NOW);
    expect(r.found).toBe(true);
    if (!r.found) return;
    const product = r.policy.product as { locationMinimums: unknown[] };
    expect(product.locationMinimums.length).toBe(2);
    expect(r.policy.note).toBeUndefined();
  });

  it("ONE failing section degrades independently — the rest still resolve", async () => {
    mVal.mockRejectedValue(new Error("valuation exploded at db.example-host:5432/secret_schema"));
    const r = await getProductOverview(1, CTX, NOW);
    expect(r.found).toBe(true);
    if (!r.found) return;
    // The failing section is unavailable + carries a FIXED reason; NO throw.
    expect(r.valuation.status).toBe("unavailable");
    // W3 seam-fix item 2: the reason is the fixed string, NOT err.message — a Prisma error
    // can embed connection hosts / schema names, so nothing from the message leaks.
    expect(r.valuation.reason).toBe("section unavailable");
    expect(r.valuation.reason).not.toMatch(/example-host|secret_schema|exploded/);
    // Only the constructor NAME is surfaced (enough to tell error kinds apart).
    expect(r.valuation.errorKind).toBe("Error");
    // Siblings are unaffected.
    expect(r.identity.status).toBe("ok");
    expect(r.movement30.status).toBe("ok");
    expect(r.coverage.degradedSections).toContain("valuation");
  });

  it("empty companyIds: sales30 still resolves (0 units) and stays company-scoped, no throw", async () => {
    mCoverage.mockResolvedValue({ unattributedOrders: 0, bundleRevenue: "excluded", lastRebuildAt: null });
    const r = await getProductOverview(1, { companyIds: [], byteBudget: 65_536 }, NOW);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.sales30.scope).toBe("company");
    expect(r.sales30.orderedUnits).toBe(0);
    // ProductSalesFact is never queried for an empty scope.
    expect(db.productSalesFact.aggregate).not.toHaveBeenCalled();
  });

  it("a pending-review / absent productId resolves to { found: false } (tool maps to notFound)", async () => {
    mResolve.mockResolvedValue(null);
    const r = await getProductOverview(999999, CTX, NOW);
    expect(r).toEqual({ found: false, productId: 999999 });
    // No section work happens once resolution fails.
    expect(mVal).not.toHaveBeenCalled();
  });
});

describe("getBusinessSnapshot — composition (spec §5 T-SNAP)", () => {
  it("assembles KPIs + reorder-now + sales + pipeline + freshness with per-section scope", async () => {
    const s = await getBusinessSnapshot(CTX, NOW);

    // inventory KPIs (global): units, stock-state census, valuation totals + coverage.
    expect(s.inventory.scope).toBe("global");
    expect(s.inventory.unitsOnHand).toBe(500);
    expect((s.inventory.stockStateCounts as { out: number }).out).toBe(8);

    // reorder-now count from the worklist coverage (global).
    expect(s.reorderNow.reorderNowCount).toBe(5);

    // sales 7/30d totals (company-scoped).
    expect(s.sales.scope).toBe("company");
    expect((s.sales.last30d as { orderedUnits: number }).orderedUnits).toBe(40);

    // order pipeline summary by status (company-scoped).
    expect(s.orderPipeline.scope).toBe("company");
    expect((s.orderPipeline.byStatus as unknown[]).length).toBe(1);

    // freshness one-liner (global): lastRunAt + the fulfillment note.
    expect(s.freshness.scope).toBe("global");
    expect(s.freshness.lastRunAt).toBe("2026-07-14T00:00:00.000Z");
    // A2 C7: the last SUCCESSFUL rebuild's finish rides beside the last attempt's.
    expect(s.freshness.lastSucceededAt).toBe("2026-07-13T00:05:00.000Z");
    expect(Object.keys(s.freshness).slice(0, 5)).toEqual([
      "scope",
      "status",
      "lastRunAt",
      "lastSucceededAt",
      "sourceWatermark",
    ]);
    expect(typeof s.freshness.fulfillmentSyncNote).toBe("string");

    expect(s.coverage.sectionScopes.sales).toBe("company");
    expect(s.coverage.degradedSections).toEqual([]);
  });

  // A2 pack C5 (A2-G2S-20): the snapshot relays reorder coverage too, so the same costed
  // label rides beside it — on a fixture where total (80), suggested (5) and costed (3)
  // all differ, the one shape in which "3 costed" can be misread as 3 of 80.
  it("reorderNow.coverage carries costedNote beside costed (total, suggested and costed all differ)", async () => {
    const s = await getBusinessSnapshot(CTX, NOW);
    const coverage = s.reorderNow.coverage as Record<string, unknown>;
    expect(coverage).toEqual({
      total: 80,
      suggested: 5,
      unavailable: 20,
      costed: 3,
      costedNote:
        "costed counts the suggested rows that have a cost price, out of the suggested rows " +
        "(coverage.suggested) — not out of the whole catalog (coverage.total). Every product's " +
        "unit cost is on the valuation tool's product rows.",
    });
    expect(s.reorderNow.reorderNowCount).toBe(5);
  });

  it("sales 7d + 30d are TWO separate windows (7d aggregate distinct from 30d)", async () => {
    db.productSalesFact.aggregate
      .mockResolvedValueOnce({ _sum: { orderedQty: 9, revenue: "100.00" } }) // 7d
      .mockResolvedValueOnce({ _sum: { orderedQty: 40, revenue: "500.00" } }); // 30d
    const s = await getBusinessSnapshot(CTX, NOW);
    expect((s.sales.last7d as { orderedUnits: number }).orderedUnits).toBe(9);
    expect((s.sales.last30d as { orderedUnits: number }).orderedUnits).toBe(40);
  });

  it("ONE failing section (pipeline) degrades independently; the rest resolve", async () => {
    mPipeline.mockRejectedValue(new Error("pipeline down at db.internal-host:5432"));
    const s = await getBusinessSnapshot(CTX, NOW);
    expect(s.orderPipeline.status).toBe("unavailable");
    // W3 seam-fix item 2: fixed reason + constructor-name only, never the message.
    expect(s.orderPipeline.reason).toBe("section unavailable");
    expect(s.orderPipeline.reason).not.toMatch(/internal-host|pipeline down/);
    expect(s.orderPipeline.errorKind).toBe("Error");
    expect(s.inventory.status).toBe("ok");
    expect(s.coverage.degradedSections).toContain("orderPipeline");
  });

  it("empty companyIds: sales + pipeline resolve without querying facts, stay company-scoped", async () => {
    mCoverage.mockResolvedValue({ unattributedOrders: 0, bundleRevenue: "excluded", lastRebuildAt: null });
    mPipeline.mockResolvedValue({
      window: { from: "2026-06-15", to: "2026-07-14", days: 30, source: "relative" },
      groupBy: "status", orders: [], items: [], aging: { days0to7: 0, days8to30: 0, days31plus: 0 },
      coverage: { timestampFallbacks: 0, refundsNote: "refunds are not netted", currencies: [], finalStatuses: ["fulfilled", "cancelled"] },
    });
    const s = await getBusinessSnapshot({ companyIds: [], byteBudget: 65_536 }, NOW);
    expect(s.sales.scope).toBe("company");
    expect((s.sales.last30d as { orderedUnits: number }).orderedUnits).toBe(0);
    expect(db.productSalesFact.aggregate).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// A2 pack C7 — the sales sections carry the freshness note on MATERIAL staleness only;
// never for a caller with no companies; and a failed run-history read is NON-FATAL (no
// note, the section intact — never `unavailable`).
// ===========================================================================

describe("A2 C7 — coverage.salesFreshnessNote on the composites' sales sections", () => {
  const STALE_30H = `The last successful sales rebuild finished at ${new Date(NOW.getTime() - 30 * HOUR_MS).toISOString()}, more than a day ago; orders recorded after that are not counted yet.`;

  it("get_product_overview.sales30: a 30-hour-old success -> the note; 20 hours -> none", async () => {
    mRebuildRuns.mockResolvedValue(succeededHoursAgo(30));
    const stale = await getProductOverview(1, CTX, NOW);
    if (!stale.found) throw new Error("not found");
    expect(stale.sales30.status).toBe("ok");
    expect((stale.sales30.coverage as Record<string, unknown>).salesFreshnessNote).toBe(STALE_30H);
    // The caller-scoped coverage it joins is intact.
    expect((stale.sales30.coverage as Record<string, unknown>).unattributedOrders).toBe(4);

    mRebuildRuns.mockResolvedValue(succeededHoursAgo(20));
    const fresh = await getProductOverview(1, CTX, NOW);
    if (!fresh.found) throw new Error("not found");
    expect(fresh.sales30.coverage as Record<string, unknown>).not.toHaveProperty("salesFreshnessNote");
  });

  it("get_business_snapshot.sales: a FAILED attempt after a recent success -> 'did not succeed'", async () => {
    mRebuildRuns.mockResolvedValue(succeededHoursAgo(20, true));
    const s = await getBusinessSnapshot(CTX, NOW);
    expect(s.sales.status).toBe("ok");
    // A2 C15 (A2-CR-4): no "as of" claim — a failed attempt can leave some days rebuilt.
    expect((s.sales.coverage as Record<string, unknown>).salesFreshnessNote).toBe(
      `The latest sales rebuild attempt did not succeed; the last successful rebuild finished at ` +
        `${new Date(NOW.getTime() - 20 * HOUR_MS).toISOString()}, and orders recorded since then may ` +
        `be missing or only partly counted.`,
    );
    // The disclosure triple it joins is intact.
    expect((s.sales.coverage as Record<string, unknown>).archivedProductsIncluded).toBe(0);
  });

  it("no companies: no note and NO run-history read, on both composites", async () => {
    mRebuildRuns.mockResolvedValue(succeededHoursAgo(30));
    mCoverage.mockResolvedValue({ unattributedOrders: 0, bundleRevenue: "excluded", lastRebuildAt: null });
    const noCompanies = { companyIds: [], byteBudget: 65_536 };
    const r = await getProductOverview(1, noCompanies, NOW);
    if (!r.found) throw new Error("not found");
    const s = await getBusinessSnapshot(noCompanies, NOW);
    expect(r.sales30.coverage as Record<string, unknown>).not.toHaveProperty("salesFreshnessNote");
    expect(s.sales.coverage as Record<string, unknown>).not.toHaveProperty("salesFreshnessNote");
    expect(mRebuildRuns).not.toHaveBeenCalled();
  });

  it("a throwing run-history read: no note, and each sales section stays OK with its figures", async () => {
    mRebuildRuns.mockRejectedValue(new Error("analytics_rebuild_runs unreachable at db.internal-host"));
    const r = await getProductOverview(1, CTX, NOW);
    if (!r.found) throw new Error("not found");
    expect(r.sales30.status).toBe("ok");
    expect(r.sales30.orderedUnits).toBe(40);
    expect(r.sales30.coverage as Record<string, unknown>).not.toHaveProperty("salesFreshnessNote");
    expect(r.coverage.degradedSections).toEqual([]);

    const s = await getBusinessSnapshot(CTX, NOW);
    expect(s.sales.status).toBe("ok");
    expect((s.sales.last30d as { orderedUnits: number }).orderedUnits).toBe(40);
    expect(s.sales.coverage as Record<string, unknown>).not.toHaveProperty("salesFreshnessNote");
    expect(s.coverage.degradedSections).toEqual([]);
  });
});
