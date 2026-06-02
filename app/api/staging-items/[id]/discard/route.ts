import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler } from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { StagingItemStatus } from '@prisma/client';
import { validateCSRFToken } from '@/lib/csrf';
import { auditService } from '@/lib/audit';
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

  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

  const id = parseInt(params.id, 10);
  if (isNaN(id)) {
    return NextResponse.json({ error: 'Invalid staging item ID' }, { status: 400 });
  }

  const result = await prisma.stagingItem.updateMany({
    where: { id, status: StagingItemStatus.RECEIVED },
    data: { status: StagingItemStatus.DISCARDED },
  });

  if (result.count === 0) {
    return NextResponse.json(
      { error: 'Staging item not found or not in a discardable state' },
      { status: 409 }
    );
  }

  await auditService.log({
    userId: user.id,
    actionType: 'STAGING_DISCARD',
    entityType: 'STAGING',
    entityId: id,
    action: `Discarded staging item ${id}`,
  });

  const response = NextResponse.json({ id, status: StagingItemStatus.DISCARDED });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
