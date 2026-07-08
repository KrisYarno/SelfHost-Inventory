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

  const lowStockThreshold = 10;
  const products = await prisma.product.findMany({
    where: { deletedAt: null, approvalStatus: "APPROVED" },
    select: {
      id: true,
      costPrice: true,
      retailPrice: true,
      lowStockThreshold: true,
    },
  });

  // NEW: Query for average daily usage per product (last 30 days outbound)
  const thirtyDaysAgo = subDays(new Date(), 30);
  const usageByProduct = await prisma.inventory_logs.groupBy({
    by: ["productId"],
    where: {
      changeTime: { gte: thirtyDaysAgo },
      delta: { lt: 0 }, // Only outbound (negative deltas)
      ...(locationId && { locationId: parseInt(locationId) }),
    },
    _sum: { delta: true },
  });

  // Convert to Map: productId -> avgDailyUsage
  const avgDailyUsageMap = new Map<number, number>();
  usageByProduct.forEach((item) => {
    const totalOut = Math.abs(item._sum.delta || 0);
    avgDailyUsageMap.set(item.productId, totalOut / 30);
  });

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
  let totalInventoryRetailValue = 0;
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
    const threshold = product.lowStockThreshold ?? lowStockThreshold;
    const cost = Number(product.costPrice ?? 0);
    const retail = Number(product.retailPrice ?? 0);
    const productCostValue = quantity * cost;

    // Legacy metrics
    if (quantity > 0 && quantity < threshold) {
      lowStockProducts++;
    }
    // Health score: product is healthy if stock is at or above its threshold
    if (quantity >= threshold) {
      healthyProducts++;
    }
    totalInventoryCostValue += productCostValue;
    totalInventoryRetailValue += quantity * retail;

    // NEW: Calculate days of supply and order status
    const avgDailyUsage = avgDailyUsageMap.get(product.id) || 0;
    const daysOfSupply = calculateDaysOfSupply(quantity, avgDailyUsage);
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

    // NEW: Calculate dead stock value
    const hasRecentMovement = activeProductSet.has(product.id);
    if (isDeadStock(hasRecentMovement, quantity)) {
      deadStockValue += productCostValue;
    }

    // NEW: Count stockout risk
    if (isStockoutRisk(quantity, daysOfSupply)) {
      stockoutRiskCount++;
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

  // B8: honest low-stock %-trend (proxy) backed by product_stock_snapshots.
  // calculateTrend returns a PERCENTAGE (the card renders {value}%); this is the % change in
  // the COUNT of low-stock products between the latest snapshot day and the snapshot 7 days
  // earlier, reusing the EXISTING lowStockProducts predicate. Respects selectedLocationId.
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
    // Threshold per product (reuse the predicate's source: product.lowStockThreshold ?? 10).
    const thresholdByProduct = new Map<number, number>();
    products.forEach((p) =>
      thresholdByProduct.set(p.id, p.lowStockThreshold ?? lowStockThreshold)
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
          const threshold = thresholdByProduct.get(r.productId) ?? lowStockThreshold;
          if (qty > 0 && qty < threshold) count++;
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
