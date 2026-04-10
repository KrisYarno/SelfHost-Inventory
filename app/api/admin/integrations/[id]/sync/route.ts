import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import { validateCSRFToken } from "@/lib/csrf";
import { syncIntegrationOrders } from "@/lib/external-orders/sync";

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

  const body = await request.json().catch(() => ({}));
  const lookbackDays =
    typeof body.lookbackDays === "number" ? body.lookbackDays : undefined;
  const maxOrders = typeof body.maxOrders === "number" ? body.maxOrders : undefined;
  // When the user explicitly provides lookbackDays via the dialog, force a
  // full lookback instead of using the lastSyncAt cursor. Without this, the
  // user's "14 days" input is silently ignored after the first sync.
  const forceFullLookback = lookbackDays !== undefined;

  const result = await syncIntegrationOrders(params.id, {
    lookbackDays,
    maxOrders,
    forceFullLookback,
  });
  return NextResponse.json({ result });
});
