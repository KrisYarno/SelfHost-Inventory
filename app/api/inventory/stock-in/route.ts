import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler, requireCSRF } from "@/lib/api-utils";
import { createInventoryAdjustment } from "@/lib/inventory";
import { inventory_logs_logType } from "@prisma/client";
import { StockInSchema } from "@/lib/validation/inventory";
import { applyRateLimitHeaders, enforceRateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, "inventory:stock-in", {
    identifier: user.id,
  });

  await requireCSRF(request);

  const body = StockInSchema.parse(await request.json());

  // Create the stock-in adjustment
  const result = await createInventoryAdjustment(
    user.id,
    body.productId,
    body.locationId,
    body.quantity,
    inventory_logs_logType.ADJUSTMENT
  );

  const response = NextResponse.json({
    success: true,
    log: result,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
