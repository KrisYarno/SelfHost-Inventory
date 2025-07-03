import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { startOfDay, endOfDay, subDays } from "date-fns";

export const dynamic = 'force-dynamic';

interface ProductMovementData {
  productId: number;
  productName: string;
  stockIn: number;
  stockOut: number;
  adjustments: number;
  netMovement: number;
  turnoverRate: number;
  averageStock: number;
  movementFrequency: number;
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get('days') || '30');
    const locationId = searchParams.get('locationId');
    const limit = parseInt(searchParams.get('limit') || '50');

    const endDate = new Date();
    const startDate = subDays(endDate, days);

    // Get all products with their current stock levels
    const currentInventory = await prisma.inventory_logs.groupBy({
      by: ['productId'],
      where: {
        ...(locationId && { locationId: parseInt(locationId) })
      },
      _sum: {
        delta: true
      }
    });

    // Get product details
    const products = await prisma.product.findMany({
      select: {
        id: true,
        name: true
      }
    });

    const productMap = new Map(products.map(p => [p.id, p.name]));
    const currentStockMap = new Map(
      currentInventory.map(item => [item.productId, item._sum.delta || 0])
    );

    // Get all movements in the date range
    const movements = await prisma.inventory_logs.findMany({
      where: {
        changeTime: {
          gte: startDate,
          lte: endDate
        },
        ...(locationId && { locationId: parseInt(locationId) })
      },
      select: {
        productId: true,
        delta: true,
        logType: true,
        changeTime: true
      }
    });

    // Calculate movement metrics for each product
    const productMetrics = new Map<number, ProductMovementData>();

    movements.forEach(movement => {
      const existing = productMetrics.get(movement.productId) || {
        productId: movement.productId,
        productName: productMap.get(movement.productId) || 'Unknown Product',
        stockIn: 0,
        stockOut: 0,
        adjustments: 0,
        netMovement: 0,
        turnoverRate: 0,
        averageStock: 0,
        movementFrequency: 0
      };

      // Categorize movements based on logType and delta
      if (movement.logType === 'ADJUSTMENT') {
        if (movement.delta > 0) {
          existing.stockIn += movement.delta;
        } else if (movement.delta < 0) {
          existing.stockOut += Math.abs(movement.delta);
        }
        existing.adjustments += movement.delta;
      } else if (movement.logType === 'TRANSFER') {
        if (movement.delta > 0) {
          existing.stockIn += movement.delta;
        } else if (movement.delta < 0) {
          existing.stockOut += Math.abs(movement.delta);
        }
        // Transfers are not counted as adjustments
      }

      existing.movementFrequency += 1;
      productMetrics.set(movement.productId, existing);
    });

    // Calculate final metrics
    const results: ProductMovementData[] = [];

    productMetrics.forEach((metrics, productId) => {
      const currentStock = currentStockMap.get(productId) || 0;
      
      // Calculate net movement
      metrics.netMovement = metrics.stockIn - metrics.stockOut + metrics.adjustments;
      
      // Calculate average stock (approximation)
      metrics.averageStock = Math.max(1, (currentStock + (currentStock - metrics.netMovement)) / 2);
      
      // Calculate turnover rate (stock out / average stock)
      metrics.turnoverRate = metrics.stockOut > 0 
        ? (metrics.stockOut / metrics.averageStock) * (365 / days)
        : 0;

      // Calculate movement frequency per day
      metrics.movementFrequency = metrics.movementFrequency / days;

      results.push(metrics);
    });

    // Sort by total movement (most active first)
    results.sort((a, b) => {
      const totalA = a.stockIn + a.stockOut + Math.abs(a.adjustments);
      const totalB = b.stockIn + b.stockOut + Math.abs(b.adjustments);
      return totalB - totalA;
    });

    return NextResponse.json({
      data: results.slice(0, limit),
      period: {
        startDate,
        endDate,
        days
      }
    });
  } catch (error) {
    console.error("Error fetching product movement:", error);
    return NextResponse.json(
      { error: "Failed to fetch product movement data" },
      { status: 500 }
    );
  }
}