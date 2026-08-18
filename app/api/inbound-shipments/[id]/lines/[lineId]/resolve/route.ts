import { NextRequest, NextResponse } from 'next/server';
import { Prisma, StagingItemStatus } from '@prisma/client';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import { AppError } from '@/lib/error-handling';
import prisma from '@/lib/prisma';
import { recordChange, newBatchId } from '@/lib/change-tracking';
import { ResolveSchema } from '@/lib/validation/supply-orders';
import { getSupplyOrderDetail } from '@/lib/supply-orders/queries';
import { lineMoney, batchShareCents } from '@/lib/supply-orders/money';
import { labelingLossKey, recvDiscrepancyKey } from '@/lib/exceptions/kinds';
import { resolveException, type ExceptionSubject } from '@/lib/exceptions/write';
import { withDeadlockRetry } from '@/lib/inventory';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
    lineId: string;
  };
}

/** The line columns the money recompute decides from, read under the line's lock. */
type LockedLine = {
  id: number;
  status: StagingItemStatus;
  orderedProductId: number | null;
  resolvedProductId: number | null;
  orderedQuantity: number | null;
  verifiedQuantity: number | null;
  stockedQuantity: number;
  disposedQuantity: number;
  lineTotalCents: number | null;
};

/**
 * THE LINE, LOCKED (the lane's uniform first step, the same idiom the verify and
 * booking cores use).
 *
 * A plain read would answer from this transaction's REPEATABLE READ snapshot, so
 * a verify or a booking that committed since would be invisible and the
 * resolution would refresh the row with money that was already wrong. `AND
 * shipmentId = ?` is the second half of the "does this belong here" question:
 * a line addressed through another order's URL is a 404, never a settlement.
 */
async function lockedLine(
  tx: Prisma.TransactionClient,
  shipmentId: string,
  lineId: number,
): Promise<LockedLine | null> {
  const rows = await tx.$queryRaw<LockedLine[]>(
    Prisma.sql`SELECT id, status, orderedProductId, resolvedProductId, orderedQuantity, verifiedQuantity, stockedQuantity, disposedQuantity, lineTotalCents FROM staging_items WHERE id = ${lineId} AND shipmentId = ${shipmentId} FOR UPDATE`,
  );
  return rows[0] ?? null;
}

/**
 * POST /api/inbound-shipments/[id]/lines/[lineId]/resolve — SETTLE ONE
 * EXCEPTION ON THIS ORDER (spec §4.2.7, pack C3b).
 *
 * The order detail lists the order's `recv-discrepancy` and `labeling-loss`
 * rows; this is the control beside them. What it writes is a CLASSIFICATION —
 * how the thing was settled — while `resolvedAt`/`resolvedBy` stay at the FIRST
 * settlement, so re-labelling ("we thought it was an accepted loss, the supplier
 * credited it after all") is a correction, not a second settlement.
 *
 * TWO RULES CARRY THE ROUTE:
 *
 *   THE KEY BELONGS HERE. Both kinds are keyed at the LINE grain, so the key is
 *   checked against this line's two deterministic keys BEFORE anything is read,
 *   and the locked read then pins the line to this order. Neither check is
 *   cosmetic: a resolve that could name any key would let one order settle
 *   another's money.
 *   THE MONEY IS RECOMPUTED. Spec §6: a resolution refreshes the subject's
 *   current money first. The figures come from the LOCKED counters, so what the
 *   register says was settled is what the line actually says now — and
 *   `subjectPatch` is MERGED by the writer, so fields this route deliberately
 *   does not recompute (the discrepancy's dock note, the loss's operator reason)
 *   survive untouched.
 *
 * This route IS an exception writer — allow-listed in
 * `__tests__/integration/exceptions-write-boundary.test.ts`.
 */
export const POST = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'supply-order-exception-resolve:POST', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const id = params.id;
  const lineId = parseInt(params.lineId, 10);
  if (isNaN(lineId)) {
    return NextResponse.json({ error: 'Invalid supply-order line ID' }, { status: 400 });
  }

  const body = ResolveSchema.parse(await request.json());

  const discrepancyKey = recvDiscrepancyKey(lineId);
  const lossKey = labelingLossKey(lineId);
  if (body.exceptionKey !== discrepancyKey && body.exceptionKey !== lossKey) {
    // Not "forbidden" but "not here": this line has exactly two settleable keys,
    // and anything else is a row this URL does not address.
    throw new AppError(
      `Exception ${body.exceptionKey} does not belong to supply-order line ${lineId}`,
      'NOT_FOUND',
      404,
    );
  }
  const isDiscrepancy = body.exceptionKey === discrepancyKey;

  const batchId = newBatchId();

  await withDeadlockRetry(() =>
    prisma.$transaction(async (tx): Promise<void> => {
      const line = await lockedLine(tx, id, lineId);
      if (!line) {
        throw new AppError('Supply-order line not found', 'NOT_FOUND', 404);
      }

      // A LINE THAT LEFT THE ORDER REPORTS NO MONEY OF ANY KIND — fix-delta 2
      // FD2-1 (removed-line money), FD3-1, and REV-11 clause 2 (OC-1), which
      // widened this from the discrepancy alone to BOTH kinds. The removal
      // already settled the row and zeroed it, and the counters the line still
      // carries are the ones it was holding when it went; recomputing from them
      // would write money back onto a line that is no longer on the order. ONE
      // doctrine for both kinds, so the write side and the read side (the
      // analytics exclusion of removed lines) cannot drift apart. The refusal
      // comes BEFORE the recompute rather than after it.
      if (line.status === StagingItemStatus.DISCARDED) {
        throw new AppError(
          'A line removed from the order has no money to settle',
          'CONFLICT',
          409,
        );
      }

      const money = lineMoney({
        lineTotalCents: line.lineTotalCents,
        orderedQuantity: line.orderedQuantity,
        verifiedQuantity: line.verifiedQuantity,
      });

      let subjectPatch: ExceptionSubject;
      if (isDiscrepancy) {
        if (line.verifiedQuantity === null) {
          // A discrepancy subject states a COUNTED quantity. There is none yet,
          // and inventing a 0 would report a whole-line shortage nobody counted.
          throw new AppError(
            `Supply-order line ${lineId} has not been verified — there is no counted quantity to settle against`,
            'VALIDATION_ERROR',
            422,
          );
        }
        const ordered = line.orderedQuantity;
        const verified = line.verifiedQuantity;
        subjectPatch = {
          stagingItemId: lineId,
          shipmentId: id,
          productId: line.resolvedProductId,
          orderedProductId: line.orderedProductId,
          expectedQty: ordered,
          countedQty: verified,
          orderedQuantity: ordered,
          verifiedQuantity: verified,
          shortUnits: ordered !== null && verified < ordered ? ordered - verified : 0,
          overUnits: ordered !== null && verified > ordered ? verified - ordered : 0,
          unitCostCents: money.unitCostCents,
          lossCents: money.lossCents,
          surplusValueCents: money.surplusValueCents,
          // EXPLICIT NULLS, not omissions: a row re-labelled from `reshipped` to
          // `accepted-loss` must stop naming a replacement shipment.
          relatedShipmentId: body.relatedShipmentId ?? null,
          creditRef: body.creditRef ?? null,
        };
      } else {
        subjectPatch = {
          stagingItemId: lineId,
          shipmentId: id,
          productId: line.resolvedProductId,
          // CUMULATIVE, from the locked counters: the disposed units' own share
          // of the line total, taken after the stocked ones (spec §4.3.5).
          units: line.disposedQuantity,
          unitCostCents: money.unitCostCents,
          // NULL PRESERVED (REV-10 clause 8): an unbilled unordered arrival has
          // no line total, so its bench loss is UNKNOWN — never a $0.00 the
          // register would then report as a settled figure.
          lossCents: batchShareCents(
            line.lineTotalCents,
            money.basisQuantity,
            line.stockedQuantity,
            line.disposedQuantity,
          ),
        };
      }

      const settled = await resolveException(tx, {
        key: body.exceptionKey,
        resolvedBy: user.id,
        note: body.note,
        resolution: body.resolution,
        subjectPatch,
      });
      if (!settled) {
        // The writer is a silent no-op on a key nobody raised. Auditing that as
        // a resolution would be a lie, so the transaction ends here instead.
        throw new AppError(
          `Exception ${body.exceptionKey} has not been raised on supply-order line ${lineId}`,
          'NOT_FOUND',
          404,
        );
      }

      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: 'EXCEPTION_RESOLVE',
        entityType: 'STAGING',
        entityId: lineId,
        action: `Resolved ${body.exceptionKey} as ${body.resolution}`,
        batchId,
        // The KEY lives in details (PK2-11): there is no INVENTORY_EXCEPTION
        // entity type and this lane does not add one.
        details: {
          key: body.exceptionKey,
          resolution: body.resolution,
          note: body.note ?? null,
          shipmentId: id,
        },
      });
    }),
  );

  const detail = await getSupplyOrderDetail(id);
  const line =
    detail && detail.model === 'supply-order'
      ? (detail.lines.find((row) => row.id === lineId) ?? null)
      : null;
  const exception =
    detail && detail.model === 'supply-order'
      ? (detail.exceptions.find((row) => row.key === body.exceptionKey) ?? null)
      : null;

  const response = NextResponse.json({
    key: body.exceptionKey,
    resolution: body.resolution,
    lineId,
    exception,
    line,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
