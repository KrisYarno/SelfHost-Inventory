import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { ZodError } from 'zod';
import { authOptions } from '@/lib/auth';
import { fulfillExternalOrder } from '@/lib/fulfillment';
import {
  AppError,
  UnauthorizedError,
  errorLogger,
} from '@/lib/error-handling';
import { validateCSRFToken } from '@/lib/csrf';
import { FulfillmentRequestSchema } from '@/lib/validation/fulfillment';
import {
  applyRateLimitHeaders,
  enforceRateLimit,
  RateLimitError,
} from '@/lib/rateLimit';
import { auditService } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * POST /api/orders/[orderId]/fulfill
 *
 * Fulfills an external order by deducting inventory
 *
 * Request body:
 * {
 *   "locationId": 1,
 *   "items": [
 *     { "itemId": "abc123", "quantity": 5 },
 *     { "itemId": "def456", "quantity": 3, "productId": 42 },
 *     { "itemId": "ghi789", "quantity": 2, "skipUnmapped": true }
 *   ],
 *   "notes": "Fulfilled from main warehouse"
 * }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { orderId: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.isApproved) {
      throw new UnauthorizedError('fulfill external orders');
    }

    const rateLimitHeaders = enforceRateLimit(request, 'orders:fulfill', {
      identifier: session.user.id,
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
      session.user.id,
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
          userId: session.user.id,
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
  } catch (error) {
    errorLogger.log(error as Error);

    if (error instanceof RateLimitError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: error.headers }
      );
    }

    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          error: 'Invalid request payload',
          details: error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    if (error instanceof AppError) {
      return NextResponse.json(
        {
          error: {
            message: error.message,
            code: error.code,
          },
        },
        { status: error.statusCode }
      );
    }

    if (error instanceof Error && error.message.includes('not found')) {
      return NextResponse.json(
        {
          error: {
            message: error.message,
            code: 'ORDER_NOT_FOUND',
          },
        },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        error: {
          message: 'Failed to fulfill order. Please try again.',
          code: 'FULFILLMENT_FAILED',
        },
      },
      { status: 500 }
    );
  }
}
