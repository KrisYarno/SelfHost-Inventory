import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { startOfDay, endOfDay, parseISO } from "date-fns";

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const dateParam = searchParams.get("date");
    
    if (!dateParam) {
      return NextResponse.json({ error: "Date parameter required" }, { status: 400 });
    }

    const targetDate = parseISO(dateParam);
    const dayStart = startOfDay(targetDate);
    const dayEnd = endOfDay(targetDate);

    // Get all activities for the specified date
    const activities = await prisma.inventory_logs.findMany({
      where: {
        changeTime: {
          gte: dayStart,
          lte: dayEnd
        }
      },
      include: {
        products: true,
        users: true,
        locations: true,
      },
      orderBy: {
        changeTime: 'desc'
      }
    });

    // Calculate totals by type
    let totalStockIn = 0;
    let totalStockOut = 0;
    let totalAdjustments = 0;

    activities.forEach(activity => {
      // Categorize based on delta value
      if (activity.delta > 0) {
        totalStockIn += activity.delta;
      } else if (activity.delta < 0) {
        totalStockOut += Math.abs(activity.delta);
      }
      
      // Count adjustments separately
      if (activity.logType === 'ADJUSTMENT') {
        totalAdjustments += Math.abs(activity.delta);
      }
    });

    const formattedActivities = activities.map(a => ({
      id: a.id,
      timestamp: a.changeTime,
      product: a.products?.name || 'Unknown',
      type: a.delta > 0 ? 'stock_in' : a.delta < 0 ? 'stock_out' : 'adjustment',
      quantity: a.delta,
      user: a.users?.username || 'Unknown',
      location: a.locations?.name || 'Unknown',
      notes: ''
    }));

    return NextResponse.json({
      date: dateParam,
      totalStockIn,
      totalStockOut,
      totalAdjustments,
      activities: formattedActivities
    });
  } catch (error) {
    console.error("Error fetching date details:", error);
    return NextResponse.json(
      { error: "Failed to fetch date details" },
      { status: 500 }
    );
  }
}