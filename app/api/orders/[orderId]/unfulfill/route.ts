import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, requireCompanyMembership, apiHandler, requireCSRF } from '@/lib/api-utils';
import { UnfulfillRequestSchema } from '@/lib/validation/unfulfill';
import {
  BUNDLE_SENTINEL_PRODUCT_ID,
  BUNDLE_SENTINEL_INVENTORY_LOG_ID,
} from '@/lib/external-orders/constants';
import { resolveBundleComponents } from '@/lib/external-orders/bundle-snapshot';
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

  await requireCSRF(request);

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
    /** P0 #6: For bundle items, the per-item component productIds restored. */
    componentIds?: number[];
    isBundle?: boolean;
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
          // FIX B (P0): D7 invariant — fulfill now freezes the snapshot at first
          // fulfill (for both legacy and new items). Unfulfill MUST read from the
          // frozen snapshot, never the live composition — otherwise a PATCH to
          // the bundle between fulfill and unfulfill would restore stock for
          // components that were never deducted (phantom inventory).
          //
          // Post-Fix-B, any item with fulfilledQty > 0 must have a snapshot. If
          // we see snapshot=null with fulfilledQty>0, it's a data-integrity bug;
          // refuse to restore so we don't compound the issue.
          if (
            orderItem.bundleComponentSnapshot === null ||
            orderItem.bundleComponentSnapshot === undefined
          ) {
            if (orderItem.fulfilledQty > 0) {
              skipped.push({
                itemId: unfulfillItem.itemId,
                reason: `Bundle item ${orderItem.id} has fulfilledQty=${orderItem.fulfilledQty} but no bundleComponentSnapshot — refusing to restore (data integrity error, please investigate)`,
              });
              continue;
            }
            // snapshot=null AND fulfilledQty=0 — the fulfilledQty decrement
            // below will return 0 affected rows and skip naturally; we still
            // resolve from live so the downstream empty-components check
            // fires consistently for legacy rows.
          }

          // FIX G: shared helper handles snapshot Zod parse + normalize + fallback.
          const resolved = resolveBundleComponents(
            orderItem.bundleComponentSnapshot,
            orderItem.productLink.bundleComponents,
          );

          if (!resolved.ok) {
            if (resolved.reason === 'malformed_snapshot') {
              skipped.push({
                itemId: unfulfillItem.itemId,
                reason: `Bundle item ${orderItem.id} has malformed bundleComponentSnapshot: ${resolved.detail}`,
              });
            } else {
              // 'empty' — no components in snapshot OR live mapping
              skipped.push({
                itemId: unfulfillItem.itemId,
                reason: `Bundle item ${orderItem.id} has no components in snapshot or live mapping`,
              });
            }
            continue;
          }

          const components = resolved.components;

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

          // Per-item component IDs for clean public response (Fix C P0 #6)
          const itemComponentIds = components.map((c) => c.internalProductId);

          restored.push({
            itemId: unfulfillItem.itemId,
            productId: BUNDLE_SENTINEL_PRODUCT_ID,
            quantity: unfulfillItem.quantity,
            locationId: unfulfillItem.locationId,
            inventoryLogId: BUNDLE_SENTINEL_INVENTORY_LOG_ID,
            isBundle: true,
            componentIds: itemComponentIds,
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

  // FIX C (P0 #6): Sanitize restored entries — bundle items carry the
  // BUNDLE_SENTINEL_PRODUCT_ID (-1) internally; replace with {isBundle,
  // componentIds} so audit logs and API consumers never see the sentinel.
  const publicRestored = restored.map((r) => {
    if (r.productId === BUNDLE_SENTINEL_PRODUCT_ID) {
      const { productId: _pid, inventoryLogId: _lid, ...rest } = r;
      void _pid;
      void _lid;
      return {
        ...rest,
        isBundle: true,
        componentIds: r.componentIds ?? [],
      };
    }
    return r;
  });

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
          items: publicRestored,
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
  // The BUNDLE_SENTINEL_PRODUCT_ID (-1) is filtered out — only positive productIds are meaningful here.
  if (orderIntegrationId && restored.length > 0) {
    const singleProductIds = restored
      .map((r) => r.productId)
      .filter((id) => id !== BUNDLE_SENTINEL_PRODUCT_ID);
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
    restored: publicRestored,
    skipped,
    newOrderStatus,
  });

  return applyRateLimitHeaders(response, rateLimitHeaders);
});
