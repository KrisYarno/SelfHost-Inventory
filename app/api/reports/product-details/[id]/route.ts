import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { format } from "date-fns";

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const productId = parseInt(params.id);
    if (isNaN(productId)) {
      return NextResponse.json({ error: "Invalid product ID" }, { status: 400 });
    }

    const searchParams = request.nextUrl.searchParams;
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    // Build where clause for date filtering
    const dateFilter: any = { productId };
    if (startDate) {
      dateFilter.changeTime = { ...dateFilter.changeTime, gte: new Date(startDate) };
    }
    if (endDate) {
      dateFilter.changeTime = { ...dateFilter.changeTime, lte: new Date(endDate) };
    }

    // Get product details
    const product = await prisma.product.findUnique({
      where: { id: productId },
    });

    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    // Get current stock across all locations
    const stockLevels = await prisma.inventory_logs.groupBy({
      by: ['locationId'],
      _sum: {
        delta: true
      },
      where: { productId }
    });

    const currentStock = stockLevels.reduce((sum, level) => sum + (level._sum.delta || 0), 0);

    // Get transactions within date range
    const transactions = await prisma.inventory_logs.findMany({
      where: dateFilter,
      include: {
        users: true,
        locations: true,
      },
      orderBy: {
        changeTime: 'desc'
      },
      take: 50
    });

    // Calculate 30-day movement
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const movement = await prisma.inventory_logs.aggregate({
      where: {
        productId,
        changeTime: { gte: thirtyDaysAgo }
      },
      _sum: {
        delta: true
      }
    });

    // Get daily trend data - using simpler approach
    const dailyChanges = await prisma.inventory_logs.groupBy({
      by: ['changeTime'],
      _sum: {
        delta: true
      },
      where: dateFilter,
      orderBy: {
        changeTime: 'asc'
      }
    });

    // Calculate cumulative totals
    let runningTotal = 0;
    const dailyTrend = dailyChanges.map(change => {
      runningTotal += change._sum.delta || 0;
      return {
        date: format(change.changeTime, 'MMM dd'),
        quantity: runningTotal
      };
    });

    const formattedTransactions = transactions.map(t => ({
      id: t.id,
      date: t.changeTime,
      type: t.logType,
      quantity: t.delta,
      user: t.users?.username || 'Unknown',
      location: t.locations?.name || 'Unknown',
      notes: ''
    }));

    return NextResponse.json({
      productName: product.name,
      currentStock,
      movement30Days: movement._sum.delta || 0,
      transactions: formattedTransactions,
      dailyTrend: dailyTrend || []
    });
  } catch (error) {
    console.error("Error fetching product details:", error);
    return NextResponse.json(
      { error: "Failed to fetch product details" },
      { status: 500 }
    );
  }
}