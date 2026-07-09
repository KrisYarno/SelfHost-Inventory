import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import { syncIntegrationOrders } from "@/lib/external-orders/sync";
import { SyncOrdersSchema } from "@/lib/validation/integrations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = apiHandler(async (
  request: NextRequest,
  { params }: { params: { id: string } }
) => {
  await requireAdmin();

  await requireCSRF(request);

  const { lookbackDays, maxOrders } = SyncOrdersSchema.parse(
    await request.json().catch(() => ({}))
  );
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
