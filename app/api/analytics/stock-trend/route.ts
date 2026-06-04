import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import { getStockSeries } from "@/lib/analytics/queries";

export const dynamic = "force-dynamic";

// GLOBAL inventory read (no company scoping). Accurate stock levels from materialized snapshots —
// replaces the stubbed lowStockTrend / all-time-delta reconstruction.
export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();
  const sp = request.nextUrl.searchParams;
  const productId = sp.get("productId") ? parseInt(sp.get("productId")!, 10) : undefined;
  const locationId = sp.get("locationId") ? parseInt(sp.get("locationId")!, 10) : undefined;
  const from = sp.get("from") ?? undefined;
  const to = sp.get("to") ?? undefined;

  const rows = await getStockSeries({ productId, locationId, from, to });
  return NextResponse.json({ series: rows, mode: "historical" });
});
