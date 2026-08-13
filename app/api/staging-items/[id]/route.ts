import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import { AppError } from '@/lib/error-handling';
import prisma from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import { PatchStagingSchema } from '@/lib/validation/staging';
import { getStagingItem } from '@/lib/staging/queries';
import { recordChange, type ChangeDiff } from '@/lib/change-tracking';
import { applyShipmentLink } from '@/lib/shipments/lifecycle';
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

  await requireCSRF(request);

  const id = parseInt(params.id, 10);
  if (isNaN(id)) {
    return NextResponse.json({ error: 'Invalid staging item ID' }, { status: 400 });
  }

  const body = PatchStagingSchema.parse(await request.json());

  // Build a true partial update: only keys explicitly present in the body are
  // written, so PATCH never clobbers untouched columns. In parallel, collect the
  // SCALAR after-values for the change diff — locationId/resolvedProductId as ids,
  // NOT the Prisma relation-connect objects the write uses.
  const data: Prisma.StagingItemUpdateInput = {};
  const after: Record<string, unknown> = {};
  if (body.description !== undefined) {
    data.description = body.description;
    after.description = body.description;
  }
  if (body.expectedQuantity !== undefined) {
    data.expectedQuantity = body.expectedQuantity;
    after.expectedQuantity = body.expectedQuantity;
  }
  if (body.countedQuantity !== undefined) {
    data.countedQuantity = body.countedQuantity;
    after.countedQuantity = body.countedQuantity;
  }
  if (body.vendor !== undefined) {
    data.vendor = body.vendor;
    after.vendor = body.vendor;
  }
  if (body.reference !== undefined) {
    data.reference = body.reference;
    after.reference = body.reference;
  }
  if (body.notes !== undefined) {
    data.notes = body.notes;
    after.notes = body.notes;
  }
  if (body.locationId !== undefined) {
    data.location = { connect: { id: body.locationId } };
    after.locationId = body.locationId;
  }
  if (body.resolvedProductId !== undefined) {
    data.resolvedProduct = { connect: { id: body.resolvedProductId } };
    after.resolvedProductId = body.resolvedProductId;
  }
  // shipmentId is deliberately NOT part of the generic field path: it is a state
  // transition with its own guards and its own audit verbs (T4), handled below.

  // Update + record atomically (D4); the before-image is read inside the tx.
  const item = await prisma.$transaction(async (tx) => {
    const existing = await tx.stagingItem.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError('Staging item not found', 'NOT_FOUND', 404);
    }

    // Inventory-accuracy lane (pack REV-2 T4): join / leave a receiving header.
    // Legal only while the item is RECEIVED and every shipment involved is OPEN;
    // applyShipmentLink throws 404/409 (its claims are the guards) and the throw
    // aborts this whole transaction, field edits included.
    if (body.shipmentId !== undefined) {
      const link = await applyShipmentLink(tx, {
        item: existing,
        targetShipmentId: body.shipmentId,
      });

      if (link.action === 'UNLINK' || link.action === 'RELINK') {
        await recordChange(tx, {
          actor: { userId: user.id },
          actionType: 'SHIPMENT_UNLINK',
          entityType: 'SHIPMENT',
          entityId: link.previousShipmentId,
          action: `Unlinked staging item ${id} from inbound shipment ${link.previousShipmentId}`,
          details: { stagingItemId: id },
        });
      }
      if (link.action === 'LINK' || link.action === 'RELINK') {
        await recordChange(tx, {
          actor: { userId: user.id },
          actionType: 'SHIPMENT_LINK',
          entityType: 'SHIPMENT',
          entityId: body.shipmentId,
          action: `Linked staging item ${id} to inbound shipment ${body.shipmentId}`,
          details: { stagingItemId: id, previousShipmentId: link.previousShipmentId },
        });
      }
    }

    const updated = await tx.stagingItem.update({
      where: { id },
      data,
    });

    // Diff over EXACTLY the provided fields (ER-B9: from===to entries drop; an
    // empty diff writes no event).
    const before = existing as unknown as Record<string, unknown>;
    const changes: ChangeDiff = {};
    for (const [field, to] of Object.entries(after)) {
      const from = before[field] ?? null;
      const normalizedTo = to ?? null;
      if (!Object.is(from, normalizedTo)) {
        changes[field] = { from, to: normalizedTo };
      }
    }

    if (Object.keys(changes).length > 0) {
      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: 'STAGING_UPDATE',
        entityType: 'STAGING',
        entityId: id,
        action: `Updated staging item #${id}`,
        changes,
      });
    }

    return updated;
  });

  const response = NextResponse.json(item);
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
