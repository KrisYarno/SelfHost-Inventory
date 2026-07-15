import prisma from "@/lib/prisma";
import { inventory_logs_logType } from "@prisma/client";
import { toDayKey } from "@/lib/analytics/dates";
import { centsFromCostPrice } from "@/lib/inventory";
import { effectiveLowStockThreshold, getLowStockDefault, isLowStock } from "@/lib/stock-threshold";
import {
  PHYSICAL_OUTBOUND_WHERE,
  daysCovered,
  PHYSICAL_OUTBOUND_DEFINITION,
} from "@/lib/reports/metrics-contract";

export type SalesGroupBy = "product" | "day" | "integration" | "company";

/** Company-scoped sales read. ALWAYS constrains companyId IN companyIds; empty companyIds -> [] (hard isolation). */
export async function getSales(opts: { companyIds: string[]; productId?: number; from?: string; to?: string; groupBy?: SalesGroupBy }) {
  if (opts.companyIds.length === 0) return [];
  const where: any = { companyId: { in: opts.companyIds } };
  if (opts.productId) where.productId = opts.productId;
  if (opts.from || opts.to) where.dayKey = { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) };
  const BY: Record<SalesGroupBy, string[]> = {
    product: ["productId"], day: ["dayKey"], integration: ["integrationId"], company: ["companyId", "dayKey"],
  };
  const groupBy = opts.groupBy ?? "product";
  const by = BY[groupBy] ?? BY.product;
  // orderCount per fact row = distinct orders for ONE (product,company,integration,day) grain.
  // Summing it across PRODUCTS (day/integration/company) double-counts a multi-product order,
  // and the correct value can't be recomputed from the fact (no distinct order IDs). So only
  // sum orderCount when grouping BY product (where every summed row shares the same product =
  // "orders containing this product"); OMIT it otherwise so we never emit a wrong number.
  // Lane 6 (review B5 / D-W5): fulfilledQty is DROPPED from every sales payload.
  // Nothing writes ExternalOrderItem.fulfilledQty on this deployment (the business
  // fulfills in WooCommerce), so summing it emitted a confident 0 that a model read
  // as "fulfillment sync is broken". Ordered units + revenue are authoritative; the
  // fact column may persist until a later cleanup cycle but is never surfaced.
  const _sum: { orderedQty: true; revenue: true; orderCount?: true } = {
    orderedQty: true, revenue: true,
  };
  if (groupBy === "product") _sum.orderCount = true;
  return prisma.productSalesFact.groupBy({
    by: by as any,
    where,
    _sum,
  });
}

/** GLOBAL stock-level series from snapshots (no company scoping — inventory is GLOBAL).
 *  `take` (Lane 4, codex #4) caps the rows at the DB — the assistant/MCP tool layer
 *  passes a bound so a wide window never returns an unbounded result set. Omitted =
 *  unbounded (the existing analytics routes keep their current behavior). */
export async function getStockSeries(opts: { productId?: number; locationId?: number; from?: string; to?: string; take?: number }) {
  const where: any = {};
  if (opts.productId) where.productId = opts.productId;
  if (opts.locationId) where.locationId = opts.locationId;
  if (opts.from || opts.to) where.dayKey = { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) };
  return prisma.productStockSnapshot.findMany({
    where, orderBy: [{ dayKey: "asc" }, { locationId: "asc" }],
    select: { dayKey: true, locationId: true, quantity: true },
    ...(opts.take != null ? { take: opts.take } : {}),
  });
}

// ---------------------------------------------------------------------------
// Lane 3 — Tier-1 Operations analytics (spec D6 as amended by R-L10/R-L11).
//
// GLOBAL, physical-pool metrics over inventory_logs + ProductStockSnapshot. No
// company dimension exists on this data — every function is company-agnostic.
// Truthful-data law: every metric labels its OWN source data-start; a source
// with zero rows renders as no-data (null), NEVER as a silent 0. Date math flows
// through lib/analytics/dates.ts — no new UTC helper.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const TURNS_COVERAGE_FLOOR = 0.8; // R-L10: turns null below 80% snapshot coverage.
const AGING_OUTLIER_DAYS = 90; // aligns with DEAD_STOCK_DAYS.

/**
 * Classified shrinkage reasons (Lane 6 / review B1 / D-T3). ONLY a row that
 * carries one of these reason codes is loss. Every other negative movement —
 * a null reasonCode, a bare CORRECTION, and above all the negative ADJUSTMENT
 * rows this business uses to SHIP product — is unclassified outbound, surfaced
 * as a coverage figure and NEVER bucketed as shrinkage.
 */
export type ShrinkageReason = "DAMAGE" | "THEFT" | "EXPIRY" | "COUNT";
export const SHRINKAGE_CLASS_REASONS = ["DAMAGE", "THEFT", "EXPIRY", "COUNT"] as const;

// The ONE outbound (units-out / velocity) predicate now lives in the metrics
// contract (spec §2 D1): `PHYSICAL_OUTBOUND_WHERE` = delta<0 AND logType != TRANSFER
// (corrections INCLUDED — they deplete). Shared verbatim by units-out, last-outbound,
// the low-stock velocity, and demand.ts so the definitions can never disagree. No
// caller defines its own copy any more.

// Attention triage rank for the deterministic operations sort (W0-SORT): out is most
// urgent, ok least. The get_operations tool re-sorts by attention (stably), so the
// secondary ordering established here survives to both the web view and the tool.
const ATTENTION_SORT_RANK: Record<OperationsRow["attention"], number> = {
  out: 3,
  low: 2,
  stale: 1,
  ok: 0,
};

/** daysOfSupply ascending, NULLS LAST (W0-SORT): a shorter runway is more urgent; a
 *  product with no measurable runway (null) sorts after every product that has one. */
function compareDaysOfSupplyAscNullsLast(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

export interface OperationsRow {
  productId: number;
  name: string;
  currentStock: number;
  unitsOut30: number | null;
  unitsOut90: number | null;
  // Per-product velocity (spec §2 D2): units out over the last 30 days divided by that
  // product's OWN days-covered (span from its first qualifying outbound in the window),
  // NEVER a flat /30. Renamed from avgDaily30 so every consumer re-reads the meaning.
  avgDailyOutbound30: number | null;
  daysOfSupply: number | null;
  // Stock turns over `turnsWindowDays` (W0-TURNS): null below the snapshot-coverage
  // floor or with no snapshot inventory to divide by. `turnsWindowDays` is the window
  // the turns figure is measured over (always known — 30 or 90).
  turns: number | null;
  turnsWindowDays: number;
  turnsCoverage: { days: number; windowDays: number } | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  shrinkage90: { units: number; valueAtCurrentCostCents: number | null } | null;
  correctionsIn90: number;
  lastReceiptCostCents: number | null;
  attention: "ok" | "low" | "out" | "stale";
}

// Per-SOURCE data-starts (codex #9): each Operations metric labels its own source.
// `outbound` (Lane 6 / D-T4) is the velocity source of truth — the first negative
// non-transfer movement. `sale` is retained as the narrower "in-app order" sub-signal
// but no longer governs whether units-out is null (that was the review-B3 hazard).
export interface OperationsDataStarts {
  sale: string | null;
  outbound: string | null;
  adjustment: string | null;
  receipt: string | null;
  snapshot: string | null;
}

const toIso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/**
 * Latest STOCK_IN unit cost per product (R-L15 receipt-cost tie-break). groupBy
 * `_max(changeTime)` picks each product's most-recent receipt instant, then an
 * IN-fetch resolves the row; a same-timestamp tie is broken by the HIGHEST id
 * (rows are ordered id desc, first-seen-per-product wins). Value = that row's
 * `unitCostCents` (null when the winning receipt carries no frozen cost).
 * Products with no STOCK_IN row are absent from the map.
 */
async function latestReceiptCostByProduct(): Promise<Map<number, number | null>> {
  const maxTimes = await prisma.inventory_logs.groupBy({
    by: ["productId"],
    where: { logType: inventory_logs_logType.STOCK_IN },
    _max: { changeTime: true },
  });
  const pairs = maxTimes
    .filter((m) => m._max.changeTime != null)
    .map((m) => ({ productId: m.productId, changeTime: m._max.changeTime as Date }));
  if (pairs.length === 0) return new Map();

  const rows = await prisma.inventory_logs.findMany({
    where: { logType: inventory_logs_logType.STOCK_IN, OR: pairs },
    select: { id: true, productId: true, unitCostCents: true },
    orderBy: [{ id: "desc" }],
  });
  const out = new Map<number, number | null>();
  for (const r of rows) {
    // id desc => the first row seen for a product is the highest id among its
    // (already max-changeTime) ties. Later, lower-id ties are ignored.
    if (!out.has(r.productId)) out.set(r.productId, r.unitCostCents ?? null);
  }
  return out;
}

/** Per-product summed absolute outflow from a productId-grouped `_sum.delta` result. */
function absOutByProduct(rows: { productId: number; _sum: { delta: number | null } }[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of rows) m.set(r.productId, Math.abs(r._sum.delta ?? 0));
  return m;
}

/**
 * Tier-1 per-product Operations rows + per-source data-starts. `windowDays`
 * (default 90) sets the turns window; unitsOut30/unitsOut90 are always both
 * computed. Units-out uses the shared OUTBOUND predicate (`delta<0 AND logType !=
 * TRANSFER`, Lane 6 / review B3) — every physical shipment, however it was booked,
 * not `SALE`-only. Later un-fulfillments are NOT subtracted; they surface as
 * positive CORRECTION restocks in `correctionsIn90`.
 *
 * Per-product truthfulness (review B3): a product with NO outbound row in the
 * window contributes `null`, never a `0` fallback — there is no global "has any
 * sale data" flag that could flip every product to a confident zero the instant
 * one SALE row lands. The velocity denominator is clamped to the window actually
 * covered by outbound data, so a freshly-started data source cannot inflate it.
 */
export async function getOperationsRows(
  opts: { windowDays?: 30 | 90 } = {}
): Promise<{ rows: OperationsRow[]; dataStarts: OperationsDataStarts; velocityDefinition: string }> {
  const windowDays = opts.windowDays === 30 ? 30 : 90;
  const now = new Date();
  const start30 = new Date(now.getTime() - 30 * DAY_MS);
  const start90 = new Date(now.getTime() - 90 * DAY_MS);
  const turnsStart = new Date(now.getTime() - windowDays * DAY_MS);
  const snapWindowStartKey = toDayKey(turnsStart);
  const agingCutoff = new Date(now.getTime() - AGING_OUTLIER_DAYS * DAY_MS);

  const [
    products,
    systemDefault,
    outbound30,
    outbound90,
    inbound,
    lastOutbound,
    shrink90,
    corrections90,
    snapshots,
    receiptMap,
    saleStart,
    outboundStart,
    adjustmentStart,
    receiptStart,
    snapshotStart,
  ] = await Promise.all([
    prisma.product.findMany({
      where: { deletedAt: null, approvalStatus: "APPROVED" },
      select: {
        id: true,
        name: true,
        costPrice: true,
        lowStockThreshold: true,
        product_locations: { select: { quantity: true } },
      },
    }),
    getLowStockDefault(),
    prisma.inventory_logs.groupBy({
      by: ["productId"],
      where: { ...PHYSICAL_OUTBOUND_WHERE, changeTime: { gte: start30 } },
      _sum: { delta: true },
      // Per-product FIRST qualifying outbound IN the 30-day window (spec §2 D2): the
      // velocity denominator is this product's own days-covered, not a global dataStart.
      _min: { changeTime: true },
    }),
    prisma.inventory_logs.groupBy({
      by: ["productId"],
      where: { ...PHYSICAL_OUTBOUND_WHERE, changeTime: { gte: start90 } },
      _sum: { delta: true },
    }),
    prisma.inventory_logs.groupBy({
      by: ["productId"],
      where: { delta: { gt: 0 } },
      _max: { changeTime: true },
    }),
    prisma.inventory_logs.groupBy({
      by: ["productId"],
      where: PHYSICAL_OUTBOUND_WHERE,
      _max: { changeTime: true },
    }),
    prisma.inventory_logs.groupBy({
      by: ["productId"],
      where: {
        logType: { in: [inventory_logs_logType.ADJUSTMENT, inventory_logs_logType.CORRECTION] },
        delta: { lt: 0 },
        reasonCode: { in: SHRINKAGE_CLASS_REASONS as unknown as string[] },
        changeTime: { gte: start90 },
      },
      _sum: { delta: true },
    }),
    prisma.inventory_logs.groupBy({
      by: ["productId"],
      where: { reasonCode: "CORRECTION", delta: { gt: 0 }, changeTime: { gte: start90 } },
      _count: { _all: true },
    }),
    prisma.productStockSnapshot.findMany({
      where: { dayKey: { gte: snapWindowStartKey } },
      select: { productId: true, dayKey: true, quantity: true },
    }),
    latestReceiptCostByProduct(),
    prisma.inventory_logs.aggregate({
      where: { logType: inventory_logs_logType.SALE, delta: { lt: 0 } },
      _min: { changeTime: true },
    }),
    prisma.inventory_logs.aggregate({
      where: PHYSICAL_OUTBOUND_WHERE,
      _min: { changeTime: true },
    }),
    prisma.inventory_logs.aggregate({
      where: {
        logType: { in: [inventory_logs_logType.ADJUSTMENT, inventory_logs_logType.CORRECTION] },
        delta: { lt: 0 },
      },
      _min: { changeTime: true },
    }),
    prisma.inventory_logs.aggregate({
      where: { logType: inventory_logs_logType.STOCK_IN },
      _min: { changeTime: true },
    }),
    prisma.productStockSnapshot.aggregate({ _min: { dayKey: true } }),
  ]);

  const dataStarts: OperationsDataStarts = {
    sale: toIso(saleStart._min.changeTime),
    outbound: toIso(outboundStart._min.changeTime),
    adjustment: toIso(adjustmentStart._min.changeTime),
    receipt: toIso(receiptStart._min.changeTime),
    snapshot: snapshotStart._min.dayKey ?? null,
  };
  const hasAdjustmentData = dataStarts.adjustment !== null;
  const hasSnapshotData = dataStarts.snapshot !== null;

  const out30 = absOutByProduct(outbound30);
  const out90 = absOutByProduct(outbound90);

  // PER-PRODUCT velocity denominator (spec §2 D2): each product's own first qualifying
  // outbound WITHIN the 30-day window drives its days-covered — NEVER a global flat /30
  // and never the global outbound dataStart. A product whose only movement is a burst in
  // the last few days divides by those few days, not by 30 (which would understate its
  // real velocity). Corrections are included (physicalOutbound predicate).
  const firstOutbound30 = new Map<number, Date>();
  for (const r of outbound30 as { productId: number; _min?: { changeTime: Date | null } }[]) {
    if (r._min?.changeTime) firstOutbound30.set(r.productId, r._min.changeTime);
  }
  const shrinkUnits = absOutByProduct(shrink90);
  const inboundAt = new Map<number, Date | null>(inbound.map((r) => [r.productId, r._max.changeTime]));
  const outboundAt = new Map<number, Date | null>(lastOutbound.map((r) => [r.productId, r._max.changeTime]));
  const correctionsCount = new Map<number, number>(
    corrections90.map((r) => [r.productId, r._count._all])
  );

  // Per-product snapshot coverage: distinct dayKeys in window + avg daily total
  // quantity (summed across locations per day, averaged over the days present).
  const snapByProduct = new Map<number, Map<string, number>>();
  for (const s of snapshots) {
    let byDay = snapByProduct.get(s.productId);
    if (!byDay) snapByProduct.set(s.productId, (byDay = new Map()));
    byDay.set(s.dayKey, (byDay.get(s.dayKey) ?? 0) + s.quantity);
  }

  const rows: OperationsRow[] = products.map((p) => {
    const currentStock = p.product_locations.reduce((a, l) => a + l.quantity, 0);
    // centsFromCostPrice: NULL/0 cost -> null (never a phantom $0.00 valuation, B2).
    const costCents = centsFromCostPrice(p.costPrice);

    // Per-product null, NOT a 0 fallback (review B3): a product absent from the
    // outbound map has no measured outbound in the window -> null. Present -> its
    // real summed outflow. No global flag, so a SALE row landing for one product
    // never flips another product's honest null to a confident 0.
    const unitsOut30 = out30.has(p.id) ? out30.get(p.id)! : null;
    const unitsOut90 = out90.has(p.id) ? out90.get(p.id)! : null;
    // Per-product days-covered denominator (spec §2 D2): span from THIS product's first
    // in-window outbound to now, clamped [1, 30]. Null when it has no outbound at all.
    const firstMs = firstOutbound30.get(p.id);
    const avgDailyOutbound30 =
      unitsOut30 === null || firstMs === undefined
        ? null
        : unitsOut30 / daysCovered(firstMs.getTime(), now.getTime(), 30);
    const daysOfSupply =
      avgDailyOutbound30 === null || avgDailyOutbound30 <= 0
        ? null
        : currentStock / avgDailyOutbound30;

    // Turns: |outbound over window| / avg daily snapshot qty; null below the coverage
    // floor or with no snapshot inventory to divide by. `turnsWindowDays` is the window
    // the figure is measured over (always known, even when turns itself is null).
    let turns: number | null = null;
    let turnsCoverage: { days: number; windowDays: number } | null = null;
    if (hasSnapshotData) {
      const byDay = snapByProduct.get(p.id);
      const coverageDays = byDay ? byDay.size : 0;
      turnsCoverage = { days: coverageDays, windowDays };
      const unitsOutWindow = windowDays === 30 ? unitsOut30 : unitsOut90;
      const avgQty =
        byDay && coverageDays > 0
          ? Array.from(byDay.values()).reduce((a, q) => a + q, 0) / coverageDays
          : 0;
      if (
        unitsOutWindow !== null &&
        avgQty > 0 &&
        coverageDays / windowDays >= TURNS_COVERAGE_FLOOR
      ) {
        turns = unitsOutWindow / avgQty;
      }
    }

    const lastOut = outboundAt.get(p.id) ?? null;
    const shrinkUnitsForProduct = shrinkUnits.get(p.id) ?? 0;
    const shrinkage90 = hasAdjustmentData
      ? {
          units: shrinkUnitsForProduct,
          // Value is null when the product carries no cost (B2) — never units x $0.
          valueAtCurrentCostCents: costCents === null ? null : shrinkUnitsForProduct * costCents,
        }
      : null;

    // Attention: out > low > stale > ok. Stale = aging outlier (in-stock, no
    // outbound movement in > 90 days). Low uses the shared inclusive predicate.
    const effectiveThreshold = effectiveLowStockThreshold(p.lowStockThreshold, systemDefault);
    let attention: OperationsRow["attention"];
    if (currentStock <= 0) attention = "out";
    else if (isLowStock(currentStock, effectiveThreshold)) attention = "low";
    else if (lastOut === null || lastOut < agingCutoff) attention = "stale";
    else attention = "ok";

    return {
      productId: p.id,
      name: p.name,
      currentStock,
      unitsOut30,
      unitsOut90,
      avgDailyOutbound30,
      daysOfSupply,
      turns,
      turnsWindowDays: windowDays,
      turnsCoverage,
      lastInboundAt: toIso(inboundAt.get(p.id) ?? null),
      lastOutboundAt: toIso(lastOut),
      shrinkage90,
      correctionsIn90: correctionsCount.get(p.id) ?? 0,
      lastReceiptCostCents: receiptMap.get(p.id) ?? null,
      attention,
    };
  });

  // Deterministic order (W0-SORT): attention rank desc, then daysOfSupply asc nulls-last,
  // then productId. Both the web view and the get_operations tool render this order (the
  // tool's attention-only re-sort is stable, so the secondary keys survive).
  rows.sort(
    (a, b) =>
      ATTENTION_SORT_RANK[b.attention] - ATTENTION_SORT_RANK[a.attention] ||
      compareDaysOfSupplyAscNullsLast(a.daysOfSupply, b.daysOfSupply) ||
      a.productId - b.productId,
  );

  return { rows, dataStarts, velocityDefinition: PHYSICAL_OUTBOUND_DEFINITION };
}

export interface ShrinkageSummary {
  byReason: Record<
    ShrinkageReason,
    {
      units: number;
      valueAtCurrentCostCents: number | null;
      // Cost-coverage (spec §3 E4): how many of the bucket's units carry a known cost.
      // valueAtCurrentCostCents is a KNOWN-COST SUBTOTAL — check this before treating it
      // as the whole bucket's value (one costed unit among many must not read "valued").
      costCoverage: { costedUnits: number; totalUnits: number };
    }
  >;
  totalUnits: number;
  totalValueAtCurrentCostCents: number | null;
  // Cost-coverage across ALL classified loss (spec §3 E4): costedUnits/totalUnits so
  // totalValueAtCurrentCostCents is read as the known-cost subtotal, not a bare total.
  costCoverage: { costedUnits: number; totalUnits: number };
  // Coverage (D-T1 / review B1): outbound movement in the ADJUSTMENT/CORRECTION
  // domain that carries NO classified reason code. On this deployment that is the
  // ~16k units the business SHIPPED as negative ADJUSTMENTs — reported here as a
  // coverage figure, never as loss. `reasonTrackingStartedAt` is the first instant
  // any such row carried a reason code; movement before it is unclassifiable.
  coverage: { unclassifiedOutboundUnits: number; reasonTrackingStartedAt: string | null };
  dataStart: string | null;
}

/**
 * Classified-loss shrinkage over negative-delta ADJUSTMENT/CORRECTION rows in the
 * window (Lane 6 / review B1 / D-T3). ONLY DAMAGE/THEFT/EXPIRY/COUNT count as
 * shrinkage; every other negative movement — a null reasonCode, a bare CORRECTION,
 * and the negative ADJUSTMENTs this business ships product with — is reported as
 * `coverage.unclassifiedOutboundUnits`, explicitly NOT as loss. This is what kills
 * the "16,138 units of unclassified shrinkage" lie: on prod, totalUnits is 0 and
 * the 16k lands in coverage. Value = units x CURRENT costPrice; a product with no
 * cost on file contributes null, so a bucket with no known cost reports null (B2),
 * never units x $0.00.
 */
export async function getShrinkageSummary(
  opts: { days: 30 | 90 | 365 }
): Promise<ShrinkageSummary> {
  const now = new Date();
  const start = new Date(now.getTime() - opts.days * DAY_MS);
  const domain = {
    logType: { in: [inventory_logs_logType.ADJUSTMENT, inventory_logs_logType.CORRECTION] },
    delta: { lt: 0 },
  };

  const [grouped, dataStartAgg, reasonTrackingAgg] = await Promise.all([
    prisma.inventory_logs.groupBy({
      by: ["productId", "reasonCode"],
      where: { ...domain, changeTime: { gte: start } },
      _sum: { delta: true },
    }),
    prisma.inventory_logs.aggregate({ where: domain, _min: { changeTime: true } }),
    // First instant ANY outbound row in the domain carried a reason code (all-time).
    prisma.inventory_logs.aggregate({
      where: { ...domain, reasonCode: { not: null } },
      _min: { changeTime: true },
    }),
  ]);

  const CLASSIFIED = SHRINKAGE_CLASS_REASONS as unknown as string[];
  const acc: Record<
    ShrinkageReason,
    { units: number; value: number; hasCost: boolean; costedUnits: number }
  > = {
    DAMAGE: { units: 0, value: 0, hasCost: false, costedUnits: 0 },
    THEFT: { units: 0, value: 0, hasCost: false, costedUnits: 0 },
    EXPIRY: { units: 0, value: 0, hasCost: false, costedUnits: 0 },
    COUNT: { units: 0, value: 0, hasCost: false, costedUnits: 0 },
  };
  let unclassifiedOutboundUnits = 0;

  const productIds = Array.from(new Set(grouped.map((g) => g.productId)));
  const costByProduct = new Map<number, number | null>();
  if (productIds.length > 0) {
    const costs = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, costPrice: true },
    });
    for (const c of costs) costByProduct.set(c.id, centsFromCostPrice(c.costPrice));
  }

  for (const g of grouped) {
    const units = Math.abs(g._sum?.delta ?? 0);
    const rc = g.reasonCode;
    if (rc !== null && CLASSIFIED.includes(rc)) {
      const bucket = acc[rc as ShrinkageReason];
      bucket.units += units;
      const cost = costByProduct.get(g.productId);
      if (cost != null) {
        bucket.value += units * cost;
        bucket.hasCost = true;
        bucket.costedUnits += units;
      }
    } else {
      unclassifiedOutboundUnits += units;
    }
  }

  const byReason = {} as ShrinkageSummary["byReason"];
  let totalUnits = 0;
  let totalValue = 0;
  let totalHasCost = false;
  let totalCostedUnits = 0;
  for (const key of Object.keys(acc) as ShrinkageReason[]) {
    const b = acc[key];
    byReason[key] = {
      units: b.units,
      valueAtCurrentCostCents: b.hasCost ? b.value : null,
      costCoverage: { costedUnits: b.costedUnits, totalUnits: b.units },
    };
    totalUnits += b.units;
    totalCostedUnits += b.costedUnits;
    if (b.hasCost) {
      totalValue += b.value;
      totalHasCost = true;
    }
  }

  return {
    byReason,
    totalUnits,
    totalValueAtCurrentCostCents: totalHasCost ? totalValue : null,
    costCoverage: { costedUnits: totalCostedUnits, totalUnits },
    coverage: {
      unclassifiedOutboundUnits,
      reasonTrackingStartedAt: toIso(reasonTrackingAgg._min?.changeTime),
    },
    dataStart: toIso(dataStartAgg._min?.changeTime),
  };
}

// W1-INT fence exception (plan §"Fence exceptions" #1): `getValuationSummary` and
// its `ValuationSummary` interface MOVED to lib/analytics/valuation.ts (W1-VAL). This
// is a REPLACE, not an add — the local definitions are DELETED here and re-exported so
// every existing import site (get_valuation tool, lane3-operations-queries.test.ts)
// keeps resolving `@/lib/analytics/queries` unchanged. The private
// `latestReceiptCostByProduct` helper STAYS (getOperationsRows/getShrinkageSummary
// still call it); valuation.ts carries its own verbatim copy.
export { getValuationSummary, type ValuationSummary } from "@/lib/analytics/valuation";
