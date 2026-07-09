import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, requireCompanyMembership, apiHandler, requireCSRF } from '@/lib/api-utils';
import { fulfillExternalOrder } from '@/lib/fulfillment';
import { FulfillmentRequestSchema } from '@/lib/validation/fulfillment';
import {
  applyRateLimitHeaders,
  enforceRateLimit,
} from '@/lib/rateLimit';
import { recordChange, newBatchId } from '@/lib/change-tracking';
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

  // ONE batchId per request, shared by the change event and echoed into its
  // details so the audit row and the deduction's ledger rows are joinable.
  const batchId = newBatchId();

  // Perform fulfillment. The ORDER change event is captured INSIDE the
  // deduction transaction (via the `record` callback) so an unrecordable
  // fulfillment never commits (spec R-D2 / Task 12). Behavior-preserving:
  // record only when at least one item was fulfilled, and keep the
  // full/partial actionType split. entityType=ORDER, entityId=the ExternalOrder
  // cuid, companyId from the loaded order (company-scoped, asserted).
  const result = await fulfillExternalOrder(
    params.orderId,
    body.locationId,
    body.items,
    user.id,
    body.notes,
    async (tx, r) => {
      if (r.fulfilled.length === 0) return;
      const isFull = r.fulfilled.length === body.items.length;
      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: isFull
          ? 'EXTERNAL_ORDER_FULFILLMENT'
          : 'EXTERNAL_ORDER_PARTIAL_FULFILLMENT',
        entityType: 'ORDER',
        entityId: params.orderId,
        companyId: orderCompany.companyId,
        action: `${isFull ? 'Fulfilled' : 'Partially fulfilled'} external order ${params.orderId}`,
        details: {
          orderId: params.orderId,
          locationId: body.locationId,
          fulfilled: r.fulfilled.length,
          skipped: r.skipped.length,
          failed: r.failed.length,
          // FIX C: never expose the bundle sentinel productId in audit details.
          items: r.fulfilled.map((f) => {
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
          batchId,
        },
        affectedCount: r.fulfilled.length,
        batchId,
      });
    }
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
