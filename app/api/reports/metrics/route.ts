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

    let lowStockProducts = 0;
    let totalInventoryCostValue = 0;
    let totalInventoryRetailValue = 0;

    products.forEach((product) => {
      const quantity = productStockMap.get(product.id) || 0;
      const threshold = product.lowStockThreshold ?? lowStockThreshold;
      if (quantity > 0 && quantity < threshold) {
        lowStockProducts++;
      }

      const cost = Number(product.costPrice ?? 0);
      const retail = Number(product.retailPrice ?? 0);
      totalInventoryCostValue += quantity * cost;
      totalInventoryRetailValue += quantity * retail;
    });

    // Get activity count within date range
    const recentActivityCount = await prisma.inventory_logs.count({
      where: activityFilter
    });

    const totalInventoryValue = totalInventoryRetailValue;

    const metrics: MetricsResponse = {
      metrics: {
        totalProducts,
        activeProducts,
        totalInventoryValue,
        totalInventoryCostValue,
        totalInventoryRetailValue,
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
