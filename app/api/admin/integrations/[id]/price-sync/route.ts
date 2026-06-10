import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import { syncPricesForIntegration } from "@/lib/external-orders/price-sync";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/integrations/[id]/price-sync
 *
 * Bulk-sync retail prices for all products that have a priceSourceLink
 * from this integration. Fetches each product's regular_price from WC
 * and updates retailPrice.
 */
export const POST = apiHandler(
  async (
    request: NextRequest,
    { params }: { params: { id: string } }
  ) => {
    await requireAdmin();

    await requireCSRF(request);

    const integrationId = params.id;
    const result = await syncPricesForIntegration(integrationId);

    return NextResponse.json({ result });
  }
);
