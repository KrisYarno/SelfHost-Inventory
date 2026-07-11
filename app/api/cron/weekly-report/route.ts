import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { apiHandler } from "@/lib/api-utils";
import { emailService } from "@/lib/email";
import { getLowStockDefault, effectiveLowStockThreshold } from "@/lib/stock-threshold";

export const dynamic = "force-dynamic";

// Called by Vercel Cron weekly
export const GET = apiHandler(async (request: NextRequest) => {
  // Verify the request has a valid CRON_SECRET
  const authHeader = request.headers.get("authorization");
  if (
    !process.env.CRON_SECRET ||
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("Running weekly report cron job...");
  const startTime = Date.now();

  // Check if weekly reports are enabled globally
  const setting = await prisma.systemSetting.findUnique({
    where: { key: "weeklyReportsEnabled" },
  });

  if (setting?.value !== "true") {
    console.log("Weekly reports are disabled, skipping.");
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: "Weekly reports disabled",
    });
  }

  // Gather report data
  const now = new Date();
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  // Total active products
  const totalProducts = await prisma.product.count({
    where: { deletedAt: null, approvalStatus: "APPROVED" },
  });

  // Total stock across all locations
  const stockAgg = await prisma.product_locations.aggregate({
    _sum: { quantity: true },
  });
  const totalStock = stockAgg._sum.quantity ?? 0;

  // Products at/below their effective low-stock threshold. NULL now INHERITS the
  // configurable system default (R-L13, was collapsed to 0) and the comparison is
  // INCLUSIVE (was exclusive `<`, which skipped products exactly at their minimum).
  const lowStockDefault = await getLowStockDefault();
  const products = await prisma.product.findMany({
    where: { deletedAt: null, approvalStatus: "APPROVED" },
    include: { product_locations: true },
  });

  const lowStockItems: Array<{
    name: string;
    currentStock: number;
    minimum: number;
    deficit: number;
  }> = [];

  for (const product of products) {
    const totalQty = product.product_locations.reduce(
      (sum, pl) => sum + pl.quantity,
      0
    );
    const minimum = effectiveLowStockThreshold(product.lowStockThreshold, lowStockDefault);
    if (minimum > 0 && totalQty <= minimum) {
      lowStockItems.push({
        name: product.name,
        currentStock: totalQty,
        minimum,
        deficit: minimum - totalQty,
      });
    }
  }

  // Sort by largest deficit first
  lowStockItems.sort((a, b) => b.deficit - a.deficit);

  // Top 10 movers in the last 7 days (absolute delta volume)
  const topMoversRaw = await prisma.inventory_logs.groupBy({
    by: ["productId"],
    where: {
      changeTime: { gte: sevenDaysAgo },
    },
    _sum: { delta: true },
    orderBy: { _sum: { delta: "asc" } },
  });

  const moversSorted = topMoversRaw
    .map((m) => ({
      productId: m.productId,
      unitsMoved: Math.abs(m._sum.delta ?? 0),
    }))
    .sort((a, b) => b.unitsMoved - a.unitsMoved)
    .slice(0, 10);

  // Fetch product names for top movers
  const moverProductIds = moversSorted.map((m) => m.productId);
  const moverProducts = await prisma.product.findMany({
    where: { id: { in: moverProductIds } },
    select: { id: true, name: true },
  });
  const moverNameMap = new Map(moverProducts.map((p) => [p.id, p.name]));

  const topMovers = moversSorted.map((m) => ({
    name: moverNameMap.get(m.productId) ?? `Product #${m.productId}`,
    unitsMoved: m.unitsMoved,
  }));

  // Stock by location
  const locationSummary = await prisma.product_locations.groupBy({
    by: ["locationId"],
    _sum: { quantity: true },
  });

  const locationIds = locationSummary.map((ls) => ls.locationId);
  const locations = await prisma.location.findMany({
    where: { id: { in: locationIds } },
    select: { id: true, name: true },
  });
  const locationNameMap = new Map(locations.map((l) => [l.id, l.name]));

  const stockByLocation = locationSummary
    .map((ls) => ({
      name: locationNameMap.get(ls.locationId) ?? `Location #${ls.locationId}`,
      totalStock: ls._sum.quantity ?? 0,
    }))
    .sort((a, b) => b.totalStock - a.totalStock);

  // Get users who opted into email alerts
  const users = await prisma.user.findMany({
    where: {
      emailAlerts: true,
      isApproved: true,
      deletedAt: null,
    },
    select: {
      email: true,
      username: true,
    },
  });

  if (users.length === 0) {
    console.log("No users opted in for email alerts, skipping send.");
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: "No opted-in users",
    });
  }

  // Format date range
  const formatDate = (d: Date) =>
    d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

  const dateRange = `${formatDate(sevenDaysAgo)} - ${formatDate(now)}`;

  // Send email to each user
  let emailsSent = 0;
  for (const user of users) {
    try {
      const html = emailService.generateWeeklyReportHTML({
        recipientName: user.username,
        dateRange,
        totalProducts,
        totalStock,
        lowStockCount: lowStockItems.length,
        lowStockItems,
        topMovers,
        stockByLocation,
      });

      const text = emailService.generateWeeklyReportText({
        recipientName: user.username,
        dateRange,
        totalProducts,
        totalStock,
        lowStockCount: lowStockItems.length,
        lowStockItems,
        topMovers,
        stockByLocation,
      });

      await emailService.sendEmail({
        to: user.email,
        subject: `Weekly Inventory Report — ${dateRange}`,
        html,
        text,
      });

      emailsSent++;
    } catch (error) {
      console.error(
        `Failed to send weekly report to ${user.email}:`,
        error
      );
    }
  }

  const duration = Date.now() - startTime;
  console.log(
    `Weekly report completed in ${duration}ms — sent ${emailsSent} emails`
  );

  return NextResponse.json({
    success: true,
    timestamp: new Date().toISOString(),
    duration,
    emailsSent,
    totalProducts,
    totalStock,
    lowStockCount: lowStockItems.length,
    topMoversCount: topMovers.length,
    locationsCount: stockByLocation.length,
  });
});
