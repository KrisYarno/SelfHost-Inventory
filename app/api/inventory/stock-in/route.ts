import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler, requireCSRF } from "@/lib/api-utils";
import { createInventoryAdjustment, centsFromCostPrice } from "@/lib/inventory";
import { inventory_logs_logType } from "@prisma/client";
import prisma from "@/lib/prisma";
import { AppError } from "@/lib/error-handling";
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

  // Phase C (P-C3): stock-in freezes the unit cost at receipt. Load the product's
  // costPrice just before the write; a missing or soft-deleted product 404s before
  // any stock is touched.
  //
  // ACCEPTED TOLERANCE: this read happens just before (not inside) the write
  // transaction, so a concurrent costPrice edit in that millisecond-wide window
  // wins or loses by timing. "Cost at receipt" is a human-timescale guarantee; the
  // race is not worth a serializable read of the product row on every stock-in.
  const product = await prisma.product.findUnique({
    where: { id: body.productId, deletedAt: null },
    select: { costPrice: true, name: true },
  });
  if (!product) {
    throw new AppError(`Product with ID ${body.productId} not found`, "PRODUCT_NOT_FOUND", 404);
  }
  const unitCostCents = centsFromCostPrice(product.costPrice);

  const batchId = newBatchId();

  // Create the stock-in adjustment. Recorded inside the same transaction as the
  // stock write. Phase C: the ledger row now carries the STOCK_IN logType and the
  // frozen unitCostCents; the audit event keeps its stock-in marker (there is no
  // distinct STOCK_IN actionType — INVENTORY_STOCK_IN retired with lib/audit.ts in
  // Phase A Task 14) and surfaces the frozen cost. batchId joins row <-> event.
  const result = await createInventoryAdjustment(
    user.id,
    body.productId,
    body.locationId,
    body.quantity,
    {
      logType: inventory_logs_logType.STOCK_IN,
      unitCostCents,
      batchId,
      record: async (tx) => {
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
            unitCostCents,
          },
          batchId,
        });
      },
    }
  );

  const response = NextResponse.json({
    success: true,
    log: result,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
