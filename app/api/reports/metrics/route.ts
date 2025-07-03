import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { MetricsResponse } from "@/types/reports";

export const dynamic = 'force-dynamic';

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
    const dateFilter: any = {};
    if (startDate) {
      dateFilter.changeTime = { ...dateFilter.changeTime, gte: new Date(startDate) };
    }
    if (endDate) {
      dateFilter.changeTime = { ...dateFilter.changeTime, lte: new Date(endDate) };
    }
    if (locationId) {
      dateFilter.locationId = parseInt(locationId);
    }

    // Get total products count
    const totalProducts = await prisma.product.count();
    const activeProducts = totalProducts; // All products are considered active

    // Get current inventory levels and calculate total stock
    const inventoryLevels = await prisma.inventory_logs.groupBy({
      by: ['productId', 'locationId'],
      _sum: {
        delta: true
      },
      where: dateFilter
    });

    // Calculate total stock quantity
    let totalStockQuantity = 0;
    const productStockMap = new Map<number, number>();

    inventoryLevels.forEach(level => {
      const quantity = level._sum.delta || 0;
      totalStockQuantity += quantity;
      
      const currentStock = productStockMap.get(level.productId) || 0;
      productStockMap.set(level.productId, currentStock + quantity);
    });

    // Count products with low stock (less than 10 units)
    const lowStockThreshold = 10;
    let lowStockProducts = 0;
    productStockMap.forEach(quantity => {
      if (quantity < lowStockThreshold && quantity > 0) {
        lowStockProducts++;
      }
    });

    // Get activity count within date range
    const recentActivityCount = await prisma.inventory_logs.count({
      where: dateFilter
    });

    // Calculate total inventory value (placeholder - would need cost data)
    // For now, we'll use a placeholder calculation
    const totalInventoryValue = totalStockQuantity * 10; // $10 average value per unit

    const metrics: MetricsResponse = {
      metrics: {
        totalProducts,
        activeProducts,
        totalInventoryValue,
        totalStockQuantity,
        lowStockProducts,
        recentActivityCount,
        lastUpdated: new Date()
      }
    };

    return NextResponse.json(metrics);
  } catch (error) {
    console.error("Error fetching metrics:", error);
    return NextResponse.json(
      { error: "Failed to fetch metrics" },
      { status: 500 }
    );
  }
}