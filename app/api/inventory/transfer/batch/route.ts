import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import {
  createInventoryTransfer,
  validateStockAvailability,
  OptimisticLockError,
} from "@/lib/inventory";
import { BatchTransferSchema } from "@/lib/validation/inventory";
import { recordChange, newBatchId } from "@/lib/change-tracking";
import { applyRateLimitHeaders, enforceRateLimit } from "@/lib/rateLimit";
import type { BatchTransferResult } from "@/types/inventory";

export const dynamic = "force-dynamic";

/**
 * POST /api/inventory/transfer/batch
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, "inventory:transfer:batch", {
    identifier: user.id,
  });

  await requireCSRF(request);

  const body = BatchTransferSchema.parse(await request.json());

  // Validate that none of the source locations match the destination
  const invalidTransfers = body.transfers.filter(
    (t) => t.fromLocationId === body.toLocationId
  );
  if (invalidTransfers.length > 0) {
    return NextResponse.json(
      {
        error: "Source location cannot be the same as destination",
        invalidLocations: invalidTransfers.map((t) => t.fromLocationId),
      },
      { status: 400 }
    );
  }

  // Get product and destination location info
  const [product, toLocation] = await Promise.all([
    prisma.product.findFirst({
      where: { id: body.productId, deletedAt: null },
      select: { id: true, name: true },
    }),
    prisma.location.findUnique({
      where: { id: body.toLocationId },
      select: { id: true, name: true },
    }),
  ]);

  if (!product) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }
  if (!toLocation) {
    return NextResponse.json({ error: "Destination location not found" }, { status: 404 });
  }

  // Get all source locations
  const sourceLocationIds = body.transfers.map((t) => t.fromLocationId);
  const sourceLocations = await prisma.location.findMany({
    where: { id: { in: sourceLocationIds } },
    select: { id: true, name: true },
  });
  const sourceLocationMap = new Map<number, { id: number; name: string }>();
  for (const l of sourceLocations) {
    sourceLocationMap.set(l.id, l);
  }

  // Validate all source locations exist
  const missingLocations = sourceLocationIds.filter((id) => !sourceLocationMap.has(id));
  if (missingLocations.length > 0) {
    return NextResponse.json(
      { error: "Some source locations not found", missingLocations },
      { status: 404 }
    );
  }

  // Pre-validate stock availability for all transfers
  const availabilityChecks = await Promise.all(
    body.transfers.map(async (t) => ({
      fromLocationId: t.fromLocationId,
      quantity: t.quantity,
      availability: await validateStockAvailability(body.productId, t.fromLocationId, t.quantity),
    }))
  );

  const insufficientStock = availabilityChecks.filter((c) => !c.availability.isValid);
  if (insufficientStock.length > 0) {
    return NextResponse.json(
      {
        error: "Insufficient stock at one or more source locations",
        code: "INVENTORY_INSUFFICIENT_STOCK",
        details: insufficientStock.map((c) => ({
          fromLocationId: c.fromLocationId,
          fromLocationName: sourceLocationMap.get(c.fromLocationId)?.name,
          currentQuantity: c.availability.currentQuantity,
          requestedQuantity: c.quantity,
          shortfall: c.availability.shortfall,
        })),
      },
      { status: 400 }
    );
  }

  // One batch id shared by every transfer's change record in this request.
  const batchId = newBatchId();

  // Execute transfers sequentially (all sharing the same change-tracking batch)
  const results: BatchTransferResult["results"] = [];
  let totalTransferred = 0;

  for (const transfer of body.transfers) {
    try {
      const fromLocation = sourceLocationMap.get(transfer.fromLocationId)!;
      const _result = await createInventoryTransfer({
        userId: user.id,
        productId: body.productId,
        fromLocationId: transfer.fromLocationId,
        toLocationId: body.toLocationId,
        quantity: transfer.quantity,
        expectedFromVersion: transfer.expectedVersion,
        record: async (tx) => {
          await recordChange(tx, {
            actor: { userId: user.id },
            actionType: "INVENTORY_TRANSFER",
            entityType: "INVENTORY",
            entityId: product.id,
            action: `Transferred ${transfer.quantity} units of "${product.name}" from ${fromLocation.name} → ${toLocation.name}`,
            details: {
              productId: product.id,
              productName: product.name,
              quantity: transfer.quantity,
              fromLocationId: fromLocation.id,
              fromLocationName: fromLocation.name,
              toLocationId: toLocation.id,
              toLocationName: toLocation.name,
            },
            batchId,
          });
        },
      });

      results.push({
        fromLocationId: transfer.fromLocationId,
        quantity: transfer.quantity,
        success: true,
      });
      totalTransferred += transfer.quantity;
    } catch (error) {
      const errorMessage =
        error instanceof OptimisticLockError
          ? "Inventory was modified by another user"
          : error instanceof Error
            ? error.message
            : "Unknown error";

      results.push({
        fromLocationId: transfer.fromLocationId,
        quantity: transfer.quantity,
        success: false,
        error: errorMessage,
      });
    }
  }

  const allSucceeded = results.every((r) => r.success);
  const response: BatchTransferResult = {
    success: allSucceeded,
    results,
    totalTransferred,
    batchId,
  };

  const httpResponse = NextResponse.json(response, {
    status: allSucceeded ? 200 : 207,
  });
  return applyRateLimitHeaders(httpResponse, rateLimitHeaders);
});
