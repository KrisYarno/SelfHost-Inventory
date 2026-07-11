import { NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import { getLowStockDefault } from "@/lib/stock-threshold";

export const dynamic = "force-dynamic";

/**
 * GET /api/settings/low-stock-default — the configurable system-wide default
 * low-stock threshold (SystemSetting 'lowStockDefaultThreshold', fallback 10).
 *
 * Read-only (no mutation → no change-tracking coverage entry). Exists so every
 * CLIENT surface can resolve a product's effective threshold via the shared
 * `effectiveLowStockThreshold`/`isLowStock` helpers without materializing a
 * literal default or importing the server-only setting reader. `requireApproved`
 * matches the low-stock consumers (products list, journal, workbench).
 */
export const GET = apiHandler(async () => {
  await requireApproved();
  const threshold = await getLowStockDefault();
  return NextResponse.json({ threshold });
});
