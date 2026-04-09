import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { apiHandler } from "@/lib/api-utils";
import { syncStockToExternal } from "@/lib/external-orders/stock-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = apiHandler(async (request: NextRequest) => {
  // Verify CRON_SECRET (same pattern as stock-check cron)
  const authHeader = request.headers.get("authorization");
  if (
    !process.env.CRON_SECRET ||
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("Running stock sync cron job...");
  const startTime = Date.now();

  // Find all active integrations with stockSyncEnabled
  const integrations = await prisma.integration.findMany({
    where: {
      isActive: true,
      stockSyncEnabled: true,
    },
    select: { id: true, name: true, platform: true },
  });

  if (integrations.length === 0) {
    return NextResponse.json({
      success: true,
      integrations: 0,
      synced: 0,
      failed: 0,
      results: [],
    });
  }

  let totalSynced = 0;
  let totalFailed = 0;
  const results: Array<Record<string, unknown>> = [];

  for (const integration of integrations) {
    try {
      const result = await syncStockToExternal(integration.id);
      totalSynced += result.synced;
      totalFailed += result.failed;
      results.push({
        ...result,
        name: integration.name,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      totalFailed += 1;
      results.push({
        integrationId: integration.id,
        name: integration.name,
        platform: integration.platform,
        error: message,
      });
    }
  }

  const duration = Date.now() - startTime;
  console.log(
    `Stock sync completed in ${duration}ms: ${totalSynced} synced, ${totalFailed} failed across ${integrations.length} integrations`
  );

  return NextResponse.json({
    success: true,
    integrations: integrations.length,
    synced: totalSynced,
    failed: totalFailed,
    duration,
    results,
  });
});
