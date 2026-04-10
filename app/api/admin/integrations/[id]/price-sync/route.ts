import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import { validateCSRFToken } from "@/lib/csrf";
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

    const isValidCSRF = await validateCSRFToken(request);
    if (!isValidCSRF) {
      return NextResponse.json(
        { error: "Invalid CSRF token" },
        { status: 403 }
      );
    }

    const integrationId = params.id;
    const result = await syncPricesForIntegration(integrationId);

    return NextResponse.json({ result });
  }
);
