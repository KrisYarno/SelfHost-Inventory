import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-utils";
import { stockChecker } from "@/lib/stock-checker";

export const dynamic = "force-dynamic";

// This endpoint will be called by Vercel Cron
export const GET = apiHandler(async (request: NextRequest) => {
  // Verify the request has a valid CRON_SECRET
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("Running stock check cron job...");
  const startTime = Date.now();

  const lowStockResult = await stockChecker.runDailyCheck();
  const minimumResult = await stockChecker.runMinimumsCheck();

  const duration = Date.now() - startTime;
  console.log(`Stock check completed in ${duration}ms`);

  return NextResponse.json({
    success: true,
    timestamp: new Date().toISOString(),
    duration,
    ...lowStockResult,
    ...minimumResult,
  });
});
