import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { format } from "date-fns";
import {
  parseReportDateRange,
  formatDayKey,
  eachDayUTC,
} from "@/lib/reports/date-range";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const searchParams = request.nextUrl.searchParams;
  const locationId = searchParams.get("locationId");

  // Default to last 7 days if no dates provided (UTC day bucketing)
  const { start, end } = parseReportDateRange(searchParams, { defaultLastDays: 7 });

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

  // Get all inventory changes grouped by date
  const inventoryChanges = await prisma.inventory_logs.groupBy({
    by: ["changeTime"],
    _sum: {
      delta: true,
    },
    where: whereClause,
    orderBy: {
      changeTime: "asc",
    },
  });

  // Get initial stock level before the start date
  const initialStock = await prisma.inventory_logs.aggregate({
    where: {
      changeTime: {
        lt: start,
      },
      ...(locationId && { locationId: parseInt(locationId) }),
    },
    _sum: {
      delta: true,
    },
  });

  let runningTotal = initialStock._sum.delta || 0;
  const dailyDeltas = new Map<string, number>();

  // First, aggregate all deltas by date
  inventoryChanges.forEach((change) => {
    const dateKey = formatDayKey(change.changeTime);
    const existingDelta = dailyDeltas.get(dateKey) || 0;
    dailyDeltas.set(dateKey, existingDelta + (change._sum.delta || 0));
  });

  // Then calculate running totals from the aggregated daily deltas
  const dateMap = new Map<string, number>();
  const sortedDates = Array.from(dailyDeltas.keys()).sort();

  sortedDates.forEach((dateKey) => {
    runningTotal += dailyDeltas.get(dateKey) || 0;
    dateMap.set(dateKey, runningTotal);
  });

  // Fill in missing dates
  const allDates = eachDayUTC(start, end);
  let lastValue = initialStock._sum.delta || 0;

  const trendData = allDates.map((date) => {
    const dateKey = formatDayKey(date);
    const value = dateMap.get(dateKey);

    if (value !== undefined) {
      lastValue = value;
    }

    return {
      date: format(date, "MMM dd"),
      quantity: lastValue,
    };
  });

  return NextResponse.json({ data: trendData });
});
