import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { validateOrderFulfillment } from '@/lib/fulfillment';
import { UnauthorizedError, errorLogger } from '@/lib/error-handling';

export const dynamic = 'force-dynamic';

/**
 * GET /api/orders/[orderId]/fulfill/validate
 *
 * Validates an order for fulfillment readiness without making changes
 * Query params:
 * - locationId (optional): Specific location to check stock against
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { orderId: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.isApproved) {
      throw new UnauthorizedError('validate order fulfillment');
    }

    const { searchParams } = new URL(request.url);
    const locationIdParam = searchParams.get('locationId');
    const locationId = locationIdParam ? parseInt(locationIdParam, 10) : undefined;

    // Validate locationId if provided
    if (locationIdParam && (isNaN(locationId!) || locationId! <= 0)) {
      return NextResponse.json(
        {
          error: {
            message: 'Invalid locationId parameter',
            code: 'INVALID_LOCATION_ID',
          },
        },
        { status: 400 }
      );
    }

    const validation = await validateOrderFulfillment(
      params.orderId,
      locationId
    );

    return NextResponse.json(validation);
  } catch (error) {
    errorLogger.log(error as Error);

    if (error instanceof UnauthorizedError) {
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
          message: 'Failed to validate order fulfillment',
          code: 'VALIDATION_FAILED',
        },
      },
      { status: 500 }
    );
  }
}
