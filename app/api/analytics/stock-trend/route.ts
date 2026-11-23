import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import { AppError } from "@/lib/error-handling";
import { getStockSeries } from "@/lib/analytics/queries";

export const dynamic = "force-dynamic";

// GLOBAL inventory read (no company scoping). Accurate stock levels from materialized snapshots —
// replaces the stubbed lowStockTrend / all-time-delta reconstruction.
//
// N0 (C7, RB-8 narrowed): `productId` is REQUIRED and must be a positive Int
// (/^[1-9]\d{0,9}$/ and <= 2147483647) — without it this read returned the WHOLE
// snapshot table. No UI calls this route. `locationId` is optional, but when present
// it follows the same rule (N0 FR1 E6), else 400 — never a NaN reaching the query.
const PRODUCT_ID_RE = /^[1-9]\d{0,9}$/;
const MAX_INT = 2147483647;

export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();
  const sp = request.nextUrl.searchParams;
  const rawProductId = sp.get("productId");
  if (rawProductId === null || !PRODUCT_ID_RE.test(rawProductId) || Number(rawProductId) > MAX_INT) {
    throw new AppError("productId is required", "VALIDATION_ERROR", 400);
  }
  const productId = Number(rawProductId);
  const rawLocationId = sp.get("locationId");
  if (
    rawLocationId !== null &&
    (!PRODUCT_ID_RE.test(rawLocationId) || Number(rawLocationId) > MAX_INT)
  ) {
    throw new AppError("Invalid locationId", "VALIDATION_ERROR", 400);
  }
  const locationId = rawLocationId === null ? undefined : Number(rawLocationId);
  const from = sp.get("from") ?? undefined;
  const to = sp.get("to") ?? undefined;

  const rows = await getStockSeries({ productId, locationId, from, to });
  return NextResponse.json({ series: rows, mode: "historical" });
});
