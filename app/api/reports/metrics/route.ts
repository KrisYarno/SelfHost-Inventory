import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { MetricsResponse } from "@/types/reports";
import { subDays } from "date-fns";
import {
  calculateDaysOfSupply,
  getOrderStatus,
  calculateMonthlyCarryingCost,
  calculateReorderHealthScore,
  calculateTrend,
  isDeadStock,
  isStockoutRisk,
  DEAD_STOCK_DAYS,
} from "@/lib/metrics/warehouse-metrics";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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

    // Get total products count
    const totalProducts = await prisma.product.count();
    const activeProducts = totalProducts; // All products are considered active

    // Get current inventory levels and calculate total stock
    const productLocations = await prisma.product_locations.findMany({
      where: locationFilter,
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
    let totalInventoryCostValue = 0;
    let totalInventoryRetailValue = 0;
    let orderNowCount = 0;
    let orderSoonCount = 0;
    let watchCount = 0;
    let okCount = 0;
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
          watchCount++;
          break;
        case "OKAY":
          okCount++;
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
    const reorderHealthScore = calculateReorderHealthScore({
      orderNow: orderNowCount,
      orderSoon: orderSoonCount,
      watch: watchCount,
      ok: okCount,
    });
    const daysOfSupplyAvg =
      productsWithMovement > 0 ? Math.round(daysOfSupplySum / productsWithMovement) : 0;

    // Calculate trend (compare to previous period if we have dates)
    let lowStockTrend: { value: number; direction: "up" | "down" | "stable" } | undefined;
    if (startDate) {
      const periodStart = new Date(startDate);
      const periodEnd = endDate ? new Date(endDate) : new Date();
      const periodDays = Math.ceil(
        (periodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24)
      );

      if (periodDays > 0) {
        // For trend, we compare current low stock count to what it was at period start
        // This is an approximation - a more accurate approach would track historical snapshots
        // For now, we just show stable if we can't determine trend
        lowStockTrend = { value: 0, direction: "stable" };
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
  } catch (error) {
    console.error("Error fetching metrics:", error);
    return NextResponse.json({ error: "Failed to fetch metrics" }, { status: 500 });
  }
}
