import { NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getLowStockDefault } from "@/lib/stock-threshold";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireAdmin();

  // System-wide default a NULL-threshold product inherits (spec R-L13). Bound as
  // a query parameter (never string-concatenated) inside the stock classifier.
  const lowStockDefault = await getLowStockDefault();

  // Get metrics in parallel for performance
  const [
    totalProducts,
    userStats,
    stockStats,
    recentTransactions,
    topMovingProducts,
    recentActivity,
  ] = await Promise.all([
    // Total unique products (exclude soft-deleted + provisional)
    prisma.product.count({
      where: { deletedAt: null, approvalStatus: "APPROVED" },
    }),

    // User statistics
    prisma.user.groupBy({
      by: ["isApproved"],
      _count: true,
    }),

    // Stock statistics across all locations (spec R-L13): JOIN products so only
    // APPROVED, non-deleted products are classified; the low-stock threshold is
    // COALESCE(lowStockThreshold, :default) with :default a BOUND parameter;
    // negative totals classify out_of_stock; a 0 effective threshold (disabled)
    // never counts as low; comparison is INCLUSIVE (total <= threshold).
    prisma.$queryRaw<Array<{ status: string; count: bigint }>>(Prisma.sql`
      SELECT status, COUNT(*) as count
      FROM (
        SELECT
          CASE
            WHEN pt.total_quantity <= 0 THEN 'out_of_stock'
            WHEN COALESCE(p.lowStockThreshold, ${lowStockDefault}) > 0
                 AND pt.total_quantity <= COALESCE(p.lowStockThreshold, ${lowStockDefault})
              THEN 'low_stock'
            ELSE 'in_stock'
          END as status
        FROM (
          SELECT productId, SUM(quantity) as total_quantity
          FROM product_locations
          GROUP BY productId
        ) as pt
        INNER JOIN products p ON p.id = pt.productId
        WHERE p.deletedAt IS NULL AND p.approvalStatus = 'APPROVED'
      ) as classified
      GROUP BY status
    `),

    // Recent transactions (last 24 hours)
    prisma.inventory_logs.count({
      where: {
        changeTime: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
      },
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
        AND p.approvalStatus = 'APPROVED'
      GROUP BY p.id, p.name
      ORDER BY movement DESC
      LIMIT 10
    `,

    // Recent activity
    prisma.inventory_logs.findMany({
      take: 10,
      orderBy: { changeTime: "desc" },
      include: {
        users: true,
        products: true,
        locations: true,
      },
    }),
  ]);

  // Process user stats
  const activeUsers =
    userStats.find((stat: { isApproved: boolean; _count: number }) => stat.isApproved === true)
      ?._count || 0;
  const pendingUsers =
    userStats.find((stat: { isApproved: boolean; _count: number }) => stat.isApproved === false)
      ?._count || 0;
  const totalUsers = activeUsers + pendingUsers;

  // Process stock stats
  const stockStatsMap = stockStats.reduce(
    (acc: Record<string, number>, stat: { status: string; count: bigint }) => {
      acc[stat.status] = Number(stat.count);
      return acc;
    },
    {} as Record<string, number>
  );

  // Format response
  const metrics = {
    totalProducts,
    totalUsers,
    activeUsers,
    pendingUsers,
    lowStockProducts: stockStatsMap.low_stock || 0,
    outOfStockProducts: stockStatsMap.out_of_stock || 0,
    recentTransactions,
    topMovingProducts: topMovingProducts.map((p) => ({
      id: p.productId,
      name: p.name,
      movement: Number(p.movement),
    })),
    recentActivity: recentActivity.map((log) => ({
      id: log.id,
      // Machine-actor rows (nullable userId) have no owning user — render "System".
      user: log.users?.username ?? "System",
      action: log.delta > 0 ? "Added to" : "Removed from",
      product: log.products.name,
      quantity: log.delta,
      timestamp: log.changeTime.toISOString(),
      location: log.locations?.name || "Unknown",
    })),
  };

  return NextResponse.json(metrics);
});
