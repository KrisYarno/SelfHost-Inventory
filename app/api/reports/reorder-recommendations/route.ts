/**
 * Reorder report API (demand-based; Lane reorder-points, Task 4).
 *
 * REPLACES the former threshold-based route atomically. The old route sorted products
 * by `currentStock / lowStockThreshold` and converted unknown cost to `$0`
 * (`costPrice ?? 0`, `estimatedOrderValue`) — the exact lie Lane 6 killed elsewhere.
 * That is gone. This route returns the truthful demand-based ReorderReport:
 *   - discriminated rows (suggested | unavailable) — unavailable rows carry NO numbers;
 *   - cost as number|null (unknown stays null; order value blank, never $0);
 *   - inventoryPositionKnown:false stated plainly (the number is gross).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import { getReorderReport } from "@/lib/reports/reorder";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const searchParams = request.nextUrl.searchParams;
  // includeOkay adds the APPROACHING band (near, not yet at, the reorder point). The
  // page requests it so the user can see the whole worklist; the client filters.
  const includeOkay = searchParams.get("includeOkay") === "true";
  const limitParam = searchParams.get("limit");
  const offsetParam = searchParams.get("offset");
  const limit = limitParam != null ? Math.min(Math.max(1, parseInt(limitParam, 10) || 0), 1000) : undefined;
  const offset = offsetParam != null ? Math.max(0, parseInt(offsetParam, 10) || 0) : undefined;

  const report = await getReorderReport({ includeOkay, limit, offset });

  return NextResponse.json(report);
});
