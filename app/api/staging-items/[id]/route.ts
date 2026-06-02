import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler } from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import { validateCSRFToken } from '@/lib/csrf';
import { PatchStagingSchema } from '@/lib/validation/staging';
import { getStagingItem } from '@/lib/staging/queries';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
  };
}

// GET /api/staging-items/[id] - Fetch a single staging item
export const GET = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  await requireApproved();

  const id = parseInt(params.id, 10);
  if (isNaN(id)) {
    return NextResponse.json({ error: 'Invalid staging item ID' }, { status: 400 });
  }

  const item = await getStagingItem(id);
  if (!item) {
    return NextResponse.json({ error: 'Staging item not found' }, { status: 404 });
  }

  return NextResponse.json(item);
});

// PATCH /api/staging-items/[id] - Edit / label / count a staging item
export const PATCH = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'staging-items:PATCH', {
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

  const body = PatchStagingSchema.parse(await request.json());

  // Build a true partial update: only keys explicitly present in the body are
  // written, so PATCH never clobbers untouched columns.
  const data: Prisma.StagingItemUpdateInput = {};
  if (body.description !== undefined) data.description = body.description;
  if (body.expectedQuantity !== undefined) data.expectedQuantity = body.expectedQuantity;
  if (body.countedQuantity !== undefined) data.countedQuantity = body.countedQuantity;
  if (body.vendor !== undefined) data.vendor = body.vendor;
  if (body.reference !== undefined) data.reference = body.reference;
  if (body.notes !== undefined) data.notes = body.notes;
  if (body.locationId !== undefined) {
    data.location = { connect: { id: body.locationId } };
  }
  if (body.resolvedProductId !== undefined) {
    data.resolvedProduct = { connect: { id: body.resolvedProductId } };
  }

  const existing = await prisma.stagingItem.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: 'Staging item not found' }, { status: 404 });
  }

  const item = await prisma.stagingItem.update({
    where: { id },
    data,
  });

  const response = NextResponse.json(item);
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
