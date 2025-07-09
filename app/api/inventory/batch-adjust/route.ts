import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { auditService } from "@/lib/audit";

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { adjustments, type } = body;

    // Manual validation
    if (!adjustments || !Array.isArray(adjustments)) {
      return NextResponse.json(
        { error: "Invalid request data: adjustments must be an array" },
        { status: 400 }
      );
    }

    for (const adj of adjustments) {
      if (typeof adj.productId !== 'number' || typeof adj.locationId !== 'number' || typeof adj.delta !== 'number') {
        return NextResponse.json(
          { error: "Invalid adjustment data: productId, locationId, and delta must be numbers" },
          { status: 400 }
        );
      }
    }

    // Get product names for audit logging
    const productIds = adjustments.map((adj: any) => adj.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true }
    });
    const productMap = new Map(products.map(p => [p.id, p.name]));

    // Execute all adjustments in a transaction
    const results = await prisma.$transaction(async (tx: any) => {
      const logs = [];
      const auditUpdates = [];

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
            const newInventory = await tx.product_locations.create({
              data: {
                productId: adjustment.productId,
                locationId: adjustment.locationId,
                quantity: adjustment.delta > 0 ? adjustment.delta : 0,
                version: 1,
              },
            });

            if (adjustment.delta < 0) {
              throw new Error(`No inventory found for product ${adjustment.productId} at location ${adjustment.locationId}`);
            }

            // Create log entry for new inventory
            const log = await tx.inventory_logs.create({
              data: {
                productId: adjustment.productId,
                locationId: adjustment.locationId,
                userId: session.user.id,
                delta: adjustment.delta,
                changeTime: new Date(),
                logType: "ADJUSTMENT",
              },
            });

            logs.push(log);
            
            // Collect audit info for new inventory
            auditUpdates.push({
              productId: adjustment.productId,
              productName: productMap.get(adjustment.productId) || 'Unknown Product',
              delta: adjustment.delta
            });
            
            continue;
          }

          // Check version if provided (optimistic locking)
          if (adjustment.expectedVersion !== undefined && inventory.version !== adjustment.expectedVersion) {
            throw new Error(`Inventory has been modified by another user`);
          }

          const newQuantity = inventory.quantity + adjustment.delta;
          if (newQuantity < 0) {
            throw new Error(`Insufficient inventory: current ${inventory.quantity}, trying to remove ${Math.abs(adjustment.delta)}`);
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
              userId: parseInt(session.user.id),
              delta: adjustment.delta,
              changeTime: new Date(),
              logType: "ADJUSTMENT",
            },
          });

          logs.push(log);
          
          // Collect audit info
          auditUpdates.push({
            productId: adjustment.productId,
            productName: productMap.get(adjustment.productId) || 'Unknown Product',
            delta: adjustment.delta
          });
        } catch (error: any) {
          // Re-throw with product context
          throw new Error(`Product ${adjustment.productId}: ${error.message || 'Unknown error'}`);
        }
      }

      return { logs, auditUpdates };
    });

    // Log the bulk inventory update after successful transaction
    if (results.auditUpdates.length > 0) {
      await auditService.logBulkInventoryUpdate(
        parseInt(session.user.id),
        results.auditUpdates,
        adjustments[0]?.locationId // Assuming all adjustments are for the same location
      );
    }

    return NextResponse.json({ 
      success: true, 
      logs: results.logs,
      count: results.logs.length 
    });

  } catch (error: any) {
    console.error("Batch adjustment error:", error);

    // Check if it's an optimistic lock error
    if (error.message?.includes("modified by another user")) {
      return NextResponse.json(
        { 
          error: {
            message: "One or more items have been modified by another user. Please refresh and try again.",
            code: "OPTIMISTIC_LOCK_ERROR"
          }
        },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { 
        error: {
          message: error?.message || "Failed to process batch adjustments",
          code: "BATCH_OPERATION_FAILED"
        }
      },
      { status: 500 }
    );
  }
}