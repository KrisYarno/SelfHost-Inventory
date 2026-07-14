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
 * The route is now a thin caller: its JSON response is byte-identical (same key
 * order, same sort, same `threshold`, incl. the `?threshold=` override path). The
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
import { inventory_logs_logType } from "@prisma/client";
import { LowStockResponse, LowStockAlert } from "@/types/reports";
import { getLowStockDefault, effectiveLowStockThreshold } from "@/lib/stock-threshold";

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
 * Response shape is exactly `LowStockResponse` ({ alerts, threshold }).
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

  // Get activity from last 30 days to calculate usage
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Usage = outbound consumption, which is NOT an internal transfer (Lane 6 /
  // review M2 / D-T5). Counting the ~7,682 units/yr of TRANSFER movement as usage
  // shortened every runway and inflated "days until empty" upstream.
  const recentActivity = await prisma.inventory_logs.findMany({
    where: {
      changeTime: { gte: thirtyDaysAgo },
      delta: { lt: 0 },
      logType: { not: inventory_logs_logType.TRANSFER },
    },
    select: {
      productId: true,
      delta: true,
      changeTime: true,
    },
  });

  // Calculate average daily usage per product
  const usageMap = new Map<number, number>();
  const productUsage = new Map<number, number[]>();

  recentActivity.forEach((log) => {
    if (!productUsage.has(log.productId)) {
      productUsage.set(log.productId, []);
    }
    productUsage.get(log.productId)!.push(Math.abs(log.delta));
  });

  productUsage.forEach((usages, productId) => {
    const totalUsage = usages.reduce((sum: number, usage: number) => sum + usage, 0);
    const avgDailyUsage = totalUsage / 30;
    usageMap.set(productId, avgDailyUsage);
  });

  // Build low stock alerts
  const alerts: LowStockAlert[] = [];

  products.forEach((product) => {
    const currentStock = stockMap.get(product.id) || 0;
    const productThreshold = effectiveLowStockThreshold(product.lowStockThreshold, defaultThreshold);

    // INCLUSIVE boundary (R-L13); a 0 effective threshold (disabled) never alerts.
    // Out-of-stock (0) stays in this reorder-oriented report as the most critical.
    if (needsReorderAttention(currentStock, productThreshold)) {
      const avgDailyUsage = usageMap.get(product.id) || 0;
      // Compute daysUntilEmpty from the SAME rounded figure the report displays
      // (Lane 6 / review M2): the TESA incoherence was 0.0667/day (unrounded) giving
      // 150 days next to a displayed "0.1/day" that implies 100. Round once, use it
      // for both, so a reader can reproduce the number.
      const displayedDailyUsage = Math.round(avgDailyUsage * 10) / 10;
      const daysUntilEmpty =
        displayedDailyUsage > 0 ? Math.floor(currentStock / displayedDailyUsage) : null;
      const percentageRemaining = productThreshold > 0 ? (currentStock / productThreshold) * 100 : 0;

      alerts.push({
        productId: product.id,
        productName: product.name,
        currentStock,
        threshold: productThreshold,
        percentageRemaining: Math.round(percentageRemaining),
        averageDailyUsage: displayedDailyUsage,
        daysUntilEmpty,
      });
    }
  });

  // Sort by percentage remaining (most critical first)
  alerts.sort((a, b) => a.percentageRemaining - b.percentageRemaining);

  const limited = opts.limit != null ? alerts.slice(0, opts.limit) : alerts;

  return {
    alerts: limited,
    threshold: defaultThreshold,
  };
}
