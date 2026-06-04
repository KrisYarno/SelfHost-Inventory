import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { apiHandler } from "@/lib/api-utils";
import { rebuildStockSnapshots } from "@/lib/analytics/rebuild-snapshots";
import { rebuildSalesFacts } from "@/lib/analytics/rebuild-sales";

export const dynamic = "force-dynamic";

// Thin CRON_SECRET-gated trigger for NIGHTLY-SIZE analytics rebuilds.
//
// SCOPE: this route handles only nightly-size work — sales over rebuild-sales'
// default ~36h updatedAt window, and snapshots over their default (today +
// per-pair backfill). The weekly TRUE-FULL sales rebuild (which reconciles late
// reversals by re-scanning every dayKey) is the standalone SCRIPT,
// scripts/analytics-rebuild.ts --job sales --mode full, NOT this route — a full
// rebuild can exceed HTTP request timeouts.
//
// AUTH mirrors app/api/cron/weekly-report/route.ts EXACTLY: a Bearer CRON_SECRET
// header, no session / CSRF. This stack is self-hosted (SFTP, not Vercel), so
// vercel.json crons are inert — the real scheduled trigger is the script invoked
// by host cron / a Docker sidecar. This route exists for manual / small triggers.
//
// Params:
//   job  = "snapshots" | "sales"   (default "sales")
//   mode = "nightly"               (default; documented for parity with the script)
export const GET = apiHandler(async (request: NextRequest) => {
  // Verify the request has a valid CRON_SECRET (same shape as weekly-report).
  const authHeader = request.headers.get("authorization");
  if (
    !process.env.CRON_SECRET ||
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Global flag gate (mirrors weeklyReportsEnabled). Off => no-op, never run.
  const setting = await prisma.systemSetting.findUnique({
    where: { key: "analyticsRebuildEnabled" },
  });
  if (setting?.value !== "true") {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: "analyticsRebuildEnabled is off",
    });
  }

  const sp = request.nextUrl.searchParams;
  const job = sp.get("job") === "snapshots" ? "snapshots" : "sales";
  const mode = sp.get("mode") ?? "nightly";

  const startTime = Date.now();
  console.log(`[analytics-rebuild] job=${job} mode=${mode} starting...`);

  // Nightly-size defaults only. Pass {} so each lib applies its own nightly
  // window (sales: ~36h updatedAt; snapshots: today + per-pair backfill).
  const result =
    job === "snapshots"
      ? await rebuildStockSnapshots({})
      : await rebuildSalesFacts({});

  const duration = Date.now() - startTime;
  console.log(
    `[analytics-rebuild] job=${job} done in ${duration}ms: ${JSON.stringify(result)}`
  );

  return NextResponse.json({
    success: true,
    timestamp: new Date().toISOString(),
    duration,
    job,
    mode,
    result,
  });
});
