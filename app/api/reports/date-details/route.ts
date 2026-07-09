import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { parseDayParam, startOfDayUTC, endOfDayUTC } from "@/lib/reports/date-range";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const searchParams = request.nextUrl.searchParams;
  const dateParam = searchParams.get("date");

  if (!dateParam) {
    return NextResponse.json({ error: "Date parameter required" }, { status: 400 });
  }

  const targetDate = parseDayParam(dateParam);
  const dayStart = startOfDayUTC(targetDate);
  const dayEnd = endOfDayUTC(targetDate);

  // Get all activities for the specified date
  const activities = await prisma.inventory_logs.findMany({
    where: {
      changeTime: {
        gte: dayStart,
        lte: dayEnd,
      },
    },
    include: {
      products: true,
      users: true,
      locations: true,
    },
    orderBy: {
      changeTime: "desc",
    },
  });

  // Calculate totals by type
  let totalStockIn = 0;
  let totalStockOut = 0;
  let totalAdjustments = 0;

  activities.forEach((activity) => {
    // Categorize based on delta value
    if (activity.delta > 0) {
      totalStockIn += activity.delta;
    } else if (activity.delta < 0) {
      totalStockOut += Math.abs(activity.delta);
    }

    // Count adjustments separately
    if (activity.logType === "ADJUSTMENT") {
      totalAdjustments += Math.abs(activity.delta);
    }
  });

  const formattedActivities = activities.map((a) => ({
    id: a.id,
    timestamp: a.changeTime,
    product: a.products?.name || "Unknown",
    type: a.delta > 0 ? "stock_in" : a.delta < 0 ? "stock_out" : "adjustment",
    quantity: a.delta,
    user: a.users?.username || "Unknown",
    location: a.locations?.name || "Unknown",
    notes: "",
  }));

  return NextResponse.json({
    date: dateParam,
    totalStockIn,
    totalStockOut,
    totalAdjustments,
    activities: formattedActivities,
  });
});
