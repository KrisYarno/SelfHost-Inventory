import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import { AppError } from '@/lib/error-handling';
import prisma from '@/lib/prisma';
import { StagingItemStatus } from '@prisma/client';
import { recordChange, newBatchId } from '@/lib/change-tracking';
import { DiscardLineSchema } from '@/lib/validation/supply-orders';
import { withDeadlockRetry } from '@/lib/inventory';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
    lineId: string;
  };
}

/**
 * POST /api/inbound-shipments/[id]/lines/[lineId]/discard — REMOVE AN ORDERED
 * LINE (spec §4.0, OCs2-10).
 *
 * A mistyped or duplicated line has to be able to LEAVE the order, or a close is
 * blocked forever by a line nobody will ever verify. It is legal only while the
 * line is `ORDERED`: nothing has been delivered against it, so no money, no
 * exception and no ledger movement is involved — this is not the labeling
 * bench's `discard-remaining`, which writes off units that really arrived.
 *
 * The whole precondition lives in the claim's WHERE (`id` + `shipmentId` +
 * `ORDERED`), so a verify that commits first simply wins and this request is a
 * 409 rather than a discard of a line somebody just counted.
 */
export const POST = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'supply-order-line-discard:POST', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const id = params.id;
  const lineId = parseInt(params.lineId, 10);
  if (isNaN(lineId)) {
    return NextResponse.json({ error: 'Invalid supply-order line ID' }, { status: 400 });
  }

  const body = DiscardLineSchema.parse(await request.json());

  const batchId = newBatchId();

  await withDeadlockRetry(() =>
    prisma.$transaction(async (tx): Promise<void> => {
      const claim = await tx.stagingItem.updateMany({
        where: { id: lineId, shipmentId: id, status: StagingItemStatus.ORDERED },
        data: { status: StagingItemStatus.DISCARDED },
      });

      if (claim.count !== 1) {
        // The claim answers "did I win?", never "why not" — that read runs only
        // AFTER it failed, when nothing has been written.
        const existing = await tx.stagingItem.findUnique({
          where: { id: lineId },
          select: { id: true, status: true, shipmentId: true },
        });
        if (!existing || existing.shipmentId !== id) {
          throw new AppError('Supply-order line not found', 'NOT_FOUND', 404);
        }
        throw new AppError(
          `Supply-order line ${lineId} is ${existing.status.toLowerCase()} and can no longer be removed from the order`,
          'CONFLICT',
          409,
        );
      }

      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: 'STAGING_DISCARD',
        entityType: 'STAGING',
        entityId: lineId,
        action: `Removed line ${lineId} from supply order ${id}`,
        batchId,
        details: {
          // The FIXED reason: this is the "line removed from the order" act, and
          // the operator's own words (if any) ride beside it rather than
          // replacing the classification.
          reason: 'order-line-removed',
          shipmentId: id,
          note: body.reason ?? null,
        },
      });
    }),
  );

  const response = NextResponse.json({
    id: lineId,
    shipmentId: id,
    status: StagingItemStatus.DISCARDED,
    reason: 'order-line-removed',
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
