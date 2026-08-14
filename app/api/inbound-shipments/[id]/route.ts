import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { InboundShipmentStatus, Prisma, StagingItemStatus } from '@prisma/client';
import { recordChange, type ChangeDiff } from '@/lib/change-tracking';
import {
  PatchInboundShipmentSchema,
  assertShipmentPatchNotEmpty,
} from '@/lib/validation/inbound-shipment';
import { getInboundShipmentDetail } from '@/lib/shipments/queries';
import { rollupDiscrepancies } from '@/lib/shipments/rollup';
import { withDeadlockRetry } from '@/lib/inventory';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
  };
}

type PatchRefusal =
  | { reason: 'NOT_FOUND' }
  | { reason: 'NOT_OPEN' }
  | { reason: 'UNCOUNTED'; itemIds: number[] }
  | { reason: 'GRADUATED'; itemIds: number[] }
  | { reason: 'MEMBERSHIP_CHANGED' };

/**
 * Every way this PATCH can say no, as a THROW.
 *
 * W1S-2 made that uniform. A refusal now unwinds the transaction, which is the
 * only way to keep the promise the state matrix makes — "the loser writes
 * nothing and records nothing" — once the guards run AFTER the locks. The locks
 * are no-op writes (see the transaction below); returning a refusal instead of
 * throwing would COMMIT them, and a shipment that was never closed would carry
 * a fresh `updatedAt` on every line of it.
 *
 * Caught in the handler and mapped to the house envelope; never escapes here.
 */
class PatchRefusedError extends Error {
  constructor(readonly refusal: PatchRefusal) {
    super(`inbound shipment patch refused: ${refusal.reason}`);
    this.name = 'PatchRefusedError';
  }
}

const refuse = (refusal: PatchRefusal): never => {
  throw new PatchRefusedError(refusal);
};

/**
 * Take the row lock on one staging line WITHOUT changing it: `data` restates the
 * status the WHERE matched, so the statement's only effect is the lock and the
 * current read that precedes it. The house idiom (lib/staging/graduate.ts:69,
 * lib/shipments/lifecycle.ts), applied line by line so the ORDER is ours.
 *
 * FD-2 pins `shipmentId` in the WHERE: the claim is not merely a lock, it is the
 * question "is this line STILL one of mine?", and the answer (`count > 0`) is
 * only meaningful if membership is part of what it matched.
 */
async function lockLine(
  tx: Prisma.TransactionClient,
  shipmentId: string,
  itemId: number,
): Promise<boolean> {
  const claim = await tx.stagingItem.updateMany({
    where: { id: itemId, shipmentId, status: StagingItemStatus.RECEIVED },
    data: { status: StagingItemStatus.RECEIVED },
  });
  return claim.count > 0;
}

/** One CURRENT staging line, exactly as the locking read below returns it. */
type CurrentLine = {
  id: number;
  status: StagingItemStatus;
  expectedQuantity: number | null;
  countedQuantity: number | null;
};

/**
 * THE SETTLE'S ONE SOURCE OF CURRENT TRUTH (FD2-1).
 *
 * Every decision below — the membership comparison, the graduation gate, the
 * uncounted gate and the ids it names, the audit rollup, the set this cancel
 * unlinks — reads THESE rows and nothing else.
 *
 * It has to be a LOCKING read. Under REPEATABLE READ a plain `findMany` answers
 * from the snapshot this transaction took at its first read, which is older than
 * every lock above it: a count committed in between is invisible to it, so the
 * close's audit would record numbers that were already wrong even with nothing
 * racing. `SELECT ... FOR UPDATE` reads the latest COMMITTED rows instead, and
 * re-confirms the locks the first pass took.
 *
 * It can genuinely DEADLOCK, and that is correct: a row linked into this
 * shipment since the snapshot was never locked by us, so this statement may
 * queue behind a linker that holds it and is waiting on our header. The whole
 * transaction runs inside the house `withDeadlockRetry`, which re-runs it from a
 * fresh snapshot that includes the newcomer. `ORDER BY id` keeps this read's own
 * lock order identical to the first pass's ascending claims.
 *
 * Raw SQL because Prisma has no `FOR UPDATE` (house precedent:
 * lib/products/decline.ts's product_locations lock). The shipment id is a BOUND
 * parameter, never interpolated.
 */
function currentLines(
  tx: Prisma.TransactionClient,
  shipmentId: string,
): Promise<CurrentLine[]> {
  return tx.$queryRaw<CurrentLine[]>(
    Prisma.sql`SELECT id, status, expectedQuantity, countedQuantity FROM staging_items WHERE shipmentId = ${shipmentId} ORDER BY id FOR UPDATE`,
  );
}

/**
 * Prove that the lines this settle HOLDS are exactly the lines it is settling,
 * and return them (FD2-1).
 *
 * Two independent ways that proof fails, and both are fatal:
 *
 *   a FIRST-PASS MISS  the claim matched nothing, so this transaction never held
 *                      that row — even if the id is back in the current read.
 *                      That is the ABA: the line departed, was counted (or
 *                      graduated, or repriced) while it was away, and rejoined
 *                      looking untouched. Coverage has to be CONTINUOUS, so a
 *                      miss refuses regardless of what the final read shows;
 *   a SET DIFFERENCE   the current RECEIVED members are not the set we locked.
 *                      A real id-by-id comparison, not a size one: one line out
 *                      and one line in leaves the COUNT identical while the
 *                      shipment being settled is a different shipment.
 *
 * Both sides are ascending (the snapshot read orders by id, the locking read
 * does too), so the element-wise comparison IS the set comparison.
 *
 * The refusal is RETRIABLE — the request was legal, it just raced — and the
 * caller's re-run starts from a snapshot that includes whatever moved.
 */
function heldMembers(
  lockedIds: readonly number[],
  current: readonly CurrentLine[],
  missedFirstPass: boolean,
): number[] {
  if (missedFirstPass) refuse({ reason: 'MEMBERSHIP_CHANGED' });

  const receiving = current
    .filter((line) => line.status === StagingItemStatus.RECEIVED)
    .map((line) => line.id);
  if (
    receiving.length !== lockedIds.length ||
    receiving.some((id, index) => id !== lockedIds[index])
  ) {
    refuse({ reason: 'MEMBERSHIP_CHANGED' });
  }

  return receiving;
}

/**
 * The diff for the fields this PATCH explicitly provided (ER-B9: a `from === to`
 * entry drops, and an empty diff attaches nothing).
 *
 * QA-14: this rides the CLOSE and CANCEL records too. Field edits are legal in
 * the same request as a transition — one claim commits them together — but only
 * the field-edit branch ever computed a diff, and that branch is unreachable
 * when `status` is present. So notes rewritten on the way out were WRITTEN and
 * recorded NOWHERE: the change feed, the one surface that answers "who changed
 * this receipt's notes", was blind to every edit that travelled with a settle.
 */
function fieldChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ChangeDiff {
  const changes: ChangeDiff = {};
  for (const [field, to] of Object.entries(after)) {
    const from = before[field] ?? null;
    const normalizedTo = to ?? null;
    if (!Object.is(from, normalizedTo)) {
      changes[field] = { from, to: normalizedTo };
    }
  }
  return changes;
}

/** `changes: {...}` when there is a diff, nothing at all when there is not. */
function changesFragment(changes: ChangeDiff): { changes?: ChangeDiff } {
  return Object.keys(changes).length > 0 ? { changes } : {};
}

// GET /api/inbound-shipments/[id] - One receiving header with its linked
// staging lines, per-line discrepancy flags, and the computed rollup.
export const GET = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  await requireApproved();

  const detail = await getInboundShipmentDetail(params.id);
  if (!detail) {
    return NextResponse.json({ error: 'Inbound shipment not found' }, { status: 404 });
  }

  return NextResponse.json(detail);
});

/**
 * PATCH /api/inbound-shipments/[id] — the T4 state matrix.
 *
 *   OPEN -> CLOSED     requires ZERO linked RECEIVED lines with a NULL count
 *                      (else 409 listing the offenders); stamps closedBy/At.
 *   OPEN -> CANCELLED  atomic claim conditional on NO linked GRADUATED line;
 *                      linked RECEIVED lines AUTO-UNLINK and stay in staging.
 *   notes/supplierRef  editable while OPEN only.
 *   CLOSED / CANCELLED reject every one of the above with 409.
 *
 * Every transition goes through an `updateMany` CLAIM whose WHERE is the
 * precondition (the lib/staging/graduate.ts:69 idiom): `count === 0` means a
 * concurrent actor won, and the loser writes nothing and records nothing. The
 * one `findUnique` below answers 404 ONLY — it never gates a transition.
 *
 * LOCK ORDER (W1S-2, W1-C fix round): the LINES first, in ascending id order,
 * then the header. Every other writer in this lane — the count endpoint, the
 * staging PATCH, graduation — takes the staging row before its shipment, and
 * settling a shipment header-first was an ABBA against all three. Ascending id
 * order does the same job among the lines themselves, so two settles that
 * overlap queue instead of colliding.
 *
 * CURRENT TRUTH (FD2-1): that first pass ORDERS the locks and proves continuous
 * coverage (a missed claim is fatal). Everything a settle then DECIDES —
 * membership, the graduation gate, the uncounted gate and its ids, the rollup,
 * the unlink set — comes from ONE locking read taken after the header claim
 * (`currentLines`), because a plain re-read in this transaction still answers
 * from a snapshot older than the locks.
 */
export const PATCH = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'inbound-shipments:PATCH', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const id = params.id;
  const body = PatchInboundShipmentSchema.parse(await request.json());
  assertShipmentPatchNotEmpty(body);

  // A true partial update: only keys explicitly present in the body are written.
  // These ride ALONG with a status transition when both are requested — both are
  // legal from OPEN, and one claim commits them together.
  const fields: Prisma.InboundShipmentUncheckedUpdateInput = {};
  const after: Record<string, unknown> = {};
  if (body.supplierRef !== undefined) {
    fields.supplierRef = body.supplierRef;
    after.supplierRef = body.supplierRef;
  }
  if (body.notes !== undefined) {
    fields.notes = body.notes;
    after.notes = body.notes;
  }

  try {
    // The settle paths take a line lock and then a header lock while the linker
    // takes them the other way round, and FD2-1's `FOR UPDATE` read deliberately
    // touches rows this transaction does NOT hold — so a genuine deadlock stays
    // possible however carefully this route orders its own claims. The house
    // retry re-runs the WHOLE transaction, which re-reads the snapshot and
    // re-derives the membership — the retry is only safe because of that.
    await withDeadlockRetry(() =>
      prisma.$transaction(async (tx): Promise<void> => {
        const existing = await tx.inboundShipment.findUnique({ where: { id } });
        if (!existing) refuse({ reason: 'NOT_FOUND' });

        // --- OPEN -> CLOSED ---------------------------------------------------
        if (body.status === InboundShipmentStatus.CLOSED) {
          // LOCK ORDER: the lines this close settles, ascending, before the
          // header. Only lines still in receiving are locked — a GRADUATED line
          // is already real stock and a DISCARDED one is a decision, neither of
          // which this transition touches. This read's ONLY job is that order
          // (FD2-1): it is a snapshot, so it decides nothing.
          const snapshot = await tx.stagingItem.findMany({
            where: { shipmentId: id, status: StagingItemStatus.RECEIVED },
            select: { id: true },
            orderBy: { id: 'asc' },
          });
          let missedFirstPass = false;
          for (const line of snapshot) {
            if (!(await lockLine(tx, id, line.id))) missedFirstPass = true;
          }

          const claim = await tx.inboundShipment.updateMany({
            where: { id, status: InboundShipmentStatus.OPEN },
            data: {
              ...fields,
              status: InboundShipmentStatus.CLOSED,
              closedBy: user.id,
              closedAt: new Date(),
            },
          });
          if (claim.count === 0) refuse({ reason: 'NOT_OPEN' });

          // With the header held, ONE current read answers everything below.
          const current = await currentLines(tx, id);
          heldMembers(
            snapshot.map((l) => l.id),
            current,
            missedFirstPass,
          );

          // THE CLOSE GUARD, over the CURRENT rows — and so is the list it
          // names. A line counted since the snapshot no longer blocks the close;
          // a line whose count was undone since does, BY NAME. (The old list was
          // a snapshot approximation that could be empty while the guard fired.)
          const uncounted = current.filter(
            (line) =>
              line.status === StagingItemStatus.RECEIVED && line.countedQuantity === null,
          );
          if (uncounted.length > 0) {
            refuse({ reason: 'UNCOUNTED', itemIds: uncounted.map((line) => line.id) });
          }

          // The audit rollup, from the same current rows: a close records the
          // receipt as it IS, never as this transaction first saw it.
          const rollup = rollupDiscrepancies(current);
          await recordChange(tx, {
            actor: { userId: user.id },
            actionType: 'SHIPMENT_CLOSE',
            entityType: 'SHIPMENT',
            entityId: id,
            action: `Closed inbound shipment ${id}`,
            // QA-14: fields edited on the way out ride this record's diff.
            ...changesFragment(
              fieldChanges(existing as unknown as Record<string, unknown>, after),
            ),
            details: {
              itemCount: rollup.itemCount,
              countedItemCount: rollup.countedItemCount,
              discrepancyItemCount: rollup.discrepancyItemCount,
              totalOver: rollup.totalOver,
              totalUnder: rollup.totalUnder,
            },
          });

          return;
        }

        // --- OPEN -> CANCELLED ------------------------------------------------
        if (body.status === InboundShipmentStatus.CANCELLED) {
          // LOCK ORDER: the lines this cancel would unlink, ascending, BEFORE the
          // header. Taking the header first was an ABBA against every writer that
          // takes a staging row and then its shipment — including the graduation
          // this transition races with by definition. As on the close path, this
          // read only ORDERS the locks (FD2-1); it decides nothing.
          const snapshot = await tx.stagingItem.findMany({
            where: { shipmentId: id, status: StagingItemStatus.RECEIVED },
            select: { id: true },
            orderBy: { id: 'asc' },
          });
          let missedFirstPass = false;
          for (const line of snapshot) {
            if (!(await lockLine(tx, id, line.id))) missedFirstPass = true;
          }

          // Now the header: the serialization point against a concurrent
          // cancel/close, and against the graduation guard's own shipment claim.
          const claim = await tx.inboundShipment.updateMany({
            where: { id, status: InboundShipmentStatus.OPEN },
            data: { ...fields, status: InboundShipmentStatus.CANCELLED },
          });
          if (claim.count === 0) refuse({ reason: 'NOT_OPEN' });

          // With the header held, ONE current read answers everything below.
          const current = await currentLines(tx, id);

          // THE GUARD, from the CURRENT statuses: cancelling a shipment that
          // already produced real stock would be a lie, and the snapshot this
          // transaction started from cannot see a line that graduated while we
          // waited for these locks.
          const graduated = current.filter(
            (line) => line.status === StagingItemStatus.GRADUATED,
          );
          if (graduated.length > 0) {
            refuse({ reason: 'GRADUATED', itemIds: graduated.map((line) => line.id) });
          }

          // The set this cancel is about to unlink. It runs AFTER the graduation
          // gate on purpose — a line that graduated mid-flight (and therefore
          // also failed its first-pass claim) deserves the refusal that NAMES it,
          // not the generic "membership changed".
          const unlinked = heldMembers(
            snapshot.map((i) => i.id),
            current,
            missedFirstPass,
          );

          // Auto-unlink: the lines lose their header but STAY in staging, so a
          // cancelled shipment never destroys received work.
          await tx.stagingItem.updateMany({
            where: { shipmentId: id, status: StagingItemStatus.RECEIVED },
            data: { shipmentId: null },
          });

          await recordChange(tx, {
            actor: { userId: user.id },
            actionType: 'SHIPMENT_CANCEL',
            entityType: 'SHIPMENT',
            entityId: id,
            action: `Cancelled inbound shipment ${id}`,
            // QA-14: fields edited on the way out ride this record's diff.
            ...changesFragment(
              fieldChanges(existing as unknown as Record<string, unknown>, after),
            ),
            // cancelledBy rides this audit line — T1 deliberately gives the table
            // no cancelledBy column. The ids are the CURRENT membership (FD2-1),
            // not the snapshot: the record names the boxes that actually left.
            details: { unlinkedItemIds: unlinked },
          });

          return;
        }

        // --- field edit while OPEN --------------------------------------------
        const claim = await tx.inboundShipment.updateMany({
          where: { id, status: InboundShipmentStatus.OPEN },
          data: fields,
        });
        if (claim.count === 0) refuse({ reason: 'NOT_OPEN' });

        // Diff over EXACTLY the provided fields (ER-B9: from===to entries drop; an
        // empty diff writes no event). On THIS path the diff is the whole event,
        // so an empty one records nothing at all rather than an empty record.
        const changes = fieldChanges(
          existing as unknown as Record<string, unknown>,
          after,
        );

        if (Object.keys(changes).length > 0) {
          await recordChange(tx, {
            actor: { userId: user.id },
            actionType: 'SHIPMENT_UPDATE',
            entityType: 'SHIPMENT',
            entityId: id,
            action: `Updated inbound shipment ${id}`,
            changes,
          });
        }
      }),
    );
  } catch (error) {
    // Every refusal arrives here, which is also how every refusal rolls back.
    if (error instanceof PatchRefusedError) {
      const { refusal } = error;
      if (refusal.reason === 'NOT_FOUND') {
        return NextResponse.json({ error: 'Inbound shipment not found' }, { status: 404 });
      }
      if (refusal.reason === 'UNCOUNTED') {
        return NextResponse.json(
          {
            error: 'Inbound shipment has uncounted received items and cannot be closed',
            code: 'CONFLICT',
            uncountedItemIds: refusal.itemIds,
          },
          { status: 409 },
        );
      }
      if (refusal.reason === 'MEMBERSHIP_CHANGED') {
        // A legal request that raced, not a rejected one: the client may send it
        // again unchanged, and the next attempt sees the line that arrived.
        return NextResponse.json(
          {
            error:
              'Inbound shipment membership changed while it was being settled — retry',
            code: 'CONFLICT',
            retriable: true,
          },
          { status: 409 },
        );
      }
      if (refusal.reason === 'GRADUATED') {
        return NextResponse.json(
          {
            error:
              'Inbound shipment has graduated lines and cannot be cancelled; unlink or reverse them first',
            code: 'CONFLICT',
            graduatedItemIds: refusal.itemIds,
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: 'Inbound shipment is not open and cannot be changed', code: 'CONFLICT' },
        { status: 409 },
      );
    }
    throw error;
  }

  // Respond with the SAME shape GET serves, so a mutating client never has to
  // reconcile two dialects.
  const detail = await getInboundShipmentDetail(id);
  const response = NextResponse.json(detail);
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
