import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import { GraduateSchema } from '@/lib/validation/staging';
import { graduateStagingItem } from '@/lib/staging/graduate';
import { auditService } from '@/lib/audit';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
  };
}

// POST /api/staging-items/[id]/graduate - Resolve a box into real inventory.
// The 409 (already graduated/discarded) and 400 (bad target) AppErrors thrown
// by graduateStagingItem propagate through apiHandler's mapping.
export const POST = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'staging-graduate:POST', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const id = parseInt(params.id, 10);
  if (isNaN(id)) {
    return NextResponse.json({ error: 'Invalid staging item ID' }, { status: 400 });
  }

  const body = GraduateSchema.parse(await request.json());

  const result = await graduateStagingItem(id, body, {
    id: user.id,
    isAdmin: user.isAdmin,
  });

  await auditService.log({
    userId: user.id,
    actionType: 'STAGING_GRADUATE',
    entityType: 'STAGING',
    entityId: id,
    action: `Graduated staging item ${id} into product ${result.productId}`,
    details: {
      productId: result.productId,
      approvalStatus: result.approvalStatus,
      locationId: result.locationId,
      countedQuantity: result.countedQuantity,
    },
  });

  const response = NextResponse.json(result, { status: 200 });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
