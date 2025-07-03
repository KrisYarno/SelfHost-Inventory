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

    // Get all inventory changes grouped by date
    const inventoryChanges = await prisma.inventory_logs.groupBy({
      by: ['changeTime'],
      _sum: {
        delta: true
      },
      where: whereClause,
      orderBy: {
        changeTime: 'asc'
      }
    });

    // Get initial stock level before the start date
    const initialStock = await prisma.inventory_logs.aggregate({
      where: {
        changeTime: {
          lt: start
        },
        ...(locationId && { locationId: parseInt(locationId) })
      },
      _sum: {
        delta: true
      }
    });

    let runningTotal = initialStock._sum.delta || 0;
    const dateMap = new Map<string, number>();

    // Calculate running totals
    inventoryChanges.forEach(change => {
      const dateKey = format(change.changeTime, 'yyyy-MM-dd');
      const currentValue = dateMap.get(dateKey) || runningTotal;
      dateMap.set(dateKey, currentValue + (change._sum.delta || 0));
      runningTotal = currentValue + (change._sum.delta || 0);
    });

    // Fill in missing dates
    const allDates = eachDayOfInterval({ start, end });
    let lastValue = initialStock._sum.delta || 0;
    
    const trendData = allDates.map(date => {
      const dateKey = format(date, 'yyyy-MM-dd');
      const value = dateMap.get(dateKey);
      
      if (value !== undefined) {
        lastValue = value;
      }
      
      return {
        date: format(date, 'MMM dd'),
        quantity: lastValue
      };
    });

    return NextResponse.json({ data: trendData });
  } catch (error) {
    console.error("Error fetching inventory trends:", error);
    return NextResponse.json(
      { error: "Failed to fetch inventory trends" },
      { status: 500 }
    );
  }
}