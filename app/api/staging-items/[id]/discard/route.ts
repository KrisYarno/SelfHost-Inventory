import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { StagingItemStatus } from '@prisma/client';
import { recordChange } from '@/lib/change-tracking';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
  };
}

// POST /api/staging-items/[id]/discard - Mark a RECEIVED box as DISCARDED.
// Atomic guard: only a RECEIVED item transitions; anything else (already
// graduated/discarded/missing) yields count 0 -> 409.
export const POST = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'staging-discard:POST', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const id = parseInt(params.id, 10);
  if (isNaN(id)) {
    return NextResponse.json({ error: 'Invalid staging item ID' }, { status: 400 });
  }

  // The atomic guard (updateMany WHERE status=RECEIVED) and the STAGING_DISCARD
  // event share one transaction, and recordChange runs ONLY after the count
  // check succeeds — so a 409 (count 0: already graduated/discarded/missing)
  // records nothing.
  const discarded = await prisma.$transaction(async (tx) => {
    const result = await tx.stagingItem.updateMany({
      where: { id, status: StagingItemStatus.RECEIVED },
      data: { status: StagingItemStatus.DISCARDED },
    });

    if (result.count === 0) return false;

    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: 'STAGING_DISCARD',
      entityType: 'STAGING',
      entityId: id,
      action: `Discarded staging item ${id}`,
    });

    return true;
  });

  if (!discarded) {
    return NextResponse.json(
      { error: 'Staging item not found or not in a discardable state' },
      { status: 409 }
    );
  }

  const response = NextResponse.json({ id, status: StagingItemStatus.DISCARDED });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
