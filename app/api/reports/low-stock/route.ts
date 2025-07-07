import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { LowStockResponse, LowStockAlert } from "@/types/reports";

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const threshold = parseInt(searchParams.get("threshold") || "10");

    // Get all products (excluding soft deleted)
    const products = await prisma.product.findMany({
      where: {
        deletedAt: null,
      },
    });

    // Get current inventory levels
    const inventoryLevels = await prisma.inventory_logs.groupBy({
      by: ['productId'],
      _sum: {
        delta: true
      }
    });

    // Create a map of current stock levels
    const stockMap = new Map<number, number>();
    inventoryLevels.forEach(level => {
      stockMap.set(level.productId, level._sum.delta || 0);
    });

    // Get activity from last 30 days to calculate usage
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentActivity = await prisma.inventory_logs.findMany({
      where: {
        changeTime: { gte: thirtyDaysAgo },
        delta: { lt: 0 }
      },
      select: {
        productId: true,
        delta: true,
        changeTime: true
      }
    });

    // Calculate average daily usage per product
    const usageMap = new Map<number, number>();
    const productUsage = new Map<number, number[]>();

    recentActivity.forEach(log => {
      if (!productUsage.has(log.productId)) {
        productUsage.set(log.productId, []);
      }
      productUsage.get(log.productId)!.push(Math.abs(log.delta));
    });

    productUsage.forEach((usages, productId) => {
      const totalUsage = usages.reduce((sum, usage) => sum + usage, 0);
      const avgDailyUsage = totalUsage / 30;
      usageMap.set(productId, avgDailyUsage);
    });

    // Build low stock alerts
    const alerts: LowStockAlert[] = [];

    products.forEach(product => {
      const currentStock = stockMap.get(product.id) || 0;
      
      if (currentStock < threshold) {
        const avgDailyUsage = usageMap.get(product.id) || 0;
        const daysUntilEmpty = avgDailyUsage > 0 ? Math.floor(currentStock / avgDailyUsage) : null;
        const percentageRemaining = threshold > 0 ? (currentStock / threshold) * 100 : 0;

        alerts.push({
          productId: product.id,
          productName: product.name,
          currentStock,
          threshold,
          percentageRemaining: Math.round(percentageRemaining),
          averageDailyUsage: Math.round(avgDailyUsage * 10) / 10,
          daysUntilEmpty
        });
      }
    });

    // Sort by percentage remaining (most critical first)
    alerts.sort((a, b) => a.percentageRemaining - b.percentageRemaining);

    const response: LowStockResponse = {
      alerts,
      threshold
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Error fetching low stock alerts:", error);
    return NextResponse.json(
      { error: "Failed to fetch low stock alerts" },
      { status: 500 }
    );
  }
}