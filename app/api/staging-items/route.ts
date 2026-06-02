import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler } from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { StagingItemStatus } from '@prisma/client';
import { auditService } from '@/lib/audit';
import { validateCSRFToken } from '@/lib/csrf';
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

  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

  const body = CreateStagingSchema.parse(await request.json());

  const item = await prisma.stagingItem.create({
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

  await auditService.log({
    userId: user.id,
    actionType: 'STAGING_CREATE',
    entityType: 'STAGING',
    entityId: item.id,
    action: `Logged staging item "${item.description}"`,
    details: { description: item.description, locationId: item.locationId },
  });

  const response = NextResponse.json(item, { status: 201 });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
