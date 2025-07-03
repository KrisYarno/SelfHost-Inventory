import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { format, eachDayOfInterval, parseISO } from "date-fns";

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

    // Default to last 7 days if no dates provided
    const end = endDate ? parseISO(endDate) : new Date();
    const start = startDate ? parseISO(startDate) : new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);

    // Build where clause
    const whereClause: any = {
      changeTime: {
        gte: start,
        lte: end
      }
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
        delta: true
      }
    });

    // Group by date and type
    const activityMap = new Map<string, { stockIn: number; stockOut: number; adjustments: number }>();
    
    // Initialize all dates
    const allDates = eachDayOfInterval({ start, end });
    allDates.forEach(date => {
      const dateKey = format(date, 'yyyy-MM-dd');
      activityMap.set(dateKey, { stockIn: 0, stockOut: 0, adjustments: 0 });
    });

    // Aggregate activities
    activities.forEach(activity => {
      const dateKey = format(activity.changeTime, 'yyyy-MM-dd');
      const dayData = activityMap.get(dateKey) || { stockIn: 0, stockOut: 0, adjustments: 0 };
      
      // Categorize based on delta value and logType
      if (activity.delta > 0) {
        dayData.stockIn += activity.delta;
      } else if (activity.delta < 0) {
        dayData.stockOut += Math.abs(activity.delta);
      }
      
      // Count adjustments separately
      if (activity.logType === 'ADJUSTMENT') {
        dayData.adjustments += Math.abs(activity.delta);
      }
      
      activityMap.set(dateKey, dayData);
    });

    // Convert to array format
    const activityData = Array.from(activityMap.entries())
      .map(([date, data]) => ({
        date: format(parseISO(date), 'MMM dd'),
        stockIn: data.stockIn,
        stockOut: data.stockOut,
        adjustments: data.adjustments
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return NextResponse.json({ data: activityData });
  } catch (error) {
    console.error("Error fetching daily activity:", error);
    return NextResponse.json(
      { error: "Failed to fetch daily activity" },
      { status: 500 }
    );
  }
}