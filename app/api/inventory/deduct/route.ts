import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { DeductInventoryResponse } from "@/types/workbench";
import { createInventoryTransaction } from "@/lib/inventory";
import { AppError } from "@/lib/error-handling";
import { DeductInventorySchema } from "@/lib/validation/workbench";
import { applyRateLimitHeaders, enforceRateLimit } from "@/lib/rateLimit";
import { auditService } from "@/lib/audit";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";

// POST /api/inventory/deduct - Process order deduction
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, "inventory:deduct", {
    identifier: user.id,
  });

  await requireCSRF(request);

  const body = DeductInventorySchema.parse(await request.json());

  // Get default location (MVP: single location)
  const location = await prisma.location.findFirst({
    orderBy: { id: "asc" },
  });

  if (!location) {
    throw new AppError("No location configured in the system", "NO_LOCATION", 500);
  }

  // Prepare items for the transaction
  const items = body.items.map((item) => ({
    productId: item.productId,
    locationId: location.id,
    quantityChange: -item.quantity,
    notes: body.notes,
  }));

  const operationId = randomUUID();

  // Process the transaction
  const result = await createInventoryTransaction("SALE", user.id, items, {
    orderReference: body.orderReference,
    notes: body.notes,
    operationId,
  });

  const response: DeductInventoryResponse = {
    success: true,
    transactionId: result.transaction.id,
    itemsProcessed: result.logs.length,
    message: `Successfully processed order ${body.orderReference}`,
  };

  // Audit as bulk inventory update for deductions
  try {
    await auditService.logBulkInventoryUpdate(
      user.id,
      result.logs.map((log) => ({
        productId: log.productId,
        productName: log.products?.name ?? `Product ${log.productId}`,
        delta: log.delta,
      })),
      location.id
    );
  } catch (auditError) {
    console.error("Failed to log audit deduction:", auditError);
  }

  const responseWithHeaders = NextResponse.json(response);
  return applyRateLimitHeaders(responseWithHeaders, rateLimitHeaders);
});
