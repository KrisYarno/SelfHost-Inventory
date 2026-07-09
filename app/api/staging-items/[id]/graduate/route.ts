import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import { GraduateSchema } from '@/lib/validation/staging';
import { graduateStagingItem } from '@/lib/staging/graduate';
import { recordChange, newBatchId } from '@/lib/change-tracking';
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

  // Graduation is the flagship multi-event flow: one user action fans out into a
  // STAGING_GRADUATE event, a PRODUCT_CREATE event (only when a new product is
  // minted), and (later, via the stock-in path) an inventory event. ONE batchId
  // groups them; every recordChange runs INSIDE graduateStagingItem's atomic
  // transaction (via the onRecord callback), so the events and the mutations
  // commit or roll back together — a 409/400 records nothing.
  const batchId = newBatchId();

  const result = await graduateStagingItem(
    id,
    body,
    { id: user.id, isAdmin: user.isAdmin },
    async (tx, ctx) => {
      if (ctx.created) {
        await recordChange(tx, {
          actor: { userId: user.id },
          actionType: 'PRODUCT_CREATE',
          entityType: 'PRODUCT',
          entityId: ctx.productId,
          action: `Created product ${ctx.productId} via graduation of staging item ${id}`,
          details: {
            source: 'staging-graduation',
            stagingItemId: id,
            approvalStatus: ctx.approvalStatus,
            locationId: ctx.locationId,
          },
          batchId,
        });
      }

      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: 'STAGING_GRADUATE',
        entityType: 'STAGING',
        entityId: id,
        action: `Graduated staging item ${id} into product ${ctx.productId}`,
        details: {
          productId: ctx.productId,
          approvalStatus: ctx.approvalStatus,
          locationId: ctx.locationId,
          countedQuantity: ctx.countedQuantity,
        },
        batchId,
      });
    }
  );

  const response = NextResponse.json(result, { status: 200 });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
