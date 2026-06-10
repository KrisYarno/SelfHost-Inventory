import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import { syncStockToExternal } from "@/lib/external-orders/stock-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = apiHandler(async (
  request: NextRequest,
  { params }: { params: { id: string } }
) => {
  await requireAdmin();

  await requireCSRF(request);

  const result = await syncStockToExternal(params.id);
  return NextResponse.json({ result });
});
