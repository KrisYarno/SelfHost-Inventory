import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { startOfDay, endOfDay, subDays, format } from "date-fns";

export const dynamic = 'force-dynamic';

interface UserMetrics {
  userId: number;
  username: string;
  dailyActivity: {
    date: string;
    stockIn: number;
    stockOut: number;
    adjustments: number;
    totalActions: number;
  }[];
  topProducts: {
    productId: number;
    productName: string;
    interactions: number;
  }[];
  totalActions: number;
  lastActiveDate: Date;
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get('days') || '7');
    const userId = searchParams.get('userId');
    const locationId = searchParams.get('locationId');

    const endDate = new Date();
    const startDate = subDays(endDate, days);

    // Build user filter
    const userFilter = userId ? { id: parseInt(userId) } : { isApproved: true };

    // Get users
    const users = await prisma.user.findMany({
      where: userFilter,
      select: {
        id: true,
        username: true
      }
    });

    // Get all logs for the period
    const logs = await prisma.inventory_logs.findMany({
      where: {
        changeTime: {
          gte: startDate,
          lte: endDate
        },
        ...(userId && { userId: parseInt(userId) }),
        ...(locationId && { locationId: parseInt(locationId) })
      },
      include: {
        products: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    // Process metrics for each user
    const userMetricsMap = new Map<number, UserMetrics>();

    users.forEach(user => {
      userMetricsMap.set(user.id, {
        userId: user.id,
        username: user.username,
        dailyActivity: [],
        topProducts: [],
        totalActions: 0,
        lastActiveDate: new Date(0)
      });
    });

    // Group logs by user and date
    const userDailyActivity = new Map<string, {
      stockIn: number;
      stockOut: number;
      adjustments: number;
      totalActions: number;
    }>();

    const userProductInteractions = new Map<string, number>();

    logs.forEach(log => {
      const dateKey = format(log.changeTime, 'yyyy-MM-dd');
      const userDateKey = `${log.userId}-${dateKey}`;
      const userProductKey = `${log.userId}-${log.productId}`;

      // Update daily activity
      if (!userDailyActivity.has(userDateKey)) {
        userDailyActivity.set(userDateKey, {
          stockIn: 0,
          stockOut: 0,
          adjustments: 0,
          totalActions: 0
        });
      }

      const activity = userDailyActivity.get(userDateKey)!;
      activity.totalActions++;

      // Categorize activity based on logType and delta
      if (log.logType === 'ADJUSTMENT') {
        if (log.delta > 0) {
          activity.stockIn += log.delta;
        } else if (log.delta < 0) {
          activity.stockOut += Math.abs(log.delta);
        }
        activity.adjustments += Math.abs(log.delta);
      } else if (log.logType === 'TRANSFER') {
        if (log.delta > 0) {
          activity.stockIn += log.delta;
        } else if (log.delta < 0) {
          activity.stockOut += Math.abs(log.delta);
        }
        // Transfers are tracked in stockIn/stockOut but not in adjustments
      }

      // Update product interactions
      userProductInteractions.set(
        userProductKey,
        (userProductInteractions.get(userProductKey) || 0) + 1
      );

      // Update user metrics
      const userMetrics = userMetricsMap.get(log.userId);
      if (userMetrics) {
        userMetrics.totalActions++;
        if (log.changeTime > userMetrics.lastActiveDate) {
          userMetrics.lastActiveDate = log.changeTime;
        }
      }
    });

    // Build final metrics
    const results: UserMetrics[] = [];

    userMetricsMap.forEach((metrics, userId) => {
      // Build daily activity array
      for (let i = 0; i < days; i++) {
        const currentDate = subDays(endDate, i);
        const dateKey = format(currentDate, 'yyyy-MM-dd');
        const userDateKey = `${userId}-${dateKey}`;
        
        const activity = userDailyActivity.get(userDateKey) || {
          stockIn: 0,
          stockOut: 0,
          adjustments: 0,
          totalActions: 0
        };

        metrics.dailyActivity.unshift({
          date: format(currentDate, 'MMM d'),
          ...activity
        });
      }

      // Build top products
      const userProducts: { productId: number; productName: string; interactions: number }[] = [];
      
      logs
        .filter(log => log.userId === userId)
        .forEach(log => {
          const existing = userProducts.find(p => p.productId === log.productId);
          if (existing) {
            existing.interactions++;
          } else {
            userProducts.push({
              productId: log.productId,
              productName: log.products.name,
              interactions: 1
            });
          }
        });

      // Sort and take top 5 products
      userProducts.sort((a, b) => b.interactions - a.interactions);
      metrics.topProducts = userProducts.slice(0, 5);

      if (metrics.totalActions > 0 || !userId) {
        results.push(metrics);
      }
    });

    // Sort by total actions
    results.sort((a, b) => b.totalActions - a.totalActions);

    return NextResponse.json({
      users: results,
      period: {
        startDate,
        endDate,
        days
      }
    });
  } catch (error) {
    console.error("Error fetching user metrics:", error);
    return NextResponse.json(
      { error: "Failed to fetch user metrics" },
      { status: 500 }
    );
  }
}