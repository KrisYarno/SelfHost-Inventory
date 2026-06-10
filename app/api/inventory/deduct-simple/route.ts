import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler, requireCSRF } from "@/lib/api-utils";
import { createInventoryTransaction } from "@/lib/inventory";
import { SimpleDeductSchema } from "@/lib/validation/workbench";
import { applyRateLimitHeaders, enforceRateLimit } from "@/lib/rateLimit";
import { auditService } from "@/lib/audit";
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

  // Create the deduction transaction
  const result = await createInventoryTransaction(
    "DEDUCTION",
    user.id,
    transactionItems,
    {
      orderReference: body.orderReference,
      notes: body.notes,
      operationId,
    }
  );

  // Audit as bulk inventory update/deduction
  try {
    await auditService.logBulkInventoryUpdate(
      user.id,
      result.logs.map((log) => ({
        productId: log.productId,
        productName: log.products?.name ?? `Product ${log.productId}`,
        delta: log.delta,
      })),
      body.locationId
    );
  } catch (auditError) {
    console.error("Failed to log audit deduction:", auditError);
  }

  const response = NextResponse.json({
    success: true,
    transactionId: result.transaction.id,
    itemsProcessed: result.logs.length,
    message: `Successfully processed ${result.logs.length} items`,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
