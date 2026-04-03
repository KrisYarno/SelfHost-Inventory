import { NextResponse } from "next/server";
import { requireApproved } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { UserActivityResponse, UserActivitySummary } from "@/types/reports";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireApproved();

    // Get all users
    const users = await prisma.user.findMany({
      where: { isApproved: true },
    });

    // Fetch all logs in a single query instead of 5 queries per user
    const allLogs = await prisma.inventory_logs.findMany({
      where: {
        userId: { in: users.map((u) => u.id) },
      },
      select: {
        userId: true,
        delta: true,
        logType: true,
        changeTime: true,
      },
    });

    // Aggregate in JS
    const statsMap = new Map<
      number,
      {
        totalTransactions: number;
        stockInCount: number;
        stockOutCount: number;
        adjustmentCount: number;
        lastActivity: Date | null;
      }
    >();

    for (const log of allLogs) {
      let stats = statsMap.get(log.userId);
      if (!stats) {
        stats = {
          totalTransactions: 0,
          stockInCount: 0,
          stockOutCount: 0,
          adjustmentCount: 0,
          lastActivity: null,
        };
        statsMap.set(log.userId, stats);
      }

      stats.totalTransactions++;
      if (log.delta > 0) stats.stockInCount++;
      if (log.delta < 0) stats.stockOutCount++;
      if (log.logType === "ADJUSTMENT") stats.adjustmentCount++;
      if (!stats.lastActivity || log.changeTime > stats.lastActivity) {
        stats.lastActivity = log.changeTime;
      }
    }

    const userActivities: UserActivitySummary[] = users.map((user) => {
      const stats = statsMap.get(user.id);
      return {
        userId: user.id,
        username: user.username,
        totalTransactions: stats?.totalTransactions || 0,
        stockInCount: stats?.stockInCount || 0,
        stockOutCount: stats?.stockOutCount || 0,
        adjustmentCount: stats?.adjustmentCount || 0,
        lastActivity: stats?.lastActivity || null,
      };
    });

    // Sort by total transactions (most active first)
    userActivities.sort((a, b) => b.totalTransactions - a.totalTransactions);

    const response: UserActivityResponse = {
      users: userActivities,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Error fetching user activity:", error);
    return NextResponse.json({ error: "Failed to fetch user activity" }, { status: 500 });
  }
}
