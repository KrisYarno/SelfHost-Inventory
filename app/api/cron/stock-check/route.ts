import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-utils";
import { bearerAuthorized } from "@/lib/security/secret-compare";
import { stockChecker } from "@/lib/stock-checker";

export const dynamic = "force-dynamic";

// This endpoint will be called by Vercel Cron
export const GET = apiHandler(async (request: NextRequest) => {
  // Verify the request has a valid CRON_SECRET
  const authHeader = request.headers.get("authorization");
  if (!bearerAuthorized(authHeader, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("Running stock check cron job...");
  const startTime = Date.now();

  const { lowStockCount, ...lowStock } = await stockChecker.runDailyCheck();
  const { locationBreaches, combinedBreaches, ...minimums } =
    await stockChecker.runMinimumsCheck();

  const duration = Date.now() - startTime;
  console.log(`Stock check completed in ${duration}ms`);

  // N0 (D1): each run's email counts are NESTED under their own key — the two runs
  // carry the same field names, so spreading them would let one overwrite the other.
  return NextResponse.json({
    success: true,
    timestamp: new Date().toISOString(),
    duration,
    lowStockCount,
    locationBreaches,
    combinedBreaches,
    lowStock,
    minimums,
  });
});
