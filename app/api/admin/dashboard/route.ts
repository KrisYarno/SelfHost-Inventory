import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    
    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get metrics in parallel for performance
    const [
      totalProducts,
      userStats,
      stockStats,
      recentTransactions,
      topMovingProducts,
      recentActivity
    ] = await Promise.all([
      // Total unique products
      prisma.product.count(),
      
      // User statistics
      prisma.user.groupBy({
        by: ['isApproved'],
        _count: true,
      }),
      
      // Stock statistics across all locations
      prisma.$queryRaw<Array<{ status: string; count: bigint }>>`
        SELECT 
          CASE 
            WHEN total_quantity = 0 THEN 'out_of_stock'
            WHEN total_quantity <= 10 THEN 'low_stock'
            ELSE 'in_stock'
          END as status,
          COUNT(*) as count
        FROM (
          SELECT 
            productId,
            SUM(quantity) as total_quantity
          FROM product_locations
          GROUP BY productId
        ) as product_totals
        GROUP BY 
          CASE 
            WHEN total_quantity = 0 THEN 'out_of_stock'
            WHEN total_quantity <= 10 THEN 'low_stock'
            ELSE 'in_stock'
          END
      `,
      
      // Recent transactions (last 24 hours)
      prisma.inventory_logs.count({
        where: {
          changeTime: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
          }
        }
      }),
      
      // Top moving products (last 7 days)
      prisma.$queryRaw<Array<{ productId: number; name: string; movement: bigint }>>`
        SELECT 
          p.id as productId,
          p.name,
          ABS(SUM(il.delta)) as movement
        FROM inventory_logs il
        INNER JOIN products p ON il.productId = p.id
        WHERE il.changeTime >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        GROUP BY p.id, p.name
        ORDER BY movement DESC
        LIMIT 10
      `,
      
      // Recent activity
      prisma.inventory_logs.findMany({
        take: 10,
        orderBy: { changeTime: 'desc' },
        include: {
          users: true,
          products: true,
          locations: true
        }
      })
    ]);

    // Process user stats
    const activeUsers = userStats.find((stat: { isApproved: boolean; _count: number }) => stat.isApproved === true)?._count || 0;
    const pendingUsers = userStats.find((stat: { isApproved: boolean; _count: number }) => stat.isApproved === false)?._count || 0;
    const totalUsers = activeUsers + pendingUsers;

    // Process stock stats
    const stockStatsMap = stockStats.reduce((
      acc: Record<string, number>,
      stat: { status: string; count: bigint }
    ) => {
      acc[stat.status] = Number(stat.count);
      return acc;
    }, {} as Record<string, number>);

    // Format response
    const metrics = {
      totalProducts,
      totalUsers,
      activeUsers,
      pendingUsers,
      lowStockProducts: stockStatsMap.low_stock || 0,
      outOfStockProducts: stockStatsMap.out_of_stock || 0,
      recentTransactions,
      topMovingProducts: topMovingProducts.map(p => ({
        id: p.productId,
        name: p.name,
        movement: Number(p.movement)
      })),
      recentActivity: recentActivity.map(log => ({
        id: log.id,
        user: log.users.username,
        action: log.delta > 0 ? 'Added to' : 'Removed from',
        product: log.products.name,
        quantity: log.delta,
        timestamp: log.changeTime.toISOString(),
        location: log.locations?.name || 'Unknown'
      }))
    };

    return NextResponse.json(metrics);
  } catch (error) {
    console.error('Error fetching dashboard metrics:', error);
    return NextResponse.json(
      { error: "Failed to fetch dashboard metrics" },
      { status: 500 }
    );
  }
}
