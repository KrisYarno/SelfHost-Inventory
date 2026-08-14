import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import { AppError } from '@/lib/error-handling';
import prisma from '@/lib/prisma';
import { Prisma, StagingItemStatus } from '@prisma/client';
import { recordChange } from '@/lib/change-tracking';
import {
  AllocateShipmentCostsSchema,
  assertAllocationLineIdsUnique,
} from '@/lib/validation/inbound-shipment';
import { getInboundShipmentDetail } from '@/lib/shipments/queries';
import { withDeadlockRetry } from '@/lib/inventory';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
  };
}

/**
 * Claim one line at its expected cost, and write the new one (FD3-1).
 *
 * The WHERE is the whole precondition and MySQL is what evaluates it:
 *
 *   id             the line;
 *   shipmentId     ...still one of THIS receipt's lines. A line that was
 *                  unlinked (or auto-unlinked by a cancel) mid-bill refuses
 *                  rather than being priced while it sits outside the shipment
 *                  whose freight this is;
 *   status         still RECEIVED — a graduated line's cost is settled history;
 *   unitCostCents  still exactly what the split was computed against. `null` is
 *                  a legal value here and means "still unpriced".
 *
 * `count === 0` hides two different refusals, and the caller needs them apart: a
 * drifted cost invalidates the whole bill (the split no longer describes this
 * shipment), a state change does not. Re-claiming WITHOUT the cost is a current
 * read (the house no-op claim idiom) that answers which one it was; it writes
 * nothing, and either way this function THROWS.
 *
 * That throw is the point. It unwinds `prisma.$transaction`, so every line
 * written before it rolls back — all-or-nothing, which is what makes "clear the
 * bill and re-enter the full freight" a safe instruction again.
 *
 * The AUDIT is deliberately not here but in the handler's own loop: the D9
 * per-handler gate reads the handler, and a route whose recording hides one
 * call deep is a route whose recording can go missing unnoticed.
 */
async function claimLineCost(
  tx: Prisma.TransactionClient,
  shipmentId: string,
  line: { id: number; unitCostCents: number; ifUnitCostCents: number | null },
): Promise<void> {
  const write = await tx.stagingItem.updateMany({
    where: {
      id: line.id,
      shipmentId,
      status: StagingItemStatus.RECEIVED,
      unitCostCents: line.ifUnitCostCents,
    },
    data: { unitCostCents: line.unitCostCents },
  });

  if (write.count > 0) return;

  const stillReceiving = await tx.stagingItem.updateMany({
    where: { id: line.id, shipmentId, status: StagingItemStatus.RECEIVED },
    data: { status: StagingItemStatus.RECEIVED },
  });
  if (stillReceiving.count > 0) {
    throw new AppError(
      `Staging item ${line.id}: the cost changed while the bill was open; reload the shipment and re-enter the freight against the costs on screen`,
      'COST_DRIFT',
      409,
    );
  }
  throw new AppError(
    `Staging item ${line.id} changed state or left this shipment while the bill was being written; reload and retry`,
    'CONFLICT',
    409,
  );
}

/**
 * POST /api/inbound-shipments/[id]/costs — WRITE A WHOLE FREIGHT BILL, ATOMICALLY.
 *
 * The receiving detail's freight calculator used to fan Accept out into one
 * `PATCH /api/staging-items/[id]` per line. Three consecutive review rounds
 * (W1S-5, FD-1, FD3-1) found a different way for that to hurt somebody, and the
 * last one is the one that loses money without anybody noticing: line A lands,
 * line B refuses, the panel invalidates the bill and tells the operator to clear
 * it and re-enter the FULL freight — which re-allocates the whole invoice
 * INCLUDING onto A's base, which has already absorbed its share. Landed costs
 * overstated, by following the instructions on screen.
 *
 * So the fan-out is gone and this is its replacement: one request, one
 * transaction, every line or none.
 *
 * LOCK ORDER: ascending by staging id, the same order the count endpoint,
 * graduation and the settle paths take their lines in. This route takes NO
 * header lock — it never touches the shipment row — so it cannot be the second
 * half of an ABBA with the writers that go item -> shipment.
 *
 * NO HEADER GUARD, and none needed: the WHERE's `shipmentId` is the guard. A
 * CANCELLED shipment has already unlinked its RECEIVED lines (T4), so its lines
 * match nothing here; a CLOSED one keeps them, which is exactly the stranded-line
 * amendment — closing ends receiving, not stocking, and a stranded line's
 * graduation still reads this cost.
 */
export const POST = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'inbound-shipment-costs:POST', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const id = params.id;
  const body = AllocateShipmentCostsSchema.parse(await request.json());
  assertAllocationLineIdsUnique(body);

  // The house item lock order, applied to the bill rather than trusted from it:
  // two bills that overlap queue instead of colliding, whatever order the panels
  // happened to send their lines in.
  const lines = [...body.lines].sort((a, b) => a.id - b.id);

  // A deadlock is still possible against a writer holding one of these rows
  // while waiting on something we hold; the house retry re-runs the WHOLE
  // transaction, which is safe precisely BECAUSE nothing partial committed —
  // every line's precondition is re-evaluated from scratch.
  await withDeadlockRetry(() =>
    prisma.$transaction(async (tx): Promise<void> => {
      for (const line of lines) {
        await claimLineCost(tx, id, line);

        // Update + record atomically (D4), line by line. The before-image needs
        // no read: the write only matched because the row still carried
        // `ifUnitCostCents`, so the precondition IS the from-value. ER-B9
        // applies unchanged — a from===to entry is not a change, and an empty
        // diff writes no event.
        if (line.ifUnitCostCents !== line.unitCostCents) {
          await recordChange(tx, {
            actor: { userId: user.id },
            actionType: 'STAGING_UPDATE',
            entityType: 'STAGING',
            entityId: line.id,
            action: `Updated staging item #${line.id}`,
            changes: {
              unitCostCents: { from: line.ifUnitCostCents, to: line.unitCostCents },
            },
          });
        }
      }
    }),
  );

  // The SAME shape GET serves, so a mutating client never has to reconcile two
  // dialects (the PATCH sibling's rule).
  const detail = await getInboundShipmentDetail(id);
  const response = NextResponse.json(detail);
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
