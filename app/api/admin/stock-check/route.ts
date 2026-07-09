import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import { stockChecker } from "@/lib/stock-checker";
import { applyRateLimitHeaders, enforceRateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// Admin-triggered equivalent of the CRON_SECRET-gated /api/cron/stock-check.
// Lets an authenticated admin run the daily low-stock + minimums check on demand
// (e.g. from the email-testing page) without exposing the cron secret to the
// browser. The cron route stays untouched for scheduled runs.
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();

  const rateLimitHeaders = enforceRateLimit(request, "admin:stock-check", {
    identifier: user.id,
    // The check is expensive (scans every product) and sends email — keep the
    // manual trigger to a handful of runs per minute.
    limit: 5,
  });

  await requireCSRF(request);

  const startTime = Date.now();

  const lowStockResult = await stockChecker.runDailyCheck();
  const minimumResult = await stockChecker.runMinimumsCheck();

  const duration = Date.now() - startTime;

  const response = NextResponse.json({
    success: true,
    timestamp: new Date().toISOString(),
    duration,
    ...lowStockResult,
    ...minimumResult,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
