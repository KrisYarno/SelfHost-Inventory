import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, requireCompanyMembership, apiHandler } from '@/lib/api-utils';
import { validateCSRFToken } from '@/lib/csrf';
import { UnfulfillRequestSchema } from '@/lib/validation/unfulfill';
import {
  applyRateLimitHeaders,
  enforceRateLimit,
} from '@/lib/rateLimit';
import { auditService } from '@/lib/audit';
import { AppError } from '@/lib/error-handling';
import prisma from '@/lib/prisma';
import { Prisma, inventory_logs_logType } from '@prisma/client';
import { createInventoryLog } from '@/lib/inventory';
import { pushOrderStatusToExternal } from '@/lib/external-orders/shared';
import { pushStockForProducts } from '@/lib/external-orders/stock-sync';

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

  // P0-4: Verify user belongs to the order's company.
  const orderCompany = await prisma.externalOrder.findUnique({
    where: { id: params.orderId },
    select: { companyId: true },
  });
  if (!orderCompany) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  }
  await requireCompanyMembership(user.id, orderCompany.companyId, user.isAdmin);

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

  // P0-3: Component productIds restored for bundle items (used to push bundle WC stock)
  const restoredComponentIds: number[] = [];

  let newOrderStatus: string = '';
  let orderExternalId: string = '';
  let orderIntegrationId: string = '';

  await prisma.$transaction(
    async (tx) => {
      // Load order with productLink for productId verification (P1-4)
      const order = await tx.externalOrder.findUnique({
        where: { id: params.orderId },
        include: {
          items: {
            include: {
              productLink: {
                select: {
                  internalProductId: true,
                  isBundle: true,
                  bundleComponents: {
                    orderBy: { sortOrder: 'asc' },
                  },
                },
              },
            },
          },
          integration: {
            select: {
              id: true,
              fulfillmentPushEnabled: true,
            },
          },
        },
      });

      if (!order) {
        throw new AppError(`Order ${params.orderId} not found`, 'ORDER_NOT_FOUND', 404);
      }

      if (order.internalStatus === 'cancelled') {
        throw new AppError(`Cannot unfulfill cancelled order ${params.orderId}`, 'ORDER_CANCELLED', 400);
      }

      // Capture external order info for fulfillment push
      orderExternalId = order.externalId;
      orderIntegrationId = order.integrationId;

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

        // Bundle reversal path: isBundle=true → expand into per-component restorations
        if (orderItem.isMapped && orderItem.productLink?.isBundle) {
          type SnapshotComponent = {
            internalProductId: number;
            quantity: number;
            internalProductName?: string;
          };

          // D7: prefer frozen snapshot; fall back to live bundleComponents for legacy rows
          const snapshot = orderItem.bundleComponentSnapshot as
            | SnapshotComponent[]
            | null;
          const components: SnapshotComponent[] =
            snapshot ?? (orderItem.productLink.bundleComponents as SnapshotComponent[]);

          if (!components || components.length === 0) {
            skipped.push({
              itemId: unfulfillItem.itemId,
              reason: `Bundle item ${orderItem.id} has no components in snapshot or live mapping`,
            });
            continue;
          }

          // Atomic fulfilledQty decrement for the bundle item
          const bundleFulfilledAffected = await tx.$executeRaw(Prisma.sql`
            UPDATE external_order_items
            SET fulfilledQty = fulfilledQty - ${unfulfillItem.quantity}
            WHERE id = ${unfulfillItem.itemId}
              AND fulfilledQty >= ${unfulfillItem.quantity}
          `);

          if (bundleFulfilledAffected === 0) {
            skipped.push({
              itemId: unfulfillItem.itemId,
              reason: `Cannot unfulfill: insufficient fulfilled quantity (concurrent modification or already reversed)`,
            });
            continue;
          }

          // Restore each component inside the same transaction (all-or-nothing)
          for (const component of components) {
            const restoreQty = component.quantity * unfulfillItem.quantity;

            await createInventoryLog(
              {
                userId: user.id,
                productId: component.internalProductId,
                locationId: unfulfillItem.locationId,
                delta: +restoreQty, // POSITIVE (restoration)
                logType: inventory_logs_logType.ADJUSTMENT,
              },
              tx
            );

            // Atomic product_locations increment for this component
            const compPlAffected = await tx.$executeRaw(Prisma.sql`
              UPDATE product_locations
              SET quantity = quantity + ${restoreQty},
                  version = version + 1,
                  updatedAt = NOW()
              WHERE productId = ${component.internalProductId}
                AND locationId = ${unfulfillItem.locationId}
            `);

            if (compPlAffected === 0) {
              // Row doesn't exist — create it with the restored quantity
              await tx.product_locations.create({
                data: {
                  productId: component.internalProductId,
                  locationId: unfulfillItem.locationId,
                  quantity: restoreQty,
                  version: 1,
                },
              });
            }

            // Legacy product.quantity mirror for location 1 (atomic)
            if (unfulfillItem.locationId === 1) {
              await tx.$executeRaw(Prisma.sql`
                UPDATE products
                SET quantity = quantity + ${restoreQty}
                WHERE id = ${component.internalProductId}
              `);
            }
          }

          restored.push({
            itemId: unfulfillItem.itemId,
            productId: -1, // Bundle — no single productId
            quantity: unfulfillItem.quantity,
            locationId: unfulfillItem.locationId,
            inventoryLogId: -1, // Multiple logs created; use sentinel
          });

          // P0-3: Accumulate component IDs so the route can push bundle WC stock
          for (const component of components) {
            if (!restoredComponentIds.includes(component.internalProductId)) {
              restoredComponentIds.push(component.internalProductId);
            }
          }

          continue; // Skip the single-mapping path below
        }

        // P1-4: Verify productId matches the item's mapping. Rejects client-supplied
        // productId values that don't correspond to what was actually fulfilled.
        if (
          !orderItem.productLink ||
          orderItem.productLink.internalProductId !== unfulfillItem.productId
        ) {
          skipped.push({
            itemId: unfulfillItem.itemId,
            reason: `Product mismatch: item is mapped to product ${orderItem.productLink?.internalProductId ?? 'none'}, not ${unfulfillItem.productId}`,
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

        // Atomic fulfilledQty decrement with guard. Race-safe: concurrent unfulfills
        // for the same item cannot both succeed because the WHERE fulfilledQty >= ?
        // is evaluated at UPDATE time.
        const fulfilledAffected = await tx.$executeRaw(Prisma.sql`
          UPDATE external_order_items
          SET fulfilledQty = fulfilledQty - ${unfulfillItem.quantity}
          WHERE id = ${unfulfillItem.itemId}
            AND fulfilledQty >= ${unfulfillItem.quantity}
        `);

        if (fulfilledAffected === 0) {
          skipped.push({
            itemId: unfulfillItem.itemId,
            reason: `Cannot unfulfill: insufficient fulfilled quantity (concurrent modification or already reversed)`,
          });
          continue;
        }

        // Create inventory log (restoration) — only after fulfilledQty decrement succeeded
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

        // Atomic product_locations increment. No WHERE quantity guard needed because
        // we're adding stock, but we handle the missing-row case by creating.
        const plAffected = await tx.$executeRaw(Prisma.sql`
          UPDATE product_locations
          SET quantity = quantity + ${unfulfillItem.quantity},
              version = version + 1,
              updatedAt = NOW()
          WHERE productId = ${unfulfillItem.productId}
            AND locationId = ${unfulfillItem.locationId}
        `);

        if (plAffected === 0) {
          // Row doesn't exist — create it with the restored quantity
          await tx.product_locations.create({
            data: {
              productId: unfulfillItem.productId,
              locationId: unfulfillItem.locationId,
              quantity: unfulfillItem.quantity,
              version: 1,
            },
          });
        }

        // Legacy product.quantity mirror for location 1 (atomic)
        if (unfulfillItem.locationId === 1) {
          await tx.$executeRaw(Prisma.sql`
            UPDATE products
            SET quantity = quantity + ${unfulfillItem.quantity}
            WHERE id = ${unfulfillItem.productId}
          `);
        }

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

      const totalFulfilled = allItems.reduce(
        (sum, item) => sum + item.fulfilledQty,
        0
      );

      // stockedOut separation: unfulfill writes stockedOut but NEVER writes
      // internalStatus (that's WC's domain). If all items are restored,
      // clear stockedOut. If some remain fulfilled, keep it true.
      const stillStockedOut = totalFulfilled > 0;

      await tx.externalOrder.update({
        where: { id: params.orderId },
        data: {
          stockedOut: stillStockedOut,
          stockedOutAt: stillStockedOut ? order.stockedOutAt : null,
          stockedOutBy: stillStockedOut ? order.stockedOutBy : null,
          fulfilledAt: stillStockedOut ? order.fulfilledAt : null,
          fulfilledBy: stillStockedOut ? order.fulfilledBy : null,
        },
      });

      newOrderStatus = order.internalStatus;
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

  // Push status revert to external platform (best-effort, never fails the unfulfillment)
  if (orderIntegrationId && orderExternalId && restored.length > 0) {
    try {
      const integration = await prisma.integration.findUnique({
        where: { id: orderIntegrationId },
        select: { fulfillmentPushEnabled: true },
      });

      if (integration?.fulfillmentPushEnabled) {
        // If totalFulfilled became 0: push 'processing' (safe revert, WC doesn't have 'pending')
        // Otherwise still partially fulfilled: push 'processing'
        const wcStatus = 'processing';

        const pushResult = await pushOrderStatusToExternal(
          orderIntegrationId,
          orderExternalId,
          wcStatus
        );

        if (!pushResult.success) {
          console.error(
            `Unfulfillment push failed for order ${params.orderId}:`,
            pushResult.error
          );
        }
      }
    } catch (pushError) {
      console.error(
        `Unfulfillment push error for order ${params.orderId}:`,
        pushError
      );
      // Don't fail the unfulfillment. Log for manual follow-up.
    }
  }

  // Phase 7f / P0-3: Best-effort stock status push for products that were restored.
  // For single-product items, pass their productId directly.
  // For bundle items, pass the component IDs (restoredComponentIds) so that
  // pushStockForProducts can also find and push the bundle's WC stock_status.
  // The -1 sentinel is filtered out — only positive productIds are meaningful here.
  if (orderIntegrationId && restored.length > 0) {
    const singleProductIds = restored
      .map((r) => r.productId)
      .filter((id) => id > 0);
    const uniqueProductIds = Array.from(
      new Set([...singleProductIds, ...restoredComponentIds])
    );
    if (uniqueProductIds.length > 0) {
      pushStockForProducts(orderIntegrationId, uniqueProductIds).catch(
        (err) => {
          console.error(
            `Post-unfulfillment stock push failed for order ${params.orderId}:`,
            err
          );
        }
      );
    }
  }

  const response = NextResponse.json({
    success: true,
    restored,
    skipped,
    newOrderStatus,
  });

  return applyRateLimitHeaders(response, rateLimitHeaders);
});
