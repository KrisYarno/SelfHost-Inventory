import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { format } from "date-fns";
import {
  parseReportDateRange,
  formatDayKey,
  parseDayKey,
  eachDayUTC,
} from "@/lib/reports/date-range";
import { ADJUSTMENT_LIKE } from "@/lib/reports/log-buckets";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest, { params }: { params: { id: string } }) => {
  await requireApproved();

  const userId = parseInt(params.id);
  if (isNaN(userId)) {
    return NextResponse.json({ error: "Invalid user ID" }, { status: 400 });
  }

  const searchParams = request.nextUrl.searchParams;

  // Verify user exists
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Build date filter (UTC; bounds applied only when provided)
  const { start: filterStart, end: filterEnd } = parseReportDateRange(searchParams);
  const dateFilter: any = { userId };
  if (filterStart) {
    dateFilter.changeTime = { ...dateFilter.changeTime, gte: filterStart };
  }
  if (filterEnd) {
    dateFilter.changeTime = { ...dateFilter.changeTime, lte: filterEnd };
  }

  // Get user's recent transactions
  const transactions = await prisma.inventory_logs.findMany({
    where: dateFilter,
    include: {
      products: { select: { name: true } },
      locations: { select: { name: true } },
    },
    orderBy: { changeTime: "desc" },
    take: 100,
  });

  // Format activities (matches DrillDownModal's renderUserDrillDown expectations)
  const activities = transactions.map((t) => ({
    id: t.id,
    date: t.changeTime,
    product: t.products?.name || "Unknown",
    type: t.logType,
    quantity: t.delta,
    location: t.locations?.name || "Unknown",
    notes: "",
  }));

  // Build activity pattern (for the bar chart tab)
  // Group by date with stockIn/stockOut/adjustments (UTC; default last 7 days)
  const { start, end } = parseReportDateRange(searchParams, { defaultLastDays: 7 });
  const allDates = eachDayUTC(start, end);

  const patternMap = new Map<string, { stockIn: number; stockOut: number; adjustments: number }>();
  allDates.forEach((d) => {
    patternMap.set(formatDayKey(d), { stockIn: 0, stockOut: 0, adjustments: 0 });
  });

  transactions.forEach((t) => {
    const dateKey = formatDayKey(t.changeTime);
    const entry = patternMap.get(dateKey);
    if (!entry) return;

    if (t.delta > 0) entry.stockIn += t.delta;
    if (t.delta < 0) entry.stockOut += Math.abs(t.delta);
    // ADJUSTMENT + CORRECTION + COUNT count as adjustments; STOCK_IN/SALE are flow, not correction.
    if ((ADJUSTMENT_LIKE as readonly string[]).includes(t.logType)) entry.adjustments += Math.abs(t.delta);
  });

  const activityPattern = Array.from(patternMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dateKey, data]) => ({
      date: format(parseDayKey(dateKey), "MMM dd"),
      stockIn: data.stockIn,
      stockOut: data.stockOut,
      adjustments: data.adjustments,
    }));

  // Summary stats
  const totalActions = transactions.length;
  const stockInTotal = transactions.filter((t) => t.delta > 0).reduce((s, t) => s + t.delta, 0);
  const stockOutTotal = transactions.filter((t) => t.delta < 0).reduce((s, t) => s + Math.abs(t.delta), 0);

  return NextResponse.json({
    username: user.username,
    totalActions,
    stockInTotal,
    stockOutTotal,
    activities,
    activityPattern,
  });
});
