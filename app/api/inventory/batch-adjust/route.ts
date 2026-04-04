import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { auditService } from "@/lib/audit";
import { validateCSRFToken } from "@/lib/csrf";
import { BatchInventoryAdjustmentSchema } from "@/lib/validation/inventory";
import { enforceRateLimit, RateLimitError, applyRateLimitHeaders } from "@/lib/rateLimit";

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
  const results = await prisma.$transaction(async (tx: any) => {
    const logs: any[] = [];
    const auditUpdates: Array<{ productId: number; productName: string; delta: number }> = [];

    for (const adjustment of adjustments) {
      try {
        // Get current inventory with lock
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
          // Create new inventory record if it doesn't exist
          await tx.product_locations.create({
            data: {
              productId: adjustment.productId,
              locationId: adjustment.locationId,
              quantity: adjustment.delta > 0 ? adjustment.delta : 0,
              version: 1,
            },
          });

          if (adjustment.delta < 0) {
            throw new Error(
              `No inventory found for product ${adjustment.productId} at location ${adjustment.locationId}`
            );
          }

          // Create log entry for new inventory
          const log = await tx.inventory_logs.create({
            data: {
              productId: adjustment.productId,
              locationId: adjustment.locationId,
              userId: user.id,
              delta: adjustment.delta,
              changeTime: new Date(),
              logType: "ADJUSTMENT",
            },
          });

          logs.push(log);

          auditUpdates.push({
            productId: adjustment.productId,
            productName: productMap.get(adjustment.productId) || "Unknown Product",
            delta: adjustment.delta,
          });

          continue;
        }

        // Check version if provided (optimistic locking)
        if (
          adjustment.expectedVersion !== undefined &&
          inventory.version !== adjustment.expectedVersion
        ) {
          throw new Error(`Inventory has been modified by another user`);
        }

        const newQuantity = inventory.quantity + adjustment.delta;
        if (newQuantity < 0) {
          throw new Error(
            `Insufficient inventory: current ${inventory.quantity}, trying to remove ${Math.abs(adjustment.delta)}`
          );
        }

        // Update inventory
        await tx.product_locations.update({
          where: { id: inventory.id },
          data: {
            quantity: newQuantity,
            version: { increment: 1 },
          },
        });

        // Create log entry
        const log = await tx.inventory_logs.create({
          data: {
            productId: adjustment.productId,
            locationId: adjustment.locationId,
            userId: user.id,
            delta: adjustment.delta,
            changeTime: new Date(),
            logType: "ADJUSTMENT",
          },
        });

        logs.push(log);

        auditUpdates.push({
          productId: adjustment.productId,
          productName: productMap.get(adjustment.productId) || "Unknown Product",
          delta: adjustment.delta,
        });
      } catch (error: any) {
        throw new Error(`Product ${adjustment.productId}: ${error.message || "Unknown error"}`);
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
