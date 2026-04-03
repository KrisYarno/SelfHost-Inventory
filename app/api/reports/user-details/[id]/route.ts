import { NextRequest, NextResponse } from "next/server";
import { requireApproved } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { format, parseISO, eachDayOfInterval, subDays } from "date-fns";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireApproved();

    const userId = parseInt(params.id);
    if (isNaN(userId)) {
      return NextResponse.json({ error: "Invalid user ID" }, { status: 400 });
    }

    const searchParams = request.nextUrl.searchParams;
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    // Verify user exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Build date filter
    const dateFilter: any = { userId };
    if (startDate) {
      dateFilter.changeTime = { ...dateFilter.changeTime, gte: new Date(startDate) };
    }
    if (endDate) {
      dateFilter.changeTime = { ...dateFilter.changeTime, lte: new Date(endDate) };
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
    // Group by date with stockIn/stockOut/adjustments
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate ? new Date(startDate) : subDays(end, 6);
    const allDates = eachDayOfInterval({ start, end });

    const patternMap = new Map<string, { stockIn: number; stockOut: number; adjustments: number }>();
    allDates.forEach((d) => {
      patternMap.set(format(d, "yyyy-MM-dd"), { stockIn: 0, stockOut: 0, adjustments: 0 });
    });

    transactions.forEach((t) => {
      const dateKey = format(t.changeTime, "yyyy-MM-dd");
      const entry = patternMap.get(dateKey);
      if (!entry) return;

      if (t.delta > 0) entry.stockIn += t.delta;
      if (t.delta < 0) entry.stockOut += Math.abs(t.delta);
      if (t.logType === "ADJUSTMENT") entry.adjustments += Math.abs(t.delta);
    });

    const activityPattern = Array.from(patternMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dateKey, data]) => ({
        date: format(parseISO(dateKey), "MMM dd"),
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
  } catch (error) {
    console.error("Error fetching user details:", error);
    return NextResponse.json({ error: "Failed to fetch user details" }, { status: 500 });
  }
}
