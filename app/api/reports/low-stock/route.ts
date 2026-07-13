import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import { getLowStockReport } from "@/lib/reports/low-stock";

export const dynamic = "force-dynamic";

// Thin caller (Lane 4, codex #5/#8): the report computation now lives in
// lib/reports/low-stock.ts so the assistant/MCP reorder tool shares it. This
// response is byte-identical to the prior inline implementation, including the
// `?threshold=` override path and the deliberate inclusion of out-of-stock rows.
export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const searchParams = request.nextUrl.searchParams;
  // An explicit ?threshold overrides the inherited default for NULL-threshold
  // products; otherwise the report falls back to the configurable system default.
  const thresholdParam = searchParams.get("threshold");
  const report = await getLowStockReport(
    thresholdParam ? { thresholdOverride: parseInt(thresholdParam) } : {},
  );

  return NextResponse.json(report);
});
