import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import { applyRateLimitHeaders, enforceRateLimit } from "@/lib/rateLimit";
import prisma from "@/lib/prisma";
import { recordChange } from "@/lib/change-tracking";
import { rebuildStockSnapshots } from "@/lib/analytics/rebuild-snapshots";
import { rebuildSalesFacts } from "@/lib/analytics/rebuild-sales";
import { toDayKey } from "@/lib/analytics/dates";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/analytics-rebuild — admin-triggered manual rebuild so a stuck
 * nightly can be re-run on demand (spec §3 D7, §10 R-L14). Mirrors
 * app/api/admin/stock-check/route.ts: requireAdmin -> rate-limit 5/user/hr ->
 * requireCSRF. Records ANALYTICS_REBUILD_TRIGGER (the human action) BEFORE
 * dispatch; the run telemetry itself lives in analytics_rebuild_runs via the
 * begin/finalize lifecycle (source:'manual'), not the audit log.
 *
 * The rebuild fn inserts its RUNNING row at lock-acquire, so the 60s ops-health
 * poll surfaces the run immediately even while this request is still in flight.
 */

const BodySchema = z.object({
  job: z.enum(["snapshots", "sales"]),
  mode: z.enum(["nightly", "full"]),
});

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();

  const rateLimitHeaders = enforceRateLimit(request, "admin:analytics-rebuild", {
    identifier: user.id,
    limit: 5,
    ttl: 60 * 60 * 1000, // 5 per user per hour
  });

  await requireCSRF(request);

  const { job, mode } = BodySchema.parse(await request.json());

  // Record the human TRIGGER first, transactionally (an unrecordable trigger
  // fails the request rather than silently running).
  await prisma.$transaction(async (tx) => {
    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "ANALYTICS_REBUILD_TRIGGER",
      entityType: "SYSTEM",
      entityId: null,
      action: `Triggered ${job} analytics rebuild (${mode})`,
      details: { job, mode },
    });
  });

  const meta = { mode, source: "manual" as const, requestedByUserId: user.id };

  let result;
  if (job === "snapshots") {
    if (mode === "full") {
      result = await rebuildStockSnapshots({ meta });
    } else {
      const nightlyDays = parseInt(process.env.ANALYTICS_SNAPSHOT_NIGHTLY_DAYS || "3", 10);
      const from = toDayKey(new Date(Date.now() - nightlyDays * 24 * 60 * 60 * 1000));
      result = await rebuildStockSnapshots({ from, meta });
    }
  } else {
    result = mode === "full" ? await rebuildSalesFacts({ full: true, meta }) : await rebuildSalesFacts({ meta });
  }

  const response = NextResponse.json({
    success: true,
    job,
    mode,
    skipped: result.skipped === true,
    result,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
