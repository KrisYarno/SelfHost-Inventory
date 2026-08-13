import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import { AppError } from '@/lib/error-handling';
import prisma from '@/lib/prisma';
import { StagingItemStatus } from '@prisma/client';
import { CountStagingSchema } from '@/lib/validation/staging';
import { recordChange } from '@/lib/change-tracking';
import { claimShipmentForCount } from '@/lib/shipments/lifecycle';
import { lineDiscrepancy } from '@/lib/shipments/rollup';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
  };
}

/**
 * POST /api/staging-items/[id]/count — record a physical count (pack REV-3 T2).
 *
 * Counting is its own verb rather than a PATCH field because it is an EVENT,
 * not an attribute: it stamps who counted and when, and it is always audited,
 * so a recount leaves a visible old -> new trail instead of quietly replacing
 * the previous number. That trail is what the weekly count protocol produces
 * and what W1-3a's graduation trusts as the booked quantity.
 *
 * Guards, in order:
 *   - the item must exist                             (404)
 *   - the item must still be RECEIVED                 (409) — graduated stock is
 *     a settled movement; re-counting it would rewrite history
 *   - a linked shipment must be OPEN                  (409) — counting is
 *     receiving work, and closing a shipment ends it (CLOSED and CANCELLED
 *     alike; graduation, by contrast, stays legal on CLOSED — the amended T4
 *     matrix, enforced in claimShipmentForCount vs claimShipmentForGraduation)
 *   - the write is an atomic claim on (id, RECEIVED)  (409 when lost)
 *
 * A countedQuantity of 0 is accepted here on purpose; the "zero is a Discard,
 * not a stock-in" 422 is graduation's rule, not this endpoint's.
 */
export const POST = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'staging-count:POST', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const id = parseInt(params.id, 10);
  if (isNaN(id)) {
    return NextResponse.json({ error: 'Invalid staging item ID' }, { status: 400 });
  }

  const body = CountStagingSchema.parse(await request.json());

  // One instant for the column and the response, so the client never renders a
  // countedAt that differs from the stored one.
  const countedAt = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.stagingItem.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        shipmentId: true,
        expectedQuantity: true,
        countedQuantity: true,
      },
    });
    if (!existing) {
      throw new AppError('Staging item not found', 'NOT_FOUND', 404);
    }

    if (existing.status !== StagingItemStatus.RECEIVED) {
      throw new AppError(
        `Staging item ${id} is ${existing.status.toLowerCase()} and can no longer be counted`,
        'CONFLICT',
        409,
      );
    }

    // The shipment guard is a CLAIM (404/409 thrown from the helper), so a
    // concurrent close serializes against it and the loser writes nothing.
    if (existing.shipmentId !== null) {
      await claimShipmentForCount(tx, existing.shipmentId);
    }

    const previousCountedQuantity = existing.countedQuantity;

    const claim = await tx.stagingItem.updateMany({
      where: { id, status: StagingItemStatus.RECEIVED },
      data: {
        countedQuantity: body.countedQuantity,
        countedBy: user.id,
        countedAt,
      },
    });
    if (claim.count === 0) {
      throw new AppError(
        `Staging item ${id} changed state while it was being counted; reload and retry`,
        'CONFLICT',
        409,
      );
    }

    const recount = previousCountedQuantity !== null;

    // ALWAYS recorded, including a confirming recount that lands on the same
    // number — a deliberate divergence from the ER-B9 "from === to drops" diff
    // idiom, because the event's subject is the COUNT ACT, not the field delta.
    // "We recounted and it is still 12" is precisely the evidence the count
    // protocol exists to produce.
    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: 'STAGING_RECOUNT',
      entityType: 'STAGING',
      entityId: id,
      action: recount ? `Recounted staging item ${id}` : `Counted staging item ${id}`,
      changes: {
        countedQuantity: { from: previousCountedQuantity, to: body.countedQuantity },
      },
      details: {
        previousCountedQuantity,
        recount,
        shipmentId: existing.shipmentId,
        expectedQuantity: existing.expectedQuantity,
      },
    });

    return {
      id,
      status: StagingItemStatus.RECEIVED,
      countedQuantity: body.countedQuantity,
      previousCountedQuantity,
      recount,
      countedBy: user.id,
      countedAt,
      expectedQuantity: existing.expectedQuantity,
      shipmentId: existing.shipmentId,
      // The same per-line flags the receiving detail renders (W1-4b, seam S10):
      // NULL expected counts in FULL, and the sign lives in `direction`.
      discrepancy: lineDiscrepancy({
        expectedQuantity: existing.expectedQuantity,
        countedQuantity: body.countedQuantity,
      }),
    };
  });

  const response = NextResponse.json(result);
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
