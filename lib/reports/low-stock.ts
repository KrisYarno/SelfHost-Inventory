/**
 * lib/reports/low-stock.ts — the low-stock reorder report, extracted verbatim from
 * app/api/reports/low-stock/route.ts (codex #5/#8).
 *
 * This is a REORDER report: it deliberately INCLUDES out-of-stock (quantity 0)
 * rows — they are the most urgent reorders. `needsReorderAttention` is the shared
 * predicate: `effectiveThreshold > 0 && quantity <= effectiveThreshold` (INCLUSIVE,
 * qty-0 preserved). This is intentionally NOT `isLowStock` (which floors at qty>0
 * for the low-stock badge); a reorder report must not silently drop stockouts.
 *
 * The route is now a thin caller: same key order, same sort, same `threshold`, incl.
 * the `?threshold=` override path. The former "byte-identical" guarantee is
 * CONSCIOUSLY AMENDED as of spec C8 — every alert row additionally carries
 * `rawThreshold` (the per-product column verbatim, null = inherited), an additive
 * field the web API intentionally gains so no consumer has to infer a threshold
 * source by comparing the effective value to the default. The
 * assistant/MCP `low_stock_report` tool calls this with a `limit`.
 *
 * NOTE (spec amendment recorded): the derived sort computes over the approved set
 * then sorts — an accepted bounded-cost exception at this shop's volume (mirrors
 * getOperationsRows), documented here.
 *
 * MUST stay Next-free (imported by the assistant tool layer): no `next/*`, no
 * `@/lib/api-utils`.
 */

import prisma from "@/lib/prisma";
import { LowStockResponse, LowStockAlert } from "@/types/reports";
import { getLowStockDefault, effectiveLowStockThreshold } from "@/lib/stock-threshold";
import { outboundVelocity } from "@/lib/reports/demand";
import { OUTBOUND_USAGE_DEFINITION, rate } from "@/lib/reports/metrics-contract";

/** The usage look-back (A2 pack C5): the days the per-row usage rate reads back over —
 *  a named constant the tool relays as `usageWindowDays`, never a bare 30. */
export const LOW_STOCK_USAGE_WINDOW_DAYS = 30;

/**
 * Shared reorder predicate. INCLUSIVE boundary (R-L13); a 0 effective threshold
 * (disabled) never triggers. Out-of-stock (0) IS a reorder — this is why the
 * report can't use `isLowStock` (which requires quantity > 0).
 */
export function needsReorderAttention(quantity: number, effectiveThreshold: number): boolean {
  return effectiveThreshold > 0 && quantity <= effectiveThreshold;
}

/**
 * Build the low-stock reorder report.
 *   - `thresholdOverride`: an explicit ?threshold value that overrides the
 *     inherited default for NULL-threshold products (route `?threshold=` path).
 *   - `limit`: cap the returned alerts (the tool's ≤50 bound); omitted = all
 *     (the route passes no limit, so its response stays byte-identical).
 * Response shape is exactly `LowStockResponse` ({ alerts, threshold, velocityDefinition,
 * alertsOff, alertsOffAtZeroStock, outOfStockAllProducts }). The three counts (A2 pack C2)
 * describe the whole approved catalog, never the `limit`ed alert list.
 */
export async function getLowStockReport(
  opts: { limit?: number; thresholdOverride?: number } = {},
): Promise<LowStockResponse> {
  // An explicit threshold override wins over the configurable system default for
  // NULL-threshold products (R-L13). Matches the route's original coalescing.
  const defaultThreshold =
    opts.thresholdOverride != null ? opts.thresholdOverride : await getLowStockDefault();

  // Get all products with their location quantities (source of truth)
  const products = await prisma.product.findMany({
    where: {
      deletedAt: null,
      approvalStatus: "APPROVED",
    },
    include: {
      product_locations: {
        select: { quantity: true },
      },
    },
  });

  // Build stock map from product_locations (not log deltas)
  const stockMap = new Map<number, number>();
  products.forEach((product) => {
    const totalQuantity = product.product_locations.reduce(
      (sum: number, pl: { quantity: number }) => sum + pl.quantity, 0
    );
    stockMap.set(product.id, totalQuantity);
  });

  // Usage = the ONE shared units-out velocity (lib/reports/demand.ts): outbound that
  // is NOT an internal transfer (Lane 6 / review M2 / D-T5 — counting the ~7,682
  // units/yr of TRANSFER movement as usage shortened every runway), now with the
  // truthful days-covered denominator + null-when-no-movement semantics (reorder-points
  // Task 2, a DELIBERATE behavior change from the former flat /30: a product's velocity
  // divides by the span since its first outbound in the window, not a fixed 30, and a
  // product with no outbound reports no usage rather than a fabricated 0/day).
  const velocityMap = await outboundVelocity(
    products.map((p) => p.id),
    LOW_STOCK_USAGE_WINDOW_DAYS,
  );

  // Build low stock alerts
  const alerts: LowStockAlert[] = [];
  // A2 pack C2: the catalog counts beside the alert list, over EVERY approved, non-deleted
  // product (never the limited page). `alertsOff` is the complement of the alert
  // predicate's threshold half (`effectiveThreshold > 0`), so every product is either
  // eligible to alert or counted here; `outOfStockAllProducts` is every product with no
  // stock, alerts on or off — the inventory summary's `stockStateCounts.out`.
  let alertsOff = 0;
  let alertsOffAtZeroStock = 0;
  let outOfStockAllProducts = 0;

  products.forEach((product) => {
    const currentStock = stockMap.get(product.id) || 0;
    const productThreshold = effectiveLowStockThreshold(product.lowStockThreshold, defaultThreshold);
    if (currentStock <= 0) outOfStockAllProducts += 1;
    if (productThreshold <= 0) {
      alertsOff += 1;
      if (currentStock <= 0) alertsOffAtZeroStock += 1;
    }

    // INCLUSIVE boundary (R-L13); a 0 effective threshold (disabled) never alerts.
    // Out-of-stock (0) stays in this reorder-oriented report as the most critical.
    if (needsReorderAttention(currentStock, productThreshold)) {
      // TRUTHFUL NULL PROPAGATION (spec §2 D4): a product with NO qualifying outbound
      // movement has an UNKNOWN daily usage — `null`, never a fabricated 0/day. The old
      // `?? 0` collapsed "unknown" into "measured zero"; now `usageKnown` records which
      // it is and daysUntilEmpty stays null when the rate is unknown.
      const rawDailyUsage = velocityMap.get(product.id)?.avgDailyDemand ?? null;
      const usageKnown = rawDailyUsage !== null;
      // Compute daysUntilEmpty from the SAME rounded figure the report displays
      // (Lane 6 / review M2): the TESA incoherence was 0.0667/day (unrounded) giving
      // 150 days next to a displayed "0.1/day" that implies 100. Round once, use it
      // for both, so a reader can reproduce the number. A2 pack C5 (declared change):
      // the ONE shared rate() rounding — 2 decimals at 1 or more, 3 significant figures
      // below — replaces the 1-decimal round that showed a slow mover as 0.0/day.
      const averageDailyUsage = usageKnown ? rate(rawDailyUsage) : null;
      const daysUntilEmpty =
        averageDailyUsage !== null && averageDailyUsage > 0
          ? Math.floor(currentStock / averageDailyUsage)
          : null;
      const percentageRemaining = productThreshold > 0 ? (currentStock / productThreshold) * 100 : 0;

      alerts.push({
        productId: product.id,
        productName: product.name,
        currentStock,
        threshold: productThreshold,
        // spec C8: the RAW column, unresolved. Consumers derive thresholdSource from
        // this (null = inherited) instead of comparing the effective value to the
        // default — a comparison that reports an override equal to the default, or an
        // explicit 0, as "system_default".
        rawThreshold: product.lowStockThreshold ?? null,
        percentageRemaining: Math.round(percentageRemaining),
        averageDailyUsage,
        usageKnown,
        daysUntilEmpty,
      });
    }
  });

  // Deterministic order (W0-SORT): percentage remaining (most critical first), then
  // productId as a stable tie-break so equal-% rows page consistently.
  alerts.sort(
    (a, b) => a.percentageRemaining - b.percentageRemaining || a.productId - b.productId,
  );

  const limited = opts.limit != null ? alerts.slice(0, opts.limit) : alerts;

  return {
    alerts: limited,
    threshold: defaultThreshold,
    // Report-level definition of the usage rate (spec §2 D3): units/day = physical
    // outbound over the days actually covered, null when there is no movement.
    velocityDefinition: OUTBOUND_USAGE_DEFINITION,
    alertsOff,
    alertsOffAtZeroStock,
    outOfStockAllProducts,
  };
}
