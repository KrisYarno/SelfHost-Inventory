import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import {
  getOperationsRows,
  getShrinkageSummary,
  getValuationSummary,
} from "@/lib/analytics/queries";

export const dynamic = "force-dynamic";

// Tier-1 Operations analytics (spec D6 / R-L10 / R-L11). GLOBAL by construction:
// turns / velocity / shrinkage / valuation are physical-pool metrics over
// inventory_logs + ProductStockSnapshot, which carry NO company dimension. There
// is deliberately no company param — a member of zero companies still sees this.
//
// One payload feeds the whole Operations view: the four summary tiles derive from
// `valuation` + `shrinkage90` + the row set; the decision table renders `rows`;
// each metric labels its own source via `dataStarts`.
const WindowSchema = z
  .enum(["30", "90"]) // rolling-day window for turns; unitsOut 30/90 are always both returned
  .transform((v) => Number(v) as 30 | 90);

export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const raw = request.nextUrl.searchParams.get("windowDays");
  let windowDays: 30 | 90 = 90;
  if (raw !== null) {
    const parsed = WindowSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "windowDays must be 30 or 90" },
        { status: 400 }
      );
    }
    windowDays = parsed.data;
  }

  const [operations, shrinkage90, valuation] = await Promise.all([
    getOperationsRows({ windowDays }),
    getShrinkageSummary({ days: 90 }),
    getValuationSummary(),
  ]);

  return NextResponse.json({
    scope: "global",
    windowDays,
    rows: operations.rows,
    dataStarts: operations.dataStarts,
    // The physicalOutbound velocity definition (spec §2 D3) travels with the rows'
    // avgDailyOutbound30 so the web surface can state what the rate means.
    velocityDefinition: operations.velocityDefinition,
    shrinkage90,
    valuation,
  });
});
