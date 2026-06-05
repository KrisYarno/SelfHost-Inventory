import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { apiHandler } from "@/lib/api-utils";
import { rebuildStockSnapshots } from "@/lib/analytics/rebuild-snapshots";
import { rebuildSalesFacts } from "@/lib/analytics/rebuild-sales";
import { toDayKey } from "@/lib/analytics/dates";

export const dynamic = "force-dynamic";

// CRON_SECRET-gated trigger for analytics rebuilds — supports BOTH nightly and full.
//
// SCOPE: this route now handles nightly-size AND weekly TRUE-FULL work:
//   - sales nightly  => rebuild-sales' default ~36h updatedAt window
//   - sales full     => whole-history rebuild (reconciles late reversals by
//                       re-scanning every dayKey)
//   - snapshots nightly => only the last few completed days (cheap; see below)
//   - snapshots full    => full per-pair history backfill (one-time / weekly)
// The weekly full is SAFE over this route because the scheduled caller is a
// Docker sidecar that curls the INTERNAL app URL (http://app:3000/...): there is
// no cloudflared proxy in front of the internal hop, so there is no HTTP request
// timeout to exceed. (The standalone scripts/analytics-rebuild.ts CLI still
// exists for host-cron / manual ops.)
//
// AUTH mirrors app/api/cron/weekly-report/route.ts EXACTLY: a Bearer CRON_SECRET
// header, no session / CSRF. This stack is self-hosted (SFTP, not Vercel), so
// vercel.json crons are inert — the real scheduled trigger is the sidecar
// scripts/scheduled-analytics-rebuild.js. This route also serves manual / small
// triggers.
//
// Params:
//   job  = "snapshots" | "sales"   (default "sales")
//   mode = "nightly" | "full"      (default "nightly")
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
  const mode = sp.get("mode") === "full" ? "full" : "nightly";

  const startTime = Date.now();
  console.log(`[analytics-rebuild] job=${job} mode=${mode} starting...`);

  // RATIONALE — nightly snapshots must stay CHEAP. A snapshots rebuild with no
  // `from` backfills every pair from its earliest log (tens of thousands of
  // dense per-day upserts); doing that every single night is wasteful. So:
  //   - nightly => `from` = a recent window (last N completed days, default 3),
  //                refreshing only days that could still be moving.
  //   - full    => `{}` (no `from`) = the per-pair FULL history backfill, run
  //                weekly / one-time, not nightly.
  // Sales mirrors this: nightly `{}` (lib's ~36h updatedAt window) vs full
  // `{ full: true }` (re-scan every dayKey to reconcile late reversals).
  let result;
  if (job === "snapshots") {
    if (mode === "full") {
      result = await rebuildStockSnapshots({});
    } else {
      const nightlyDays = parseInt(
        process.env.ANALYTICS_SNAPSHOT_NIGHTLY_DAYS || "3",
        10
      );
      const from = toDayKey(
        new Date(Date.now() - nightlyDays * 24 * 60 * 60 * 1000)
      );
      result = await rebuildStockSnapshots({ from });
    }
  } else {
    result =
      mode === "full"
        ? await rebuildSalesFacts({ full: true })
        : await rebuildSalesFacts({});
  }

  const duration = Date.now() - startTime;
  console.log(
    `[analytics-rebuild] job=${job} done in ${duration}ms: ${JSON.stringify(result)}`
  );

  // Top-level `skipped` mirrors the flag-off path so the response ALWAYS carries a boolean meaning
  // "did NOT do work". Here it is true when the rebuild lib short-circuited because the cross-process
  // lock was already held (another run in flight). The scheduler keys its dedup-advance on this: a
  // skipped (lock-held) run must NOT burn the dedup marker, so the next tick retries.
  return NextResponse.json({
    success: true,
    skipped: result.skipped === true,
    timestamp: new Date().toISOString(),
    duration,
    job,
    mode,
    result,
  });
});
