import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { syncProcessingOrders } from '@/lib/woocommerce/sync';
import prisma from '@/lib/prisma';

export async function POST(request: NextRequest) {
  try {
    // Check for cron secret if present
    const cronSecret = request.headers.get('x-cron-secret');
    if (cronSecret && cronSecret === process.env.CRON_SECRET) {
      // Valid cron request
      const result = await syncProcessingOrders(prisma);
      return NextResponse.json({
        success: true,
        message: 'WooCommerce sync completed',
        ...result,
      });
    }

    // Otherwise, check for authenticated admin user
    const session = await getServerSession(authOptions);
    if (!session || !session.user.isAdmin) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Execute sync
    const result = await syncProcessingOrders(prisma);

    return NextResponse.json({
      success: true,
      message: 'WooCommerce sync completed',
      ...result,
    });
  } catch (error) {
    console.error('WooCommerce sync error:', error);
    return NextResponse.json(
      {
        error: 'Sync failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

// GET endpoint to check sync status
export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !session.user.isAdmin) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Get last sync log
    const lastSync = await prisma.syncLog.findFirst({
      where: { syncType: 'woocommerce_orders' },
      orderBy: { syncedAt: 'desc' },
    });

    // Get order statistics
    const orderStats = await prisma.order.groupBy({
      by: ['status'],
      _count: true,
    });

    const totalOrders = await prisma.order.count();
    const totalOrderItems = await prisma.orderItem.count();

    return NextResponse.json({
      lastSync: lastSync ? {
        syncedAt: lastSync.syncedAt,
        recordsProcessed: lastSync.recordsProcessed,
        success: lastSync.success,
        errors: lastSync.errors,
      } : null,
      statistics: {
        totalOrders,
        totalOrderItems,
        ordersByStatus: orderStats.reduce((acc, stat) => {
          acc[stat.status] = stat._count;
          return acc;
        }, {} as Record<string, number>),
      },
    });
  } catch (error) {
    console.error('Error fetching sync status:', error);
    return NextResponse.json(
      {
        error: 'Failed to fetch sync status',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}