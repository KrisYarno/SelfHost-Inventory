import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler, requireCSRF } from "@/lib/api-utils";
import {
  createInventoryAdjustment,
  validateStockAvailability,
} from "@/lib/inventory";
import { inventory_logs_logType } from "@prisma/client";
import { recordChange, newBatchId } from "@/lib/change-tracking";
import prisma from "@/lib/prisma";
import { InventoryAdjustmentSchema } from "@/lib/validation/inventory";
import { applyRateLimitHeaders, enforceRateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, "inventory:adjust", {
    identifier: user.id,
  });

  await requireCSRF(request);

  const rawBody = await request.json();
  const body = InventoryAdjustmentSchema.parse(rawBody);
  const autoAddForTransfer = rawBody?.autoAddForTransfer === true;

  // If removing stock, validate availability
  if (body.delta < 0) {
    const validation = await validateStockAvailability(
      body.productId,
      body.locationId,
      Math.abs(body.delta)
    );

    if (!validation.isValid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
  }

  // Get product info for the change record
  const product = await prisma.product.findUnique({
    where: { id: body.productId },
    select: { name: true },
  });
  const productName = product?.name ?? `Product ${body.productId}`;

  // One batch id per request flow; recorded inside the adjustment's transaction.
  const batchId = newBatchId();

  // Create the adjustment with version checking. The change is recorded INSIDE
  // the same transaction as the stock write (via the record callback) so an
  // unrecordable adjustment never commits. An auto-add-for-transfer adjustment
  // preserves its dedicated actionType; every other adjustment records as
  // INVENTORY_ADJUSTMENT.
  const result = await createInventoryAdjustment(
    user.id,
    body.productId,
    body.locationId,
    body.delta,
    {
      logType: body.logType || inventory_logs_logType.ADJUSTMENT,
      expectedVersion: body.expectedVersion,
      // Phase C (P-C5/P-C1): the coded reason rides onto the ledger row; the same
      // batchId stamps the row so it joins the audit event; the free-text reason /
      // notes ride onto the audit event details (below).
      reasonCode: body.reasonCode,
      batchId,
      record: async (tx) => {
        await recordChange(tx, {
          actor: { userId: user.id },
          actionType: autoAddForTransfer
            ? "INVENTORY_TRANSFER_AUTO_ADD"
            : "INVENTORY_ADJUSTMENT",
          entityType: "INVENTORY",
          entityId: body.productId,
          action: autoAddForTransfer
            ? `Auto-added ${body.delta} units of "${productName}" at location ${body.locationId} to complete a transfer`
            : `Adjusted inventory for "${productName}" by ${body.delta > 0 ? "+" : ""}${body.delta}`,
          // Phase C (P-C5): persist the operator's own words when supplied — zod
          // used to strip these. Included only when present so no-reason callers
          // (transfer auto-add, workbench undo, journal) keep their lean details.
          details: {
            ...(autoAddForTransfer
              ? {
                  productId: body.productId,
                  productName,
                  delta: body.delta,
                  locationId: body.locationId,
                }
              : { productName, delta: body.delta, locationId: body.locationId }),
            ...(body.reason ? { reason: body.reason } : {}),
            ...(body.notes ? { notes: body.notes } : {}),
          },
          batchId,
        });
      },
    }
  );

  const response = NextResponse.json({
    success: true,
    log: result.log,
    newVersion: result.newVersion,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
