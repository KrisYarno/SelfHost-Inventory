import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { StagingItemStatus } from '@prisma/client';
import { recordChange } from '@/lib/change-tracking';
import { CreateStagingSchema } from '@/lib/validation/staging';
import { listStagingItems } from '@/lib/staging/queries';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

const VALID_STATUSES = new Set<string>(Object.values(StagingItemStatus));

// GET /api/staging-items?status=RECEIVED - List staging items by status
export const GET = apiHandler(async (request: NextRequest) => {
  await requireApproved();

  const statusParam = request.nextUrl.searchParams.get('status');
  const status: StagingItemStatus =
    statusParam && VALID_STATUSES.has(statusParam)
      ? (statusParam as StagingItemStatus)
      : StagingItemStatus.RECEIVED;

  const items = await listStagingItems(status);

  return NextResponse.json({ items });
});

// POST /api/staging-items - Log a new pre-staging box (any approved user)
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'staging-items:POST', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const body = CreateStagingSchema.parse(await request.json());

  // Create + record atomically: the STAGING_CREATE event shares the create's
  // transaction, so an unrecordable change never leaves a committed box behind.
  const item = await prisma.$transaction(async (tx) => {
    const created = await tx.stagingItem.create({
      data: {
        description: body.description,
        expectedQuantity: body.expectedQuantity ?? null,
        resolvedProductId: body.resolvedProductId ?? null,
        vendor: body.vendor ?? null,
        reference: body.reference ?? null,
        notes: body.notes ?? null,
        locationId: body.locationId,
        receivedBy: user.id,
        status: StagingItemStatus.RECEIVED,
      },
    });

    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: 'STAGING_CREATE',
      entityType: 'STAGING',
      entityId: created.id,
      action: `Logged staging item "${created.description}"`,
      details: { description: created.description, locationId: created.locationId },
    });

    return created;
  });

  const response = NextResponse.json(item, { status: 201 });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
