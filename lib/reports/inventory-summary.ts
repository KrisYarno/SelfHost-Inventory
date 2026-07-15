/**
 * lib/reports/inventory-summary.ts — the catalog-wide inventory summary module
 * (assistant toolsuite breadth, spec §5 T-SUM).
 *
 * Catalog totals (unitsOnHand, productCount, stockStateCounts) + the catalog
 * valuation (delegated verbatim to `getValuation` — this module NEVER
 * re-implements valuation math) + an optional deterministic ranked page over
 * the same in-scope product set.
 *
 * SCOPE PREDICATE: approved, non-deleted products — the same predicate
 * `getValuation`/`getValuationSummary` use (lib/analytics/valuation.ts).
 *
 * STOCK STATE: copied from `find_product`'s rule (lib/assistant/tools.ts
 * find_product, W0-FIND) via the SAME shared helpers, not re-implemented:
 * out wins over low (`quantity <= 0` => "out"), else `isLowStock(quantity,
 * effectiveLowStockThreshold(product.lowStockThreshold, systemDefault))`.
 *
 * LOCATION SCOPING DECISION (plan-directed): `getValuation` has no
 * `locationId` parameter (receipt/cost/retail are not location-attributable
 * the way units are — see valuation.ts's location-grain `atReceiptCostCents:
 * null` reason). So when `opts.locationId` is set:
 *   - unitsOnHand / stockStateCounts / the `onHand`+`outbound30`+`daysOfSupply`
 *     ranked metrics ARE location-scoped (inventory_logs and product_locations
 *     both carry a real locationId column — nothing structural prevents it).
 *   - `productCount` stays the GLOBAL approved+non-deleted catalog count (a
 *     location filter doesn't change "how many products exist", only how much
 *     of each is where).
 *   - `valuation` stays GLOBAL (catalog-wide) and carries a `reasons.valuation`
 *     note on its row(s): "valuation is catalog-wide; location-scoped
 *     valuation is not provided here". The `value` ranked metric is likewise
 *     GLOBAL per-product `atCurrentCostCents` for the same structural reason.
 *
 * DETERMINISM: `now` is an injectable SECOND parameter (not folded into
 * `opts`, which is the plan's literal contract shape) defaulting to
 * `new Date()`, so `outbound30`/`daysOfSupply` tests are deterministic
 * without touching the opts contract.
 *
 * MUST stay Next-free (imported by the assistant-tool layer): no `next/*`, no
 * `@/lib/api-utils`.
 */

import prisma from "@/lib/prisma";
import { getValuation, type ValuationResult } from "@/lib/analytics/valuation";
import { effectiveLowStockThreshold, getLowStockDefault, isLowStock } from "@/lib/stock-threshold";
import { PHYSICAL_OUTBOUND_WHERE, daysCovered as daysCoveredInWindow } from "@/lib/reports/metrics-contract";
import { paginate, type DbPage } from "@/lib/assistant/tools";

const DAY_MS = 86_400_000;
const OUTBOUND_WINDOW_DAYS = 30;
const DEFAULT_RANK_LIMIT = 20;

const LOCATION_SCOPED_VALUATION_NOTE =
  "valuation is catalog-wide; location-scoped valuation is not provided here";

export interface InventorySummary {
  unitsOnHand: number;
  productCount: number;
  stockStateCounts: { in_stock: number; low: number; out: number };
  valuation: ValuationResult;
  ranked?: DbPage<{ productId: number; name: string | null; metric: number | null }>;
}

type RankBy = "onHand" | "value" | "outbound30" | "daysOfSupply";

export interface GetInventorySummaryOpts {
  rankBy?: RankBy;
  locationId?: number;
  limit?: number;
  offset?: number;
  byteBudget: number;
}

type RankedRow = { productId: number; name: string | null; metric: number | null };

/** Per-product physical-outbound total + the days-covered denominator over the
 *  trailing 30-day window (spec §2 D2 — the shared contract math, not a flat 30). */
interface OutboundEntry {
  units: number;
  daysCoveredVal: number;
}

export async function getInventorySummary(
  opts: GetInventorySummaryOpts,
  now: Date = new Date(),
): Promise<InventorySummary> {
  const nowMs = now.getTime();
  const locationId = opts.locationId;

  const [products, systemDefault] = await Promise.all([
    prisma.product.findMany({
      where: { deletedAt: null, approvalStatus: "APPROVED" },
      select: {
        id: true,
        name: true,
        lowStockThreshold: true,
        product_locations: { select: { locationId: true, quantity: true } },
      },
      orderBy: { id: "asc" },
    }),
    getLowStockDefault(),
  ]);

  // ---- per-product on-hand quantity (location-scoped when opts.locationId is set) ----
  const onHandMap = new Map<number, number>();
  let unitsOnHand = 0;
  const stockStateCounts = { in_stock: 0, low: 0, out: 0 };

  for (const p of products) {
    const qty = p.product_locations
      .filter((l) => locationId == null || l.locationId === locationId)
      .reduce((a, l) => a + l.quantity, 0);
    onHandMap.set(p.id, qty);
    unitsOnHand += qty;

    // Same derivation as find_product's stockState (W0-FIND): out wins over low.
    const effectiveThreshold = effectiveLowStockThreshold(p.lowStockThreshold, systemDefault);
    const low = isLowStock(qty, effectiveThreshold);
    if (qty <= 0) stockStateCounts.out += 1;
    else if (low) stockStateCounts.low += 1;
    else stockStateCounts.in_stock += 1;
  }

  // ---- valuation (delegated verbatim; never re-implemented) ----
  const valuation = await getValuation({ groupBy: "total" });
  if (locationId != null) {
    valuation.rows = valuation.rows.map((r) => ({
      ...r,
      reasons: { ...r.reasons, valuation: LOCATION_SCOPED_VALUATION_NOTE },
    }));
  }

  const result: InventorySummary = {
    unitsOnHand,
    productCount: products.length,
    stockStateCounts,
    valuation,
  };

  if (opts.rankBy) {
    const limit = opts.limit ?? DEFAULT_RANK_LIMIT;
    const offset = opts.offset ?? 0;
    const rows = await buildRankedRows({
      rankBy: opts.rankBy,
      products,
      onHandMap,
      locationId,
      nowMs,
    });
    result.ranked = paginate(rows, offset, limit, opts.byteBudget);
  }

  return result;
}

async function buildRankedRows(args: {
  rankBy: RankBy;
  products: Array<{ id: number; name: string | null }>;
  onHandMap: Map<number, number>;
  locationId?: number;
  nowMs: number;
}): Promise<RankedRow[]> {
  const { rankBy, products, onHandMap, locationId, nowMs } = args;
  const productIds = products.map((p) => p.id);

  let valueMap: Map<number, number | null> | null = null;
  let outboundMap: Map<number, OutboundEntry> | null = null;

  if (rankBy === "value") {
    valueMap = await buildValueMap();
  } else if (rankBy === "outbound30" || rankBy === "daysOfSupply") {
    outboundMap = await buildOutboundMap(productIds, locationId, nowMs);
  }

  const rows: RankedRow[] = products.map((p) => {
    const onHand = onHandMap.get(p.id) ?? 0;
    let metric: number | null;
    switch (rankBy) {
      case "onHand":
        metric = onHand;
        break;
      case "value":
        // Uncosted products are absent/null in the valuation map — null metric,
        // sorted nulls-last below (never a guessed cost).
        metric = valueMap?.get(p.id) ?? null;
        break;
      case "outbound30": {
        // A product with zero qualifying outbound rows in the window is a
        // MEASURED zero (we looked, there was none) — 0, not null.
        const entry = outboundMap?.get(p.id);
        metric = entry ? entry.units : 0;
        break;
      }
      case "daysOfSupply": {
        const entry = outboundMap?.get(p.id);
        metric = daysOfSupplyMetric(onHand, entry);
        break;
      }
      default:
        metric = null;
    }
    return { productId: p.id, name: p.name, metric };
  });

  return sortRanked(rows);
}

/** value ranking metric: GLOBAL per-product atCurrentCostCents from getValuation's
 *  product grain (never location-scoped — see module docstring). */
async function buildValueMap(): Promise<Map<number, number | null>> {
  const productValuation = await getValuation({ groupBy: "product" });
  const map = new Map<number, number | null>();
  for (const row of productValuation.rows) {
    if (row.productId != null) map.set(row.productId, row.atCurrentCostCents);
  }
  return map;
}

/** outbound30 / daysOfSupply shared source: one groupBy query over the trailing
 *  30-day window using the shared physicalOutbound predicate (spec §2 D1). */
async function buildOutboundMap(
  productIds: number[],
  locationId: number | undefined,
  nowMs: number,
): Promise<Map<number, OutboundEntry>> {
  const map = new Map<number, OutboundEntry>();
  if (productIds.length === 0) return map;

  const windowStart = new Date(nowMs - OUTBOUND_WINDOW_DAYS * DAY_MS);
  const groups = await prisma.inventory_logs.groupBy({
    by: ["productId"],
    where: {
      ...PHYSICAL_OUTBOUND_WHERE,
      productId: { in: productIds },
      changeTime: { gte: windowStart },
      ...(locationId != null ? { locationId } : {}),
    },
    _sum: { delta: true },
    _min: { changeTime: true },
  });

  for (const g of groups) {
    const firstMs = g._min.changeTime?.getTime();
    const totalDelta = g._sum.delta ?? 0;
    const units = Math.abs(totalDelta);
    if (firstMs == null || units <= 0) continue; // no qualifying signal for this product
    const daysCoveredVal = daysCoveredInWindow(firstMs, nowMs, OUTBOUND_WINDOW_DAYS);
    map.set(g.productId, { units, daysCoveredVal });
  }
  return map;
}

/** daysOfSupply = onHand / (outbound30 / daysCovered); null (never 0 or Infinity)
 *  when there is no qualifying outbound in the window — an unmeasurable rate, not
 *  a zero rate. */
function daysOfSupplyMetric(onHand: number, entry: OutboundEntry | undefined): number | null {
  if (!entry || entry.units <= 0 || entry.daysCoveredVal <= 0) return null;
  const rate = entry.units / entry.daysCoveredVal;
  if (rate <= 0) return null;
  return onHand / rate;
}

/** Deterministic tie-break (plan-directed): metric desc, nulls last, then productId asc. */
function sortRanked(rows: RankedRow[]): RankedRow[] {
  return [...rows].sort((a, b) => {
    if (a.metric == null && b.metric == null) return a.productId - b.productId;
    if (a.metric == null) return 1;
    if (b.metric == null) return -1;
    if (a.metric !== b.metric) return b.metric - a.metric;
    return a.productId - b.productId;
  });
}
