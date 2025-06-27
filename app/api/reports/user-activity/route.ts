import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { UserActivityResponse, UserActivitySummary } from "@/types/reports";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get all users
    const users = await prisma.user.findMany({
      where: { isApproved: true }
    });

    // Get activity summary for each user
    const userActivities: UserActivitySummary[] = await Promise.all(
      users.map(async (user) => {
        // Get transaction counts by type
        const [totalCount, stockInCount, stockOutCount, adjustmentCount, lastLog] = await Promise.all([
          prisma.inventory_logs.count({
            where: { userId: user.id }
          }),
          prisma.inventory_logs.count({
            where: {
              userId: user.id,
              delta: { gt: 0 }
            }
          }),
          prisma.inventory_logs.count({
            where: {
              userId: user.id,
              delta: { lt: 0 }
            }
          }),
          prisma.inventory_logs.count({
            where: {
              userId: user.id,
              logType: 'ADJUSTMENT'
            }
          }),
          prisma.inventory_logs.findFirst({
            where: { userId: user.id },
            orderBy: { changeTime: 'desc' },
            select: { changeTime: true }
          })
        ]);

        return {
          userId: user.id,
          username: user.username,
          totalTransactions: totalCount,
          stockInCount,
          stockOutCount,
          adjustmentCount,
          lastActivity: lastLog?.changeTime || new Date()
        };
      })
    );

    // Sort by total transactions (most active first)
    userActivities.sort((a, b) => b.totalTransactions - a.totalTransactions);

    const response: UserActivityResponse = {
      users: userActivities
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Error fetching user activity:", error);
    return NextResponse.json(
      { error: "Failed to fetch user activity" },
      { status: 500 }
    );
  }
}