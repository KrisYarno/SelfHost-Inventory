import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, requireCompanyMembership, apiHandler } from '@/lib/api-utils';
import { validateOrderFulfillment } from '@/lib/fulfillment';
import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export const GET = apiHandler(async (
  request: NextRequest,
  { params }: { params: { orderId: string } }
) => {
  const { user } = await requireApproved();

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

  // P0-4: Verify user belongs to the order's company. Load just the companyId
  // up-front so we don't leak cross-tenant inventory (bundleShortages includes
  // internal product names, required quantity, and available stock per component).
  // Return 404 on both "order not found" and "user lacks membership" so we don't
  // distinguish — differential 403 vs 404 is an enumeration vector.
  const orderCompany = await prisma.externalOrder.findUnique({
    where: { id: params.orderId },
    select: { companyId: true },
  });
  if (!orderCompany) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  }
  await requireCompanyMembership(user.id, orderCompany.companyId, user.isAdmin);

  const validation = await validateOrderFulfillment(
    params.orderId,
    locationId
  );

  return NextResponse.json(validation);
});
