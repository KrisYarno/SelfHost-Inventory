import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler } from '@/lib/api-utils';
import { validateOrderFulfillment } from '@/lib/fulfillment';

export const dynamic = 'force-dynamic';

export const GET = apiHandler(async (
  request: NextRequest,
  { params }: { params: { orderId: string } }
) => {
  await requireApproved();

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
});
