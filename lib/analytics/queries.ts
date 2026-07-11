import prisma from "@/lib/prisma";
import { inventory_logs_logType } from "@prisma/client";
import { toDayKey } from "@/lib/analytics/dates";
import { effectiveLowStockThreshold, getLowStockDefault, isLowStock } from "@/lib/stock-threshold";

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
  const _sum: { orderedQty: true; fulfilledQty: true; revenue: true; orderCount?: true } = {
    orderedQty: true, fulfilledQty: true, revenue: true,
  };
  if (groupBy === "product") _sum.orderCount = true;
  return prisma.productSalesFact.groupBy({
    by: by as any,
    where,
    _sum,
  });
}

/** GLOBAL stock-level series from snapshots (no company scoping — inventory is GLOBAL). */
export async function getStockSeries(opts: { productId?: number; locationId?: number; from?: string; to?: string }) {
  const where: any = {};
  if (opts.productId) where.productId = opts.productId;
  if (opts.locationId) where.locationId = opts.locationId;
  if (opts.from || opts.to) where.dayKey = { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) };
  return prisma.productStockSnapshot.findMany({
    where, orderBy: [{ dayKey: "asc" }, { locationId: "asc" }],
    select: { dayKey: true, locationId: true, quantity: true },
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

/** Reason-code buckets for shrinkage reporting (spec D6). null reasonCode -> UNCLASSIFIED. */
export type ShrinkageReason = "DAMAGE" | "THEFT" | "EXPIRY" | "COUNT" | "CORRECTION" | "UNCLASSIFIED";
const SHRINKAGE_CLASS_REASONS = ["DAMAGE", "THEFT", "EXPIRY"] as const; // the true shrinkage classes.

export interface OperationsRow {
  productId: number;
  name: string;
  currentStock: number;
  unitsOut30: number | null;
  unitsOut90: number | null;
  avgDaily30: number | null;
  daysOfSupply: number | null;
  turns90: number | null;
  turnsCoverage: { days: number; windowDays: number } | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  shrinkage90: { units: number; valueAtCurrentCostCents: number | null } | null;
  correctionsIn90: number;
  lastReceiptCostCents: number | null;
  attention: "ok" | "low" | "out" | "stale";
}

// Per-SOURCE data-starts (codex #9): each Operations metric labels its own source.
export interface OperationsDataStarts {
  sale: string | null;
  adjustment: string | null;
  receipt: string | null;
  snapshot: string | null;
}

const toIso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const centsOf = (costPrice: unknown): number => Math.round(Number(costPrice) * 100);

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
 * computed. SALE predicate = `logType='SALE' AND delta<0` (R-L11 gross
 * fulfillment outflow — later un-fulfillments are NOT subtracted; they surface
 * as positive CORRECTION restocks in `correctionsIn90`).
 */
export async function getOperationsRows(
  opts: { windowDays?: 30 | 90 } = {}
): Promise<{ rows: OperationsRow[]; dataStarts: OperationsDataStarts }> {
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
    sale30,
    sale90,
    inbound,
    outbound,
    shrink90,
    corrections90,
    snapshots,
    receiptMap,
    saleStart,
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
      where: { logType: inventory_logs_logType.SALE, delta: { lt: 0 }, changeTime: { gte: start30 } },
      _sum: { delta: true },
    }),
    prisma.inventory_logs.groupBy({
      by: ["productId"],
      where: { logType: inventory_logs_logType.SALE, delta: { lt: 0 }, changeTime: { gte: start90 } },
      _sum: { delta: true },
    }),
    prisma.inventory_logs.groupBy({
      by: ["productId"],
      where: { delta: { gt: 0 } },
      _max: { changeTime: true },
    }),
    prisma.inventory_logs.groupBy({
      by: ["productId"],
      where: { delta: { lt: 0 } },
      _max: { changeTime: true },
    }),
    prisma.inventory_logs.groupBy({
      by: ["productId"],
      where: {
        logType: inventory_logs_logType.ADJUSTMENT,
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
    adjustment: toIso(adjustmentStart._min.changeTime),
    receipt: toIso(receiptStart._min.changeTime),
    snapshot: snapshotStart._min.dayKey ?? null,
  };
  const hasSaleData = dataStarts.sale !== null;
  const hasAdjustmentData = dataStarts.adjustment !== null;
  const hasSnapshotData = dataStarts.snapshot !== null;

  // Velocity denominator: min(window, days since SALE data started) — never a flat 30.
  const daysSinceSaleStart = dataStarts.sale
    ? Math.max(1, Math.ceil((now.getTime() - new Date(dataStarts.sale).getTime()) / DAY_MS))
    : 0;
  const velocityDenom = Math.max(1, Math.min(30, daysSinceSaleStart || 30));

  const out30 = absOutByProduct(sale30);
  const out90 = absOutByProduct(sale90);
  const shrinkUnits = absOutByProduct(shrink90);
  const inboundAt = new Map<number, Date | null>(inbound.map((r) => [r.productId, r._max.changeTime]));
  const outboundAt = new Map<number, Date | null>(outbound.map((r) => [r.productId, r._max.changeTime]));
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
    const costCents = centsOf(p.costPrice);

    const unitsOut30 = hasSaleData ? out30.get(p.id) ?? 0 : null;
    const unitsOut90 = hasSaleData ? out90.get(p.id) ?? 0 : null;
    const avgDaily30 = unitsOut30 === null ? null : unitsOut30 / velocityDenom;
    const daysOfSupply =
      avgDaily30 === null || avgDaily30 <= 0 ? null : currentStock / avgDaily30;

    // Turns: |SALE out over window| / avg daily snapshot qty; null below the
    // coverage floor or with no snapshot inventory to divide by.
    let turns90: number | null = null;
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
        turns90 = unitsOutWindow / avgQty;
      }
    }

    const lastOut = outboundAt.get(p.id) ?? null;
    const shrinkage90 = hasAdjustmentData
      ? { units: shrinkUnits.get(p.id) ?? 0, valueAtCurrentCostCents: (shrinkUnits.get(p.id) ?? 0) * costCents }
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
      avgDaily30,
      daysOfSupply,
      turns90,
      turnsCoverage,
      lastInboundAt: toIso(inboundAt.get(p.id) ?? null),
      lastOutboundAt: toIso(lastOut),
      shrinkage90,
      correctionsIn90: correctionsCount.get(p.id) ?? 0,
      lastReceiptCostCents: receiptMap.get(p.id) ?? null,
      attention,
    };
  });

  return { rows, dataStarts };
}

/**
 * Shrinkage bucketed by reasonCode over negative-delta ADJUSTMENT/CORRECTION
 * rows in the window (spec D6). DAMAGE/THEFT/EXPIRY are the shrinkage classes;
 * COUNT is count variance (separate); CORRECTION is excluded from the shrinkage
 * total but still counted; UNCLASSIFIED (null reasonCode) is always shown.
 * Units are absolute; value = units x CURRENT costPrice, labeled at-current-cost.
 */
export async function getShrinkageSummary(
  opts: { days: 30 | 90 | 365 }
): Promise<{
  byReason: Record<ShrinkageReason, { units: number; valueAtCurrentCostCents: number | null }>;
  dataStart: string | null;
}> {
  const now = new Date();
  const start = new Date(now.getTime() - opts.days * DAY_MS);
  const predicate = {
    logType: { in: [inventory_logs_logType.ADJUSTMENT, inventory_logs_logType.CORRECTION] },
    delta: { lt: 0 },
  };

  const [grouped, dataStartAgg] = await Promise.all([
    prisma.inventory_logs.groupBy({
      by: ["productId", "reasonCode"],
      where: { ...predicate, changeTime: { gte: start } },
      _sum: { delta: true },
    }),
    prisma.inventory_logs.aggregate({ where: predicate, _min: { changeTime: true } }),
  ]);

  const byReason: Record<ShrinkageReason, { units: number; valueAtCurrentCostCents: number }> = {
    DAMAGE: { units: 0, valueAtCurrentCostCents: 0 },
    THEFT: { units: 0, valueAtCurrentCostCents: 0 },
    EXPIRY: { units: 0, valueAtCurrentCostCents: 0 },
    COUNT: { units: 0, valueAtCurrentCostCents: 0 },
    CORRECTION: { units: 0, valueAtCurrentCostCents: 0 },
    UNCLASSIFIED: { units: 0, valueAtCurrentCostCents: 0 },
  };

  const productIds = Array.from(new Set(grouped.map((g) => g.productId)));
  const costByProduct = new Map<number, number>();
  if (productIds.length > 0) {
    const costs = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, costPrice: true },
    });
    for (const c of costs) costByProduct.set(c.id, centsOf(c.costPrice));
  }

  for (const g of grouped) {
    const raw = (g.reasonCode ?? "UNCLASSIFIED") as string;
    const key: ShrinkageReason = raw in byReason ? (raw as ShrinkageReason) : "UNCLASSIFIED";
    const units = Math.abs(g._sum?.delta ?? 0);
    byReason[key].units += units;
    byReason[key].valueAtCurrentCostCents += units * (costByProduct.get(g.productId) ?? 0);
  }

  return { byReason, dataStart: toIso(dataStartAgg._min?.changeTime) };
}

/**
 * Inventory valuation tier 1 (spec D6). (a) value at CURRENT cost = SUM(current
 * stock x costPrice); (b) value at last-receipt cost = SUM over in-stock products
 * that HAVE receipt-cost data of stock x latest STOCK_IN unitCostCents (products
 * without receipt cost are EXCLUDED, surfaced via the coverage chip — never
 * blended silently). Coverage is counted over IN-STOCK products only.
 */
export async function getValuationSummary(): Promise<{
  atCurrentCostCents: number;
  atReceiptCostCents: number | null;
  receiptCoverage: { have: number; of: number };
}> {
  const [products, receiptMap] = await Promise.all([
    prisma.product.findMany({
      where: { deletedAt: null, approvalStatus: "APPROVED" },
      select: { id: true, costPrice: true, product_locations: { select: { quantity: true } } },
    }),
    latestReceiptCostByProduct(),
  ]);

  let atCurrentCostCents = 0;
  let atReceiptCostCents = 0;
  let have = 0;
  let of = 0;
  for (const p of products) {
    const currentStock = p.product_locations.reduce((a, l) => a + l.quantity, 0);
    atCurrentCostCents += currentStock * centsOf(p.costPrice);
    if (currentStock > 0) {
      of += 1;
      const receiptCents = receiptMap.get(p.id);
      if (receiptCents != null) {
        have += 1;
        atReceiptCostCents += currentStock * receiptCents;
      }
    }
  }

  return {
    atCurrentCostCents,
    atReceiptCostCents: have > 0 ? atReceiptCostCents : null,
    receiptCoverage: { have, of },
  };
}
