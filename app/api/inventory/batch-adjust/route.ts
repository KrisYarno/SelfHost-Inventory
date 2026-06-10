import { NextRequest, NextResponse } from "next/server";
import { Prisma, type inventory_logs } from "@prisma/client";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { auditService } from "@/lib/audit";
import { validateCSRFToken } from "@/lib/csrf";
import { applyStockDelta, OptimisticLockError } from "@/lib/inventory";
import { BatchInventoryAdjustmentSchema } from "@/lib/validation/inventory";
import { enforceRateLimit, applyRateLimitHeaders } from "@/lib/rateLimit";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, "inventory:batch-adjust", {
    identifier: user.id,
  });

  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
  }

  const { adjustments } = BatchInventoryAdjustmentSchema.parse(await request.json());

  // Get product names for audit logging
  const productIds = adjustments.map((adj) => adj.productId);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, name: true },
  });
  const productMap = new Map(products.map((p) => [p.id, p.name]));

  // Execute all adjustments in a transaction
  const results = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const logs: inventory_logs[] = [];
    const auditUpdates: Array<{ productId: number; productName: string; delta: number }> = [];

    for (const adjustment of adjustments) {
      try {
        // Read current inventory for validation (version check + stock floor).
        // The actual write below is a relative increment, so a stale read here
        // can no longer cause a lost update.
        const inventory = await tx.product_locations.findFirst({
          where: {
            productId: adjustment.productId,
            locationId: adjustment.locationId,
          },
          select: {
            id: true,
            quantity: true,
            version: true,
          },
        });

        if (!inventory) {
          // No record yet: applyStockDelta's upsert will create it, but a
          // negative delta against nothing is an error.
          if (adjustment.delta < 0) {
            throw new Error(
              `No inventory found for product ${adjustment.productId} at location ${adjustment.locationId}`
            );
          }
        } else {
          // Check version if provided (optimistic locking)
          if (
            adjustment.expectedVersion !== undefined &&
            inventory.version !== adjustment.expectedVersion
          ) {
            throw new OptimisticLockError(
              "Inventory has been modified by another user",
              inventory.version,
              adjustment.expectedVersion
            );
          }

          const newQuantity = inventory.quantity + adjustment.delta;
          if (newQuantity < 0) {
            throw new Error(
              `Insufficient inventory: current ${inventory.quantity}, trying to remove ${Math.abs(adjustment.delta)}`
            );
          }
        }

        // Atomic write path shared with the other stock routes:
        // log + product_locations upsert (quantity/version increment)
        // + Product.quantity mirror for location 1.
        const { log } = await applyStockDelta(tx, {
          userId: user.id,
          productId: adjustment.productId,
          locationId: adjustment.locationId,
          delta: adjustment.delta,
          logType: adjustment.logType,
        });

        // applyStockDelta's log includes full relations (users incl.
        // passwordHash) — strip to scalars before exposing in the response.
        const { users: _u, products: _p, locations: _l, ...logScalars } = log;
        logs.push(logScalars);

        auditUpdates.push({
          productId: adjustment.productId,
          productName: productMap.get(adjustment.productId) || "Unknown Product",
          delta: adjustment.delta,
        });
      } catch (error) {
        // Preserve the typed conflict so apiHandler can map it to 409
        if (error instanceof OptimisticLockError) throw error;
        throw new Error(
          `Product ${adjustment.productId}: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    }

    return { logs, auditUpdates };
  });

  // Log the bulk inventory update after successful transaction
  if (results.auditUpdates.length > 0) {
    await auditService.logBulkInventoryUpdate(
      user.id,
      results.auditUpdates,
      adjustments[0]?.locationId
    );
  }

  const response = NextResponse.json({
    success: true,
    logs: results.logs,
    count: results.logs.length,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
