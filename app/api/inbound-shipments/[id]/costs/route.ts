import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import { AppError } from '@/lib/error-handling';
import prisma from '@/lib/prisma';
import { Prisma, StagingItemStatus } from '@prisma/client';
import { recordChange } from '@/lib/change-tracking';
import {
  AllocateShipmentCostsSchema,
  assertAllocationLineIdsUnique,
  assertAllocationHasWriteLine,
  type AllocateShipmentCostsInput,
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

/** One line of the bill, exactly as the schema parsed it. */
type BillLine = AllocateShipmentCostsInput['lines'][number];

/**
 * The QUANTITY half of a line's precondition (FD4-1).
 *
 * The panel divides a line's share of the freight by a quantity, and WHICH
 * quantity is a decision with three possible answers. Each one asks the row a
 * different question, and only the matching question is honest:
 *
 *   counted   the count is what the split rests on, so it must still be that
 *             count. (An expectation moving underneath a counted line changes
 *             nothing the split used.)
 *   expected  the line was uncounted and the expectation stood in for the
 *             count. A count landing mid-bill makes `countedQuantity` non-null
 *             and this misses — correctly: the number the split used has been
 *             superseded by a better one, and the operator should see it;
 *   none      neither quantity exists, so the line took a zero share. Either
 *             one appearing mid-bill means it should not have.
 */
function quantityPrecondition(line: BillLine): Prisma.StagingItemWhereInput {
  switch (line.qtySource) {
    case 'counted':
      return { countedQuantity: line.qty };
    case 'expected':
      return { countedQuantity: null, expectedQuantity: line.qty };
    case 'none':
      return { countedQuantity: null, expectedQuantity: null };
  }
}

/**
 * Claim one line against the basis the split was computed from, and — if this
 * line is a write line — write its new cost (FD3-1, widened by FD4-1).
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
 *                  a legal value here and means "still unpriced";
 *   the QUANTITY   still exactly what the share was divided by (above). Without
 *                  it a recount committing mid-Accept let per-unit costs
 *                  computed over the old units land on the new ones.
 *
 * A line WITHOUT `unitCostCents` is VERIFY-ONLY: the panel is not writing it,
 * but the split rests on its cost and quantity all the same, so it is claimed
 * with the house no-op idiom (`data` restates the status the WHERE matched).
 * That statement is both halves of what this line needs — the verification AND
 * the row lock that keeps it true for the rest of the transaction.
 *
 * `count === 0` hides two different refusals, and the caller needs them apart: a
 * drifted basis invalidates the whole bill (the split no longer describes this
 * shipment), a state change does not. Re-claiming WITHOUT the cost and quantity
 * is a current read (the same no-op idiom) that answers which one it was; it
 * writes nothing, and either way this function THROWS.
 *
 * That throw is the point. It unwinds `prisma.$transaction`, so every line
 * written before it rolls back — all-or-nothing, which is what makes "clear the
 * bill and re-enter the full freight" a safe instruction again.
 *
 * The AUDIT is deliberately not here but in the handler's own loop: the D9
 * per-handler gate reads the handler, and a route whose recording hides one
 * call deep is a route whose recording can go missing unnoticed.
 */
async function claimLineBasis(
  tx: Prisma.TransactionClient,
  shipmentId: string,
  line: BillLine,
): Promise<void> {
  const claim = await tx.stagingItem.updateMany({
    where: {
      id: line.id,
      shipmentId,
      status: StagingItemStatus.RECEIVED,
      unitCostCents: line.ifUnitCostCents,
      ...quantityPrecondition(line),
    },
    data:
      line.unitCostCents === undefined
        ? { status: StagingItemStatus.RECEIVED }
        : { unitCostCents: line.unitCostCents },
  });

  if (claim.count > 0) return;

  const stillReceiving = await tx.stagingItem.updateMany({
    where: { id: line.id, shipmentId, status: StagingItemStatus.RECEIVED },
    data: { status: StagingItemStatus.RECEIVED },
  });
  if (stillReceiving.count > 0) {
    throw new AppError(
      `Staging item ${line.id}: its cost or quantity changed while the bill was open; reload the shipment and re-enter the freight against the values on screen`,
      'BASIS_DRIFT',
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
 * THE HEADER LOCK — and deliberately NOT a status gate (FD5-1).
 *
 * It is taken for one reason: the membership read below has to happen with this
 * receipt's shape held still, exactly as the settle route holds it. What it must
 * NOT do is decide anything about the shipment's status. Bills stay legal on a
 * CLOSED shipment (the stranded-line amendment: closing ends receiving, not
 * stocking, and a stranded line's graduation still reads this cost), and a
 * CANCELLED shipment has already unlinked its RECEIVED lines — so its lines miss
 * their per-line claims first and refuse as CONFLICT, above, by name.
 *
 * Raw SQL because Prisma has no `FOR UPDATE` (house precedent: the settle
 * route's `lockedHeader`/`currentLines`, lib/products/decline.ts). The id is a
 * BOUND parameter, never interpolated. Nothing reads the row: the LOCK is the
 * whole point of the statement.
 */
async function lockHeader(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM inbound_shipments WHERE id = ${id} FOR UPDATE`,
  );
}

/**
 * THE CURRENT RECEIVED MEMBERSHIP, LOCKED (FD5-1).
 *
 * A plain `findMany` here would answer from the snapshot this transaction took
 * at its first read, which is older than every claim above it — so a line linked
 * since would be invisible to precisely the check that exists to see it.
 * `SELECT ... FOR UPDATE` reads the latest COMMITTED rows and holds them.
 *
 * `ORDER BY id` keeps this read's lock order identical to the ascending claims,
 * and makes the comparison below an element-wise one.
 */
function currentReceivedIds(
  tx: Prisma.TransactionClient,
  shipmentId: string,
): Promise<{ id: number }[]> {
  return tx.$queryRaw<{ id: number }[]>(
    Prisma.sql`SELECT id FROM staging_items WHERE shipmentId = ${shipmentId} AND status = ${StagingItemStatus.RECEIVED} ORDER BY id FOR UPDATE`,
  );
}

/**
 * Prove that the bill's lines are ALL of this receipt's lines (FD5-1).
 *
 * Round 6 made every SUBMITTED line's basis a precondition. It never made the
 * SUBMITTED SET one, and a freight split is a statement about the whole receipt:
 *
 *   freeze a bill with A alone (1 x 100c, 100c freight -> A = 200c); line C
 *   links to the shipment before Accept; the payload still carries only A. Every
 *   check passes — A's cost, A's quantity, A's membership — and A commits at
 *   200c while the current basis says 150c/150c. Nothing drifted; the request
 *   simply described a shipment that no longer exists. The same hole answers to
 *   any stale client that omits a line which IS a current member.
 *
 * So the settle route's FD2-1 proof comes here in its own shape: the submitted
 * ids (already ascending) must EQUAL the current RECEIVED ids, element-wise. A
 * size comparison would pass one line out and one line in, which is a different
 * shipment wearing the same count.
 *
 * The refusal is BASIS_DRIFT — the same name and the same 409 a moved cost or
 * quantity takes, because it is the same sentence to the operator: the split on
 * screen is no longer the right answer for this receipt. It THROWS, so the lines
 * this bill already wrote roll back with it.
 */
function assertSubmittedSetIsMembership(
  submittedIds: readonly number[],
  current: readonly { id: number }[],
): void {
  if (
    current.length === submittedIds.length &&
    current.every((row, index) => row.id === submittedIds[index])
  ) {
    return;
  }
  throw new AppError(
    'A line joined or left this shipment while the bill was open, so the freight was split across the wrong set of lines; reload the shipment and re-enter the freight against the lines on screen',
    'BASIS_DRIFT',
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
 * FD4-1 — AND "EVERY LINE" MEANS THE WHOLE BASIS. The bill carries every line of
 * the panel's frozen session, not just the ones it writes: a split is computed
 * from the costs and quantities of ALL of them, and a line nobody sends is a
 * line nobody checks. The lines with a `unitCostCents` are written; the rest are
 * claimed and verified against the same frozen values. One line's basis having
 * moved refuses the bill exactly as a failed write does — there is no such thing
 * here as a stale premise that only affects the lines we were not writing.
 *
 * FD5-1 — AND "THE WHOLE BASIS" MEANS THE WHOLE MEMBERSHIP. Checking every line
 * the client sent is not the same as checking that those lines are all of them:
 * a line that links after the freeze is examined by nothing, and the bill
 * commits a split computed for a receipt that no longer exists. So after the
 * per-line claims the route takes the header and ONE ordered locking read of the
 * current RECEIVED ids, and the submitted set must EQUAL them.
 *
 * LOCK ORDER: ascending by staging id, then the header — the same item ->
 * header order the count endpoint, graduation and the settle paths take, so this
 * route queues behind those rather than colliding with them.
 *
 * FD6-1 (fix round 8) corrected the sentence that used to stand here. At
 * TRANSACTION scope there is no header-first writer: the staging PATCH preclaims
 * its ITEM row before `applyShipmentLink` claims either header, so the linker is
 * item-first like everybody else. What is header-first is only the link's own
 * final sequence — and that is the half this route actually needs, because it is
 * why the header held here makes the membership read STABLE rather than merely
 * fresh: `applyShipmentLink` claims EVERY header it touches, the target
 * included, before it moves the line — so a line cannot JOIN this shipment
 * without a claim on the very row this transaction is holding. (Creation never
 * links, so there is no other way in.)
 *
 * So the deadlock is not "the linker goes the other way". It is an item-first
 * writer holding its line and waiting on the header while this transaction holds
 * the header and asks for that line — a real cycle either way, and the retry is
 * the answer. FD6-1 put it on ALL of the participants: the count endpoint and
 * the staging PATCH are wrapped too, because InnoDB rolls back whichever
 * transaction did the least work and that is never the bill. See the retry note
 * at the transaction.
 *
 * NO STATUS GUARD on that header, and none wanted: the WHERE's `shipmentId` is
 * the membership guard. A CANCELLED shipment has already unlinked its RECEIVED
 * lines (T4), so its lines miss their claims and refuse as CONFLICT before the
 * header is ever taken; a CLOSED one keeps them, which is exactly the
 * stranded-line amendment — closing ends receiving, not stocking, and a stranded
 * line's graduation still reads this cost.
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
  assertAllocationHasWriteLine(body);

  // The house item lock order, applied to the bill rather than trusted from it:
  // two bills that overlap queue instead of colliding, whatever order the panels
  // happened to send their lines in. Write lines and verify-only lines share the
  // ONE order — interleaved, not two passes, because two passes over the same
  // rows in one transaction is two lock orders.
  const lines = [...body.lines].sort((a, b) => a.id - b.id);

  // A deadlock is still possible against a writer holding one of these rows
  // while waiting on something we hold — and FD5-1's `FOR UPDATE` membership
  // read makes it likelier still, because it deliberately touches rows this
  // transaction does NOT hold (a line an in-flight linker is holding is exactly
  // the line it exists to find). The house retry re-runs the WHOLE transaction,
  // which is safe precisely BECAUSE nothing partial committed — every line's
  // precondition, and the membership itself, is re-evaluated from scratch
  // against a snapshot that now includes whatever moved.
  await withDeadlockRetry(() =>
    prisma.$transaction(async (tx): Promise<void> => {
      for (const line of lines) {
        await claimLineBasis(tx, id, line);

        // Update + record atomically (D4), line by line. The before-image needs
        // no read: the write only matched because the row still carried
        // `ifUnitCostCents`, so the precondition IS the from-value. ER-B9
        // applies unchanged — a from===to entry is not a change, and an empty
        // diff writes no event. A VERIFY-ONLY line writes no event either: it
        // changed nothing, and "we looked at this row" is not a change.
        if (line.unitCostCents !== undefined && line.ifUnitCostCents !== line.unitCostCents) {
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

      // FD5-1: with every submitted line claimed and held, the header — and with
      // it, the one question the per-line claims cannot answer: are these lines
      // ALL of them? Item -> header, unchanged.
      await lockHeader(tx, id);
      assertSubmittedSetIsMembership(
        lines.map((line) => line.id),
        await currentReceivedIds(tx, id),
      );
    }),
  );

  // The SAME shape GET serves, so a mutating client never has to reconcile two
  // dialects (the PATCH sibling's rule).
  const detail = await getInboundShipmentDetail(id);
  const response = NextResponse.json(detail);
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
