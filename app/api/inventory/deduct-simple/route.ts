import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler, requireCSRF } from "@/lib/api-utils";
import { createInventoryTransaction } from "@/lib/inventory";
import { SimpleDeductSchema } from "@/lib/validation/workbench";
import { applyRateLimitHeaders, enforceRateLimit } from "@/lib/rateLimit";
import { recordChange, newBatchId } from "@/lib/change-tracking";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, "inventory:deduct-simple", {
    identifier: user.id,
  });

  await requireCSRF(request);

  const body = SimpleDeductSchema.parse(await request.json());

  // Transform items for inventory transaction
  const transactionItems = body.items.map((item) => ({
    productId: item.productId,
    locationId: body.locationId,
    quantityChange: -Math.abs(item.quantity),
    notes: body.notes,
  }));

  const operationId = randomUUID();

  const batchId = newBatchId();

  // Create the deduction transaction. The bulk-update event is recorded INSIDE
  // the same transaction as the deduction writes (via the record callback), so
  // an unrecordable deduction never commits.
  const result = await createInventoryTransaction(
    "DEDUCTION",
    user.id,
    transactionItems,
    {
      orderReference: body.orderReference,
      notes: body.notes,
      operationId,
    },
    async (tx, logs) => {
      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: "INVENTORY_BULK_UPDATE",
        entityType: "INVENTORY",
        action: `Bulk updated inventory for ${logs.length} products`,
        details: {
          updates: logs.map((log) => ({
            productId: log.productId,
            productName: log.products?.name ?? `Product ${log.productId}`,
            delta: log.delta,
          })),
          locationId: body.locationId,
        },
        affectedCount: logs.length,
        batchId,
      });
    },
    // ER-C3: thread the event batchId so every DEDUCTION->SALE ledger row joins
    // this deduction's bulk-update event.
    { batchId }
  );

  const response = NextResponse.json({
    success: true,
    transactionId: result.transaction.id,
    itemsProcessed: result.logs.length,
    message: `Successfully processed ${result.logs.length} items`,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
