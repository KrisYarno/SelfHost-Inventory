import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler } from '@/lib/api-utils';
import { fulfillExternalOrder } from '@/lib/fulfillment';
import { validateCSRFToken } from '@/lib/csrf';
import { FulfillmentRequestSchema } from '@/lib/validation/fulfillment';
import {
  applyRateLimitHeaders,
  enforceRateLimit,
} from '@/lib/rateLimit';
import { auditService } from '@/lib/audit';
import { pushOrderStatusToExternal } from '@/lib/external-orders/shared';
import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export const POST = apiHandler(async (
  request: NextRequest,
  { params }: { params: { orderId: string } }
) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'orders:fulfill', {
    identifier: user.id,
  });

  // Validate CSRF token
  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

  const body = FulfillmentRequestSchema.parse(await request.json());

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
          items: result.fulfilled.map((f) => ({
            productId: f.productId,
            productName: f.productName,
            quantity: f.quantity,
          })),
          notes: body.notes,
        },
        affectedCount: result.fulfilled.length,
      });
    }
  } catch (auditError) {
    console.error('Failed to log audit fulfillment:', auditError);
  }

  // Push fulfillment status to external platform (best-effort, never fails the fulfillment)
  if (result.integrationId && result.externalId && fulfilledCount > 0) {
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
  }

  const response = NextResponse.json({
    success: true,
    fulfillmentStatus,
    results: {
      fulfilled: result.fulfilled,
      skipped: result.skipped,
      failed: result.failed,
    },
    inventoryLogs: result.inventoryLogIds,
    summary: {
      total: totalItems,
      fulfilled: result.fulfilled.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
    },
  });

  return applyRateLimitHeaders(response, rateLimitHeaders);
});
