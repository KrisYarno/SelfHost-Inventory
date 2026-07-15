import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { MetricsResponse } from "@/types/reports";
import { subDays } from "date-fns";
import {
  calculateDaysOfSupply,
  getOrderStatus,
  calculateMonthlyCarryingCost,
  isDeadStock,
  isStockoutRisk,
  calculateTrend,
  DEAD_STOCK_DAYS,
} from "@/lib/metrics/warehouse-metrics";
import {
  getLowStockDefault,
  effectiveLowStockThreshold,
  isLowStock,
} from "@/lib/stock-threshold";
import { outboundVelocity } from "@/lib/reports/demand";

export const dynamic = "force-dynamic";

// The low-stock trend compares the latest snapshot day against the snapshot day ~7 days
// earlier. Bounding the heavy per-(product,day) groupBy to this window (plus generous slack
// for snapshot/backfill gaps) avoids scanning ALL of product_stock_snapshots history for a
// short trailing trend. The floor is anchored on the latest snapshot day (not "today") so a
// lagging snapshot feed can never shrink the window and change the computed trend.
const LOW_STOCK_TREND_WINDOW_DAYS = 30;

// Subtract N days from a 'YYYY-MM-DD' dayKey using UTC math (dayKey is TZ-safe; never date-fns format()).
function subtractDays(dayKey: string, n: number): string {
  const d = new Date(`${dayKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const searchParams = request.nextUrl.searchParams;
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");
  const locationId = searchParams.get("locationId");

  // Build where clause for date filtering
  const activityFilter: any = {};
  if (startDate) {
    activityFilter.changeTime = { ...activityFilter.changeTime, gte: new Date(startDate) };
  }
  if (endDate) {
    activityFilter.changeTime = { ...activityFilter.changeTime, lte: new Date(endDate) };
  }
  if (locationId) {
    activityFilter.locationId = parseInt(locationId);
  }

  const locationFilter = locationId ? { locationId: parseInt(locationId) } : undefined;

  // Get total products count (exclude soft-deleted + provisional from current-state metrics)
  const totalProducts = await prisma.product.count({
    where: { deletedAt: null, approvalStatus: "APPROVED" },
  });
  const activeProducts = totalProducts;

  // Get current inventory levels and calculate total stock
  // (exclude soft-deleted + provisional products from the current-state stock total, per E4)
  const productLocations = await prisma.product_locations.findMany({
    where: { ...locationFilter, products: { is: { deletedAt: null, approvalStatus: "APPROVED" } } },
    select: {
      productId: true,
      quantity: true,
    },
  });

  let totalStockQuantity = 0;
  const productStockMap = new Map<number, number>();

  productLocations.forEach((pl) => {
    totalStockQuantity += pl.quantity;
    productStockMap.set(pl.productId, (productStockMap.get(pl.productId) || 0) + pl.quantity);
  });

  // System-wide default a NULL-threshold product inherits (R-L13).
  const lowStockDefault = await getLowStockDefault();
  const products = await prisma.product.findMany({
    where: { deletedAt: null, approvalStatus: "APPROVED" },
    select: {
      id: true,
      costPrice: true,
      retailPrice: true,
      lowStockThreshold: true,
    },
  });

  // Average daily usage per product (last 30 days outbound) via the ONE shared
  // units-out velocity (lib/reports/demand.ts). Migrating onto it FIXES a live prod
  // bug: the former groupBy had `delta < 0` but NO `logType != TRANSFER` filter, so
  // internal warehouse transfers were counted as usage — inflating order-now / stockout
  // counts and shrinking days-of-supply. The shared definition excludes transfers and
  // uses the truthful days-covered denominator (corrections stay counted here — this is
  // units-out, not the reorder predicate).
  const velocityMap = await outboundVelocity(
    products.map((p) => p.id),
    30,
    locationId ? { locationId: parseInt(locationId) } : {},
  );

  // NEW: Query for products with movement in last 90 days (to identify dead stock)
  const ninetyDaysAgo = subDays(new Date(), DEAD_STOCK_DAYS);
  const activeProductIds = await prisma.inventory_logs.groupBy({
    by: ["productId"],
    where: {
      changeTime: { gte: ninetyDaysAgo },
      ...(locationId && { locationId: parseInt(locationId) }),
    },
  });
  const activeProductSet = new Set(activeProductIds.map((p) => p.productId));

  // Initialize counters for new metrics
  let lowStockProducts = 0;
  let healthyProducts = 0;
  let totalInventoryCostValue = 0;
  // W0-RETAIL: a known-retail SUBTOTAL (products with a real retail price only),
  // reported alongside `retailCoverage` so the figure is never read as if every
  // product were priced. A NULL-retail product contributes nothing (it used to be
  // coerced to $0 and folded into a bare total — the exact lie removed here).
  let totalInventoryRetailValue = 0;
  let retailPricedProducts = 0;
  let orderNowCount = 0;
  let orderSoonCount = 0;
  let _watchCount = 0;
  let _okCount = 0;
  let deadStockValue = 0;
  let stockoutRiskCount = 0;
  let daysOfSupplySum = 0;
  let productsWithMovement = 0;

  products.forEach((product) => {
    const quantity = productStockMap.get(product.id) || 0;
    const threshold = effectiveLowStockThreshold(product.lowStockThreshold, lowStockDefault);
    const cost = Number(product.costPrice ?? 0);
    // W0-RETAIL: NULL retail = "unknown", excluded from the known-retail subtotal
    // and the coverage count (an explicit 0 = free is a KNOWN price and counts).
    const retail = product.retailPrice === null ? null : Number(product.retailPrice);
    const productCostValue = quantity * cost;

    // Low-stock count uses the shared INCLUSIVE predicate (R-L13) so this metric
    // converges with the notification boundary and every other counting surface.
    if (isLowStock(quantity, threshold)) {
      lowStockProducts++;
    } else if (quantity > 0) {
      // Healthy = has stock and is not low (mutually exclusive at the boundary).
      healthyProducts++;
    }
    totalInventoryCostValue += productCostValue;
    if (retail !== null) {
      totalInventoryRetailValue += quantity * retail;
      retailPricedProducts++;
    }

    // TRUTHFUL NULL PROPAGATION (spec §2 D4 / W0-1): a product with NO qualifying
    // outbound movement has an UNKNOWN daily-usage rate — null, never a fabricated
    // 0/day. The old `?? 0` collapsed "unknown" into "measured zero", which
    // calculateDaysOfSupply then read as Infinity ("dead stock, never order"). We
    // keep the null and skip the days-of-supply classification when the rate is
    // unknown, so an un-measured product is neither counted as OKAY nor as needing
    // an order (an out-of-stock product is still a certain stockout regardless).
    const avgDailyUsage = velocityMap.get(product.id)?.avgDailyDemand ?? null;
    const daysOfSupply =
      avgDailyUsage !== null ? calculateDaysOfSupply(quantity, avgDailyUsage) : null;

    if (daysOfSupply !== null) {
      const orderStatus = getOrderStatus(daysOfSupply);

      // Count by order status
      switch (orderStatus) {
        case "CRITICAL":
          orderNowCount++;
          break;
        case "NEED_ORDER":
          orderSoonCount++;
          break;
        case "RUNNING_LOW":
          _watchCount++;
          break;
        case "OKAY":
          _okCount++;
          break;
      }

      // Track days of supply for average (exclude infinite/dead stock)
      if (daysOfSupply !== Infinity && daysOfSupply > 0) {
        daysOfSupplySum += daysOfSupply;
        productsWithMovement++;
      }

      // Count stockout risk (usage known -> days-of-supply drives it)
      if (isStockoutRisk(quantity, daysOfSupply)) {
        stockoutRiskCount++;
      }
    } else if (quantity <= 0) {
      // Usage unknown: days-of-supply is unknown, but being out of stock is a
      // certain stockout independent of the (unknown) rate.
      stockoutRiskCount++;
    }

    // NEW: Calculate dead stock value
    const hasRecentMovement = activeProductSet.has(product.id);
    if (isDeadStock(hasRecentMovement, quantity)) {
      deadStockValue += productCostValue;
    }
  });

  // Get activity count within date range
  const recentActivityCount = await prisma.inventory_logs.count({
    where: activityFilter,
  });

  // Calculate derived metrics
  const totalInventoryValue = totalInventoryRetailValue;
  const monthlyCarryingCost = calculateMonthlyCarryingCost(totalInventoryCostValue);
  // Use products at the selected location as denominator (not total products globally)
  const productsAtLocation = locationId ? productStockMap.size : totalProducts;
  const reorderHealthScore =
    productsAtLocation > 0
      ? Math.round((healthyProducts / productsAtLocation) * 100)
      : 100;
  const daysOfSupplyAvg =
    productsWithMovement > 0 ? Math.round(daysOfSupplySum / productsWithMovement) : 0;

  // B8: honest low-stock %-trend backed by product_stock_snapshots.
  // calculateTrend returns a PERCENTAGE (the card renders {value}%); this is the % change in
  // the COUNT of low-stock products between the latest snapshot day and the snapshot 7 days
  // earlier, reusing the SAME shared isLowStock predicate over effective thresholds.
  // Respects selectedLocationId.
  // <2 distinct snapshot days => {value:0, direction:"stable"} so the card never breaks pre-backfill.
  let lowStockTrend: { value: number; direction: "up" | "down" | "stable" } = {
    value: 0,
    direction: "stable",
  };

  // Find the latest snapshot day first (cheap, indexed on dayKey), then bound the heavy
  // per-(product,day) groupBy to just the trend window instead of ALL snapshot history.
  const snapshotLocationFilter = locationId ? { locationId: parseInt(locationId) } : {};
  const latestSnapshot = await prisma.productStockSnapshot.aggregate({
    where: snapshotLocationFilter,
    _max: { dayKey: true },
  });
  const latestSnapshotDay = latestSnapshot._max.dayKey;

  // Per (productId, dayKey) SUM of location snapshots (respecting the selected location),
  // limited to [latestDay - window, latestDay]. Empty when there are no snapshots at all.
  const snapshotRows = latestSnapshotDay
    ? await prisma.productStockSnapshot.groupBy({
        by: ["productId", "dayKey"],
        where: {
          ...snapshotLocationFilter,
          dayKey: { gte: subtractDays(latestSnapshotDay, LOW_STOCK_TREND_WINDOW_DAYS) },
        },
        _sum: { quantity: true },
        orderBy: { dayKey: "asc" },
      })
    : [];

  if (snapshotRows.length > 0) {
    // Effective threshold per product (inheritance model, R-L13).
    const thresholdByProduct = new Map<number, number>();
    products.forEach((p) =>
      thresholdByProduct.set(
        p.id,
        effectiveLowStockThreshold(p.lowStockThreshold, lowStockDefault)
      )
    );
    // Only count APPROVED + non-deleted products (the `products` set above already is).
    const approvedIds = new Set(products.map((p) => p.id));

    // Distinct days, ascending.
    const days = Array.from(new Set(snapshotRows.map((r) => r.dayKey))).sort();
    if (days.length >= 2) {
      const latestDay = days[days.length - 1];
      // The snapshot day closest to (latest - 7) without going past it; fall back to earliest.
      const target = days
        .filter((d) => d <= subtractDays(latestDay, 7))
        .pop() ?? days[0];

      const countLowOn = (day: string): number => {
        let count = 0;
        // per-product daily level on `day` = SUM of its location snapshots (already SUMmed in groupBy by (productId,dayKey)).
        for (const r of snapshotRows) {
          if (r.dayKey !== day) continue;
          if (!approvedIds.has(r.productId)) continue;
          const qty = r._sum.quantity ?? 0;
          const threshold = thresholdByProduct.get(r.productId) ?? lowStockDefault;
          if (isLowStock(qty, threshold)) count++;
        }
        return count;
      };

      if (target !== latestDay) {
        lowStockTrend = calculateTrend(countLowOn(latestDay), countLowOn(target));
      }
    }
  }

  const metrics: MetricsResponse = {
    metrics: {
      // Legacy metrics
      totalProducts,
      activeProducts,
      totalInventoryValue,
      totalInventoryCostValue,
      totalInventoryRetailValue,
      // W0-RETAIL: how many products actually carry a retail price. Names the
      // known-retail subtotal honestly — `priced of N` — so the value is never
      // read as if every product were priced.
      retailCoverage: { priced: retailPricedProducts, of: totalProducts },
      totalStockQuantity,
      lowStockProducts,
      recentActivityCount,
      lastUpdated: new Date(),

      // New warehouse decision metrics
      orderNowCount,
      orderSoonCount,
      daysOfSupplyAvg,
      monthlyCarryingCost,
      deadStockValue,
      stockoutRiskCount,
      reorderHealthScore,
      lowStockTrend,
    },
  };

  return NextResponse.json(metrics);
});
