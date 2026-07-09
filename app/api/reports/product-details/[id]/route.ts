import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { format } from "date-fns";
import { parseReportDateRange, formatDayKey, parseDayKey } from "@/lib/reports/date-range";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest, { params }: { params: { id: string } }) => {
  await requireApproved();

  const productId = parseInt(params.id);
  if (isNaN(productId)) {
    return NextResponse.json({ error: "Invalid product ID" }, { status: 400 });
  }

  const searchParams = request.nextUrl.searchParams;

  // Build where clause for date filtering (UTC; bounds applied only when provided)
  const { start, end } = parseReportDateRange(searchParams);
  const dateFilter: any = { productId };
  if (start) {
    dateFilter.changeTime = { ...dateFilter.changeTime, gte: start };
  }
  if (end) {
    dateFilter.changeTime = { ...dateFilter.changeTime, lte: end };
  }

  // Get product details
  const product = await prisma.product.findUnique({
    where: { id: productId },
  });

  if (!product) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  // Get current stock from product_locations (source of truth)
  const stockLevels = await prisma.product_locations.findMany({
    where: { productId },
    select: { quantity: true },
  });

  const currentStock = stockLevels.reduce((sum, level) => sum + level.quantity, 0);

  // Get transactions within date range
  const transactions = await prisma.inventory_logs.findMany({
    where: dateFilter,
    include: {
      users: true,
      locations: true,
    },
    orderBy: {
      changeTime: "desc",
    },
    take: 50,
  });

  // Calculate 30-day movement
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const movement = await prisma.inventory_logs.aggregate({
    where: {
      productId,
      changeTime: { gte: thirtyDaysAgo },
    },
    _sum: {
      delta: true,
    },
  });

  // Get daily trend data - aggregate by date (YYYY-MM-DD) instead of exact timestamp
  const dailyLogs = await prisma.inventory_logs.findMany({
    where: dateFilter,
    select: { changeTime: true, delta: true },
    orderBy: { changeTime: "asc" },
  });

  // Group deltas by date
  const dailyMap = new Map<string, number>();
  for (const log of dailyLogs) {
    const dateKey = formatDayKey(log.changeTime);
    dailyMap.set(dateKey, (dailyMap.get(dateKey) || 0) + log.delta);
  }

  // Calculate cumulative totals
  let runningTotal = 0;
  const dailyTrend = Array.from(dailyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dateKey, delta]) => {
      runningTotal += delta;
      return {
        date: format(parseDayKey(dateKey), "MMM dd"),
        quantity: runningTotal,
      };
    });

  const formattedTransactions = transactions.map((t) => ({
    id: t.id,
    date: t.changeTime,
    type: t.logType,
    quantity: t.delta,
    user: t.users?.username || "Unknown",
    location: t.locations?.name || "Unknown",
    notes: "",
  }));

  return NextResponse.json({
    productName: product.name,
    currentStock,
    movement30Days: movement._sum.delta || 0,
    transactions: formattedTransactions,
    dailyTrend: dailyTrend || [],
  });
});
