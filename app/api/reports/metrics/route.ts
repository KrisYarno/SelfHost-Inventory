import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { MetricsResponse } from "@/types/reports";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get total products count
    const totalProducts = await prisma.product.count();
    const activeProducts = totalProducts; // All products are considered active

    // Get current inventory levels and calculate total stock
    const inventoryLevels = await prisma.inventory_logs.groupBy({
      by: ['productId', 'locationId'],
      _sum: {
        delta: true
      }
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

    // Get recent activity count (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentActivityCount = await prisma.inventory_logs.count({
      where: {
        changeTime: {
          gte: sevenDaysAgo
        }
      }
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