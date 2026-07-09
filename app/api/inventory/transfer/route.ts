import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import {
  createInventoryTransfer,
  validateStockAvailability,
} from "@/lib/inventory";
import { TransferSchema } from "@/lib/validation/inventory";
import { recordChange, newBatchId } from "@/lib/change-tracking";
import { applyRateLimitHeaders, enforceRateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, "inventory:transfer", {
    identifier: user.id,
  });

  await requireCSRF(request);

  const body = TransferSchema.parse(await request.json());

  // Early availability check for better UX
  const availability = await validateStockAvailability(
    body.productId,
    body.fromLocationId,
    body.quantity
  );
  if (!availability.isValid) {
    return NextResponse.json(
      {
        error: availability.error || "Insufficient stock at source location",
        code: "INVENTORY_INSUFFICIENT_STOCK",
        currentQuantity: availability.currentQuantity,
        requestedQuantity: availability.requestedQuantity,
        shortfall: availability.shortfall,
      },
      { status: 400 }
    );
  }

  const [product, fromLocation, toLocation] = await Promise.all([
    prisma.product.findUnique({
      where: { id: body.productId },
      select: { id: true, name: true },
    }),
    prisma.location.findUnique({
      where: { id: body.fromLocationId },
      select: { id: true, name: true },
    }),
    prisma.location.findUnique({
      where: { id: body.toLocationId },
      select: { id: true, name: true },
    }),
  ]);

  if (!product || !fromLocation || !toLocation) {
    return NextResponse.json({ error: "Product or location not found" }, { status: 404 });
  }

  // One batch id per transfer flow; recorded inside the transfer's transaction
  // (both legs share it), so an unrecordable transfer never commits.
  const batchId = newBatchId();

  const result = await createInventoryTransfer({
    userId: user.id,
    productId: body.productId,
    fromLocationId: body.fromLocationId,
    toLocationId: body.toLocationId,
    quantity: body.quantity,
    expectedFromVersion: body.expectedFromVersion,
    expectedToVersion: body.expectedToVersion,
    record: async (tx) => {
      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: "INVENTORY_TRANSFER",
        entityType: "INVENTORY",
        entityId: product.id,
        action: `Transferred ${body.quantity} units of "${product.name}" from ${fromLocation.name} → ${toLocation.name}`,
        details: {
          productId: product.id,
          productName: product.name,
          quantity: body.quantity,
          fromLocationId: fromLocation.id,
          fromLocationName: fromLocation.name,
          toLocationId: toLocation.id,
          toLocationName: toLocation.name,
        },
        batchId,
      });
    },
  });

  const response = NextResponse.json({
    success: true,
    fromLocationId: body.fromLocationId,
    toLocationId: body.toLocationId,
    quantity: body.quantity,
    fromVersion: result.fromVersion,
    toVersion: result.toVersion,
    logs: result.logs,
    batchId,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
