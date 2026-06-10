import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, requireCompanyMembership, apiHandler, requireCSRF } from '@/lib/api-utils';
import { fulfillExternalOrder } from '@/lib/fulfillment';
import { FulfillmentRequestSchema } from '@/lib/validation/fulfillment';
import {
  applyRateLimitHeaders,
  enforceRateLimit,
} from '@/lib/rateLimit';
import { auditService } from '@/lib/audit';
import { pushOrderStatusToExternal } from '@/lib/external-orders/shared';
import { pushStockForProducts } from '@/lib/external-orders/stock-sync';
import prisma from '@/lib/prisma';
import { BUNDLE_SENTINEL_PRODUCT_ID } from '@/lib/external-orders/constants';

export const dynamic = 'force-dynamic';

export const POST = apiHandler(async (
  request: NextRequest,
  { params }: { params: { orderId: string } }
) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'orders:fulfill', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const body = FulfillmentRequestSchema.parse(await request.json());

  // P0-4: Verify user belongs to the order's company. Load just the companyId
  // up-front so we don't expose fulfillment to cross-tenant callers.
  const orderCompany = await prisma.externalOrder.findUnique({
    where: { id: params.orderId },
    select: { companyId: true },
  });
  if (!orderCompany) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  }
  await requireCompanyMembership(user.id, orderCompany.companyId, user.isAdmin);

  // Perform fulfillment
  const result = await fulfillExternalOrder(
    params.orderId,
    body.locationId,
    body.items,
    user.id,
    body.notes
  );

  // Determine overall fulfillment status
  const totalItems = body.items.length;
  const fulfilledCount = result.fulfilled.length;
  const fulfillmentStatus =
    fulfilledCount === totalItems
      ? 'fulfilled'
      : fulfilledCount > 0
      ? 'partial'
      : 'none';

  // Audit logging
  try {
    if (fulfilledCount > 0) {
      const actionType =
        fulfillmentStatus === 'fulfilled'
          ? 'EXTERNAL_ORDER_FULFILLMENT'
          : 'EXTERNAL_ORDER_PARTIAL_FULFILLMENT';

      await auditService.log({
        userId: user.id,
        actionType: actionType as any,
        entityType: 'INVENTORY',
        action: `${fulfillmentStatus === 'fulfilled' ? 'Fulfilled' : 'Partially fulfilled'} external order ${params.orderId}`,
        details: {
          orderId: params.orderId,
          locationId: body.locationId,
          fulfilled: result.fulfilled.length,
          skipped: result.skipped.length,
          failed: result.failed.length,
          // FIX C: never expose the bundle sentinel productId in audit details.
          items: result.fulfilled.map((f) => {
            if (f.productId === BUNDLE_SENTINEL_PRODUCT_ID) {
              return {
                productName: f.productName,
                quantity: f.quantity,
                isBundle: true,
                componentIds: f.componentIds ?? [],
              };
            }
            return {
              productId: f.productId,
              productName: f.productName,
              quantity: f.quantity,
            };
          }),
          notes: body.notes,
        },
        affectedCount: result.fulfilled.length,
      });
    }
  } catch (auditError) {
    console.error('Failed to log audit fulfillment:', auditError);
  }

  // Push fulfillment status to external platform (best-effort, never fails the fulfillment).
  // P1-6: Only push when every requested item succeeded. If any item hit the catch
  // branch inside fulfillExternalOrder, the internal DB state may not match what we'd
  // send to WC, so skip the push and log for manual follow-up.
  if (
    result.integrationId &&
    result.externalId &&
    fulfilledCount > 0 &&
    result.failed.length === 0
  ) {
    try {
      const integration = await prisma.integration.findUnique({
        where: { id: result.integrationId },
        select: { fulfillmentPushEnabled: true },
      });

      if (integration?.fulfillmentPushEnabled) {
        // Amendment 7: Use full order totals for completed check
        const totalQuantity = result.totalQuantity ?? 0;
        const totalFulfilled = result.totalFulfilled ?? 0;
        const wcStatus = totalFulfilled >= totalQuantity ? 'completed' : 'processing';

        const pushResult = await pushOrderStatusToExternal(
          result.integrationId,
          result.externalId,
          wcStatus
        );

        if (!pushResult.success) {
          console.error(
            `Fulfillment push failed for order ${params.orderId}:`,
            pushResult.error
          );
        }
      }
    } catch (pushError) {
      console.error(
        `Fulfillment push error for order ${params.orderId}:`,
        pushError
      );
      // Don't fail the fulfillment. Log for manual follow-up.
    }
  } else if (result.failed.length > 0) {
    console.warn(
      `Skipping external push for order ${params.orderId}: ${result.failed.length} items failed during fulfillment`
    );
  }

  // Phase 7f / P0-3: Best-effort stock status push for products that were just deducted.
  // For single-product items, pass their productId directly.
  // For bundle items, pass the component IDs (result.affectedComponentIds) so that
  // pushStockForProducts can also find and push the bundle's WC stock_status.
  // The BUNDLE_SENTINEL_PRODUCT_ID (-1) is filtered out — only positive productIds are meaningful here.
  if (result.integrationId && fulfilledCount > 0) {
    const singleProductIds = result.fulfilled
      .map((f) => f.productId)
      .filter((id) => id !== BUNDLE_SENTINEL_PRODUCT_ID);
    const componentIds = result.affectedComponentIds ?? [];
    const uniqueProductIds = Array.from(
      new Set([...singleProductIds, ...componentIds])
    );
    if (uniqueProductIds.length > 0) {
      pushStockForProducts(result.integrationId, uniqueProductIds).catch(
        (err) => {
          console.error(
            `Post-fulfillment stock push failed for order ${params.orderId}:`,
            err
          );
        }
      );
    }
  }

  // FIX C (P0 #6): Hide internal sentinels from public API. Bundle entries
  // have productId=-1 and inventoryLogId=-1 internally; transform them into
  // a clean shape with {isBundle, componentIds} so clients don't mistake the
  // sentinel for a real productId. Single-product entries pass through.
  const publicFulfilled = result.fulfilled.map((f) => {
    if (f.productId === BUNDLE_SENTINEL_PRODUCT_ID) {
      const { productId: _pid, inventoryLogId: _lid, ...rest } = f;
      void _pid;
      void _lid;
      return {
        ...rest,
        isBundle: true,
        componentIds: f.componentIds ?? [],
      };
    }
    return f;
  });

  // Inventory logs list excludes bundle sentinel rows for consistency.
  const publicInventoryLogs = result.inventoryLogIds.filter(
    (id) => id !== BUNDLE_SENTINEL_PRODUCT_ID
  );

  const response = NextResponse.json({
    success: true,
    fulfillmentStatus,
    results: {
      fulfilled: publicFulfilled,
      skipped: result.skipped,
      failed: result.failed,
    },
    inventoryLogs: publicInventoryLogs,
    summary: {
      total: totalItems,
      fulfilled: result.fulfilled.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
    },
  });

  return applyRateLimitHeaders(response, rateLimitHeaders);
});
