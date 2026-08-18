import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import { AppError } from '@/lib/error-handling';
import prisma from '@/lib/prisma';
import { Prisma, StagingItemStatus } from '@prisma/client';
import { recordChange, newBatchId } from '@/lib/change-tracking';
import { claimShipmentForVerify } from '@/lib/supply-orders/claims';
import { DiscardLineSchema } from '@/lib/validation/supply-orders';
import { recvDiscrepancyKey } from '@/lib/exceptions/kinds';
import { resolveException } from '@/lib/exceptions/write';
import { withDeadlockRetry } from '@/lib/inventory';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

/** The two statuses a line may still LEAVE the order from (spec REV-10 c3). */
const REMOVABLE: readonly StagingItemStatus[] = [
  StagingItemStatus.ORDERED,
  StagingItemStatus.VERIFIED,
];

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
 * blocked forever by a line nobody will ever verify. This is not the labeling
 * bench's `discard-remaining`, which writes off units that really arrived.
 *
 * TWO STATUSES ARE REMOVABLE (spec REV-10 clause 3):
 *
 *   ORDERED    nothing was ever delivered against it;
 *   VERIFIED   with `stockedQuantity = 0 AND disposedQuantity = 0` — the
 *              UNORDERED-ARRIVAL case. Such a line is BORN verified, so an
 *              ORDERED-only rule left a duplicate arrival on the order forever.
 *
 * The counters are the real line: once anything is stocked or disposed the units
 * exist in the ledger and the line is history, not a typo. A VERIFIED line also
 * carries a `recv-discrepancy` row (an unordered arrival IS a discrepancy), and
 * removing the line settles it `recount-corrected` AND ZEROES ITS MONEY in the
 * SAME transaction — which is why this route is on the exceptions
 * write-boundary allow-list.
 *
 * The line is taken `FOR UPDATE` first so the audit can state the status it
 * actually removed, and the claim's WHERE still carries the whole precondition:
 * a verify or a booking that commits first simply wins.
 *
 * The HEADER is then claimed (`claimShipmentForVerify`) — line -> header, the
 * lane's uniform lock order — which is what makes the legacy discriminator and
 * the CANCELLED refusal STRUCTURAL (QA-4). Both used to hold only by accident:
 * a legacy receipt's lines and a cancelled order's lines happen to sit in
 * statuses this route does not consider removable, and an accident of another
 * route's bookkeeping is not a precondition.
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
      // THE LINE, LOCKED — the transaction's first statement, exactly as the
      // verify core takes it. The status it returns is what the audit reports.
      const rows = await tx.$queryRaw<
        { status: StagingItemStatus; stockedQuantity: number; disposedQuantity: number }[]
      >(
        Prisma.sql`SELECT status, stockedQuantity, disposedQuantity FROM staging_items WHERE id = ${lineId} AND shipmentId = ${id} FOR UPDATE`,
      );
      const prior = rows[0];
      if (!prior) {
        throw new AppError('Supply-order line not found', 'NOT_FOUND', 404);
      }

      // THE HEADER, CLAIMED — line -> header, the lane's uniform lock order.
      // This carries the two refusals that were previously accidents of which
      // statuses the lines happened to be in: a LEGACY receipt is read-only
      // (409 LEGACY_READ_ONLY), and a CANCELLED order asserts nothing arrived,
      // so nothing may be removed from it either. A guard that only holds
      // because of how another route left its rows is not a guard.
      await claimShipmentForVerify(tx, id);

      if (!REMOVABLE.includes(prior.status)) {
        throw new AppError(
          `Supply-order line ${lineId} is ${prior.status.toLowerCase()} and can no longer be removed from the order`,
          'CONFLICT',
          409,
        );
      }
      if (prior.stockedQuantity > 0 || prior.disposedQuantity > 0) {
        throw new AppError(
          `Supply-order line ${lineId} already has ${prior.stockedQuantity} stocked and ${prior.disposedQuantity} disposed unit(s) — a line the ledger has moved cannot be removed from the order`,
          'CONFLICT',
          409,
        );
      }

      const claim = await tx.stagingItem.updateMany({
        where: {
          id: lineId,
          shipmentId: id,
          status: prior.status,
          stockedQuantity: 0,
          disposedQuantity: 0,
        },
        data: { status: StagingItemStatus.DISCARDED },
      });

      if (claim.count !== 1) {
        // The row is already locked, so a lost claim means the lock went with a
        // future refactor — refusing is still the only safe answer.
        throw new AppError(
          `Supply-order line ${lineId} changed while it was being removed; reload and retry`,
          'CONFLICT',
          409,
        );
      }

      if (prior.status === StagingItemStatus.VERIFIED) {
        // The line is gone, so its discrepancy is no longer true. `recount-corrected`
        // is the honest classification: the count that raised the row was a
        // mistake. A no-op when the line never had a row (spec REV-10 clause 3).
        //
        // THE MONEY GOES WITH THE LINE (FD2-1). The register row SURVIVES as
        // settled history, and `lib/analytics/supply-orders.ts` folds resolved
        // rows too — so a stored shortage or surplus left on it keeps reporting
        // a supplier loss for a line that is no longer on the order. A removed
        // line has neither, and the row has to say so itself: the identity
        // fields are the caller's business, the money is this route's.
        await resolveException(tx, {
          key: recvDiscrepancyKey(lineId),
          resolvedBy: user.id,
          resolution: 'recount-corrected',
          note: 'line removed',
          subjectPatch: {
            shortUnits: 0,
            overUnits: 0,
            lossCents: 0,
            surplusValueCents: 0,
          },
        });
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
          priorStatus: prior.status,
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
