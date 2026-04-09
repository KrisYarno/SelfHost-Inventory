import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import { validateCSRFToken } from "@/lib/csrf";
import { syncStockToExternal } from "@/lib/external-orders/stock-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = apiHandler(async (
  request: NextRequest,
  { params }: { params: { id: string } }
) => {
  await requireAdmin();

  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
  }

  const result = await syncStockToExternal(params.id);
  return NextResponse.json({ result });
});
