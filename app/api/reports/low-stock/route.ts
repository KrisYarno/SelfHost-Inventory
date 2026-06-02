import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { LowStockResponse, LowStockAlert } from "@/types/reports";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const searchParams = request.nextUrl.searchParams;
  const defaultThreshold = parseInt(searchParams.get("threshold") || "10");

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

  const recentActivity = await prisma.inventory_logs.findMany({
    where: {
      changeTime: { gte: thirtyDaysAgo },
      delta: { lt: 0 },
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
    const productThreshold = product.lowStockThreshold ?? defaultThreshold;

    if (currentStock < productThreshold) {
      const avgDailyUsage = usageMap.get(product.id) || 0;
      const daysUntilEmpty = avgDailyUsage > 0 ? Math.floor(currentStock / avgDailyUsage) : null;
      const percentageRemaining = productThreshold > 0 ? (currentStock / productThreshold) * 100 : 0;

      alerts.push({
        productId: product.id,
        productName: product.name,
        currentStock,
        threshold: productThreshold,
        percentageRemaining: Math.round(percentageRemaining),
        averageDailyUsage: Math.round(avgDailyUsage * 10) / 10,
        daysUntilEmpty,
      });
    }
  });

  // Sort by percentage remaining (most critical first)
  alerts.sort((a, b) => a.percentageRemaining - b.percentageRemaining);

  const response: LowStockResponse = {
    alerts,
    threshold: defaultThreshold,
  };

  return NextResponse.json(response);
});
