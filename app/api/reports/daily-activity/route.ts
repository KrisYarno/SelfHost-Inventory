import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { format, eachDayOfInterval, parseISO } from "date-fns";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const searchParams = request.nextUrl.searchParams;
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");
  const locationId = searchParams.get("locationId");

  // Default to last 7 days if no dates provided
  const end = endDate ? parseISO(endDate) : new Date();
  const start = startDate
    ? parseISO(startDate)
    : new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);

  // Build where clause
  const whereClause: any = {
    changeTime: {
      gte: start,
      lte: end,
    },
  };

  if (locationId) {
    whereClause.locationId = parseInt(locationId);
  }

  // Get all activities
  const activities = await prisma.inventory_logs.findMany({
    where: whereClause,
    select: {
      changeTime: true,
      logType: true,
      delta: true,
    },
  });

  // Group by date and type
  const activityMap = new Map<
    string,
    { stockIn: number; stockOut: number; adjustments: number }
  >();

  // Initialize all dates
  const allDates = eachDayOfInterval({ start, end });
  allDates.forEach((date) => {
    const dateKey = format(date, "yyyy-MM-dd");
    activityMap.set(dateKey, { stockIn: 0, stockOut: 0, adjustments: 0 });
  });

  // Aggregate activities
  activities.forEach((activity) => {
    const dateKey = format(activity.changeTime, "yyyy-MM-dd");
    const dayData = activityMap.get(dateKey) || { stockIn: 0, stockOut: 0, adjustments: 0 };

    // Categorize based on delta value and logType
    if (activity.delta > 0) {
      dayData.stockIn += activity.delta;
    } else if (activity.delta < 0) {
      dayData.stockOut += Math.abs(activity.delta);
    }

    // Count adjustments separately
    if (activity.logType === "ADJUSTMENT") {
      dayData.adjustments += Math.abs(activity.delta);
    }

    activityMap.set(dateKey, dayData);
  });

  // Convert to array format, sorted by raw date key (YYYY-MM-DD) before formatting
  const activityData = Array.from(activityMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, data]) => ({
      date: format(parseISO(date), "MMM dd"),
      stockIn: data.stockIn,
      stockOut: data.stockOut,
      adjustments: data.adjustments,
    }));

  return NextResponse.json({ data: activityData });
});
