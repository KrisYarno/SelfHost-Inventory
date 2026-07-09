import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler, requireCSRF } from "@/lib/api-utils";
import { createInventoryAdjustment } from "@/lib/inventory";
import { inventory_logs_logType } from "@prisma/client";
import { StockInSchema } from "@/lib/validation/inventory";
import { applyRateLimitHeaders, enforceRateLimit } from "@/lib/rateLimit";
import { recordChange, newBatchId } from "@/lib/change-tracking";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, "inventory:stock-in", {
    identifier: user.id,
  });

  await requireCSRF(request);

  const body = StockInSchema.parse(await request.json());

  const batchId = newBatchId();

  // Create the stock-in adjustment. Recorded inside the same transaction as the
  // stock write. Stock-in has no distinct actionType in Phase A (INVENTORY_STOCK_IN
  // is retired with lib/audit.ts in Task 14; logType semantics land in Phase C) —
  // it records as INVENTORY_ADJUSTMENT with a details marker until then.
  const result = await createInventoryAdjustment(
    user.id,
    body.productId,
    body.locationId,
    body.quantity,
    inventory_logs_logType.ADJUSTMENT,
    undefined,
    async (tx) => {
      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: "INVENTORY_ADJUSTMENT",
        entityType: "INVENTORY",
        entityId: body.productId,
        action: `Stocked in ${body.quantity} units (product ${body.productId}) at location ${body.locationId}`,
        details: {
          source: "stock-in",
          productId: body.productId,
          delta: body.quantity,
          locationId: body.locationId,
        },
        batchId,
      });
    }
  );

  const response = NextResponse.json({
    success: true,
    log: result,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
