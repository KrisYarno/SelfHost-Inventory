import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler } from '@/lib/api-utils';
import { validateCSRFToken } from '@/lib/csrf';
import { UnfulfillRequestSchema } from '@/lib/validation/unfulfill';
import {
  applyRateLimitHeaders,
  enforceRateLimit,
} from '@/lib/rateLimit';
import { auditService } from '@/lib/audit';
import { AppError } from '@/lib/error-handling';
import prisma from '@/lib/prisma';
import { inventory_logs_logType } from '@prisma/client';
import { createInventoryLog } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export const POST = apiHandler(async (
  request: NextRequest,
  { params }: { params: { orderId: string } }
) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'orders:unfulfill', {
    identifier: user.id,
  });

  // Validate CSRF token
  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

  const body = UnfulfillRequestSchema.parse(await request.json());

  const restored: Array<{
    itemId: string;
    productId: number;
    quantity: number;
    locationId: number;
    inventoryLogId: number;
  }> = [];

  const skipped: Array<{
    itemId: string;
    reason: string;
  }> = [];

  let newOrderStatus: string = '';

  await prisma.$transaction(
    async (tx) => {
      // Amendment 2: Load order at top of transaction
      const order = await tx.externalOrder.findUnique({
        where: { id: params.orderId },
        include: { items: true },
      });

      if (!order) {
        throw new AppError(`Order ${params.orderId} not found`, 'ORDER_NOT_FOUND', 404);
      }

      if (order.internalStatus === 'cancelled') {
        throw new AppError(`Cannot unfulfill cancelled order ${params.orderId}`, 'ORDER_CANCELLED', 400);
      }

      // Process each unfulfillment item
      for (const unfulfillItem of body.items) {
        // Find the order item in the loaded order
        const orderItem = order.items.find(
          (item) => item.id === unfulfillItem.itemId
        );

        if (!orderItem) {
          skipped.push({
            itemId: unfulfillItem.itemId,
            reason: 'Item not found in order',
          });
          continue;
        }

        // Validate fulfilledQty >= requested quantity
        if (orderItem.fulfilledQty < unfulfillItem.quantity) {
          skipped.push({
            itemId: unfulfillItem.itemId,
            reason: `Cannot unfulfill more than was fulfilled (fulfilled: ${orderItem.fulfilledQty}, requested: ${unfulfillItem.quantity})`,
          });
          continue;
        }

        // Amendment 3: Check product exists (could be soft-deleted)
        const product = await tx.product.findUnique({
          where: { id: unfulfillItem.productId },
          select: { id: true, deletedAt: true },
        });

        if (!product || product.deletedAt) {
          skipped.push({
            itemId: unfulfillItem.itemId,
            reason: `Product ${unfulfillItem.productId} not found or deleted — stock not restored`,
          });
          continue;
        }

        // Amendment 1: Use createInventoryLog (thin wrapper, NOT createInventoryAdjustment)
        const log = await createInventoryLog(
          {
            userId: user.id,
            productId: unfulfillItem.productId,
            locationId: unfulfillItem.locationId,
            delta: +unfulfillItem.quantity, // POSITIVE (restoration)
            logType: inventory_logs_logType.ADJUSTMENT,
          },
          tx
        );

        // Update product_locations (same upsert pattern as fulfillment)
        await tx.product_locations.upsert({
          where: {
            productId_locationId: {
              productId: unfulfillItem.productId,
              locationId: unfulfillItem.locationId,
            },
          },
          update: {
            quantity: {
              increment: unfulfillItem.quantity,
            },
            version: {
              increment: 1,
            },
          },
          create: {
            productId: unfulfillItem.productId,
            locationId: unfulfillItem.locationId,
            quantity: unfulfillItem.quantity,
            version: 1,
          },
        });

        // Legacy product.quantity for location 1 (compatibility)
        if (unfulfillItem.locationId === 1) {
          await tx.product.update({
            where: { id: unfulfillItem.productId },
            data: { quantity: { increment: unfulfillItem.quantity } },
          });
        }

        // Amendment 4: Atomic Prisma decrement for fulfilledQty
        await tx.externalOrderItem.update({
          where: { id: unfulfillItem.itemId },
          data: {
            fulfilledQty: {
              decrement: unfulfillItem.quantity,
            },
          },
        });

        restored.push({
          itemId: unfulfillItem.itemId,
          productId: unfulfillItem.productId,
          quantity: unfulfillItem.quantity,
          locationId: unfulfillItem.locationId,
          inventoryLogId: log.id,
        });
      }

      // Recalculate order status after all items
      const allItems = await tx.externalOrderItem.findMany({
        where: { orderId: order.id },
        select: {
          quantity: true,
          fulfilledQty: true,
        },
      });

      const totalQuantity = allItems.reduce(
        (sum, item) => sum + item.quantity,
        0
      );
      const totalFulfilled = allItems.reduce(
        (sum, item) => sum + item.fulfilledQty,
        0
      );

      let status: string;
      let fulfilledAt: Date | null = order.fulfilledAt;
      let fulfilledBy: number | null = order.fulfilledBy;

      if (totalFulfilled === 0) {
        status = 'pending';
        fulfilledAt = null;
        fulfilledBy = null;
      } else if (totalFulfilled < totalQuantity) {
        status = 'processing';
      } else {
        // Shouldn't happen after unfulfill but handle gracefully
        status = 'fulfilled';
      }

      await tx.externalOrder.update({
        where: { id: params.orderId },
        data: {
          internalStatus: status,
          fulfilledAt,
          fulfilledBy,
        },
      });

      newOrderStatus = status;
    },
    {
      timeout: 30000, // 30 second timeout matching fulfillment
    }
  );

  // Audit log (outside transaction)
  try {
    if (restored.length > 0) {
      await auditService.log({
        userId: user.id,
        actionType: 'EXTERNAL_ORDER_UNFULFILLMENT',
        entityType: 'INVENTORY',
        action: `Unfulfilled external order ${params.orderId}`,
        details: {
          orderId: params.orderId,
          items: restored,
          skipped,
          notes: body.notes,
        },
        affectedCount: restored.length,
      });
    }
  } catch (auditError) {
    console.error('Failed to log audit unfulfillment:', auditError);
  }

  const response = NextResponse.json({
    success: true,
    restored,
    skipped,
    newOrderStatus,
  });

  return applyRateLimitHeaders(response, rateLimitHeaders);
});
