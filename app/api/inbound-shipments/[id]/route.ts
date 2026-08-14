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

/**
 * Count rows matching `where` with a CURRENT read.
 *
 * `tx.stagingItem.count` would not do: under REPEATABLE READ a plain SELECT
 * answers from the snapshot this transaction took at its FIRST read — before any
 * of the locks below — so a line that graduated (or was linked) mid-flight would
 * be invisible to exactly the guard that exists to catch it. An UPDATE reads the
 * latest committed version instead, and restating the status it matched makes
 * the write a no-op whose `count` is the answer.
 */
async function claimCount(
  tx: Prisma.TransactionClient,
  where: Prisma.StagingItemWhereInput & { status: StagingItemStatus },
): Promise<number> {
  const claim = await tx.stagingItem.updateMany({
    where,
    data: { status: where.status },
  });
  return claim.count;
}

/**
 * The shipment's CURRENT membership, re-derived with the header already claimed
 * (FD-2). Returns the lines this settle may act on; refuses when that is no
 * longer the set the locks above were taken over.
 *
 * Two directions of drift, two detectors, both current reads:
 *
 *   a line that LEFT   its per-line claim matches nothing (`shipmentId` is
 *                      pinned), so it drops out of `still`;
 *   a line that JOINED it was never locked, so it cannot be counted one by one
 *                      — the set-wide claim is what sees it, and its `count`
 *                      exceeds the set we hold.
 *
 * Either way this transaction throws rather than settling: the arriving line was
 * never locked, so acting on it would unlink a box nobody serialized against,
 * and reporting only the snapshot would leave that box's departure unrecorded.
 * The refusal is RETRIABLE — the request was legal, it just raced — and the
 * caller's re-run starts from a snapshot that includes the newcomer.
 */
async function currentMembers(
  tx: Prisma.TransactionClient,
  shipmentId: string,
  lockedIds: number[],
): Promise<number[]> {
  const still: number[] = [];
  for (const itemId of lockedIds) {
    // Ascending, exactly as the locks were taken: the same order twice can
    // never be an order two settles disagree about.
    if (await lockLine(tx, shipmentId, itemId)) still.push(itemId);
  }

  const linkedNow = await claimCount(tx, {
    shipmentId,
    status: StagingItemStatus.RECEIVED,
  });
  if (still.length !== lockedIds.length || linkedNow !== lockedIds.length) {
    refuse({ reason: 'MEMBERSHIP_CHANGED' });
  }

  return still;
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
 * Both settle guards then re-run as CURRENT reads with those locks in hand (see
 * `claimCount`), because the plain reads that name the offending lines answer
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
    // FD-2: the settle paths take a line lock and then a header lock while the
    // linker takes them the other way round, so a genuine deadlock stays
    // possible however carefully this route orders its own claims. The house
    // retry re-runs the WHOLE transaction, which re-reads the snapshot and
    // re-derives the membership — the retry is only safe because of that.
    await withDeadlockRetry(() =>
      prisma.$transaction(async (tx): Promise<void> => {
        const existing = await tx.inboundShipment.findUnique({ where: { id } });
        if (!existing) refuse({ reason: 'NOT_FOUND' });

        // --- OPEN -> CLOSED ---------------------------------------------------
        if (body.status === InboundShipmentStatus.CLOSED) {
          // One read serves both the close guard's message and the audit rollup.
          const lines = await tx.stagingItem.findMany({
            where: { shipmentId: id },
            select: { id: true, status: true, expectedQuantity: true, countedQuantity: true },
            orderBy: { id: 'asc' },
          });

          // LOCK ORDER: the lines this close settles, ascending, before the header.
          // Only lines still in receiving are locked — a GRADUATED line is already
          // real stock and a DISCARDED one is a decision, neither of which this
          // transition touches.
          const receiving = lines.filter((l) => l.status === StagingItemStatus.RECEIVED);
          for (const line of receiving) {
            await lockLine(tx, id, line.id);
          }

          // The close guard, re-run as a CURRENT read now that the lines are held.
          // A box LINKED to this shipment since the snapshot above is invisible to
          // that read, and closing over it would settle a receipt nobody counted.
          const uncountedNow = await claimCount(tx, {
            shipmentId: id,
            status: StagingItemStatus.RECEIVED,
            countedQuantity: null,
          });
          if (uncountedNow > 0) {
            // Named from the snapshot, which is what can be named at all; the
            // COUNT above is what decides. A line that arrived after the snapshot
            // blocks the close without appearing in the list, and the message
            // still tells the truth.
            refuse({
              reason: 'UNCOUNTED',
              itemIds: receiving.filter((l) => l.countedQuantity === null).map((l) => l.id),
            });
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

          // FD-2: with the header held, re-derive the membership. A line linked
          // between the guard above and this claim would be closed over having
          // been neither locked nor counted, and the rollup below would describe
          // a receipt that is not the one being settled.
          await currentMembers(
            tx,
            id,
            receiving.map((l) => l.id),
          );

          const rollup = rollupDiscrepancies(lines);
          await recordChange(tx, {
            actor: { userId: user.id },
            actionType: 'SHIPMENT_CLOSE',
            entityType: 'SHIPMENT',
            entityId: id,
            action: `Closed inbound shipment ${id}`,
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
          // this transition races with by definition.
          const toUnlink = await tx.stagingItem.findMany({
            where: { shipmentId: id, status: StagingItemStatus.RECEIVED },
            select: { id: true },
            orderBy: { id: 'asc' },
          });
          for (const line of toUnlink) {
            await lockLine(tx, id, line.id);
          }

          // Now the header: the serialization point against a concurrent
          // cancel/close, and against the graduation guard's own shipment claim.
          const claim = await tx.inboundShipment.updateMany({
            where: { id, status: InboundShipmentStatus.OPEN },
            data: { ...fields, status: InboundShipmentStatus.CANCELLED },
          });
          if (claim.count === 0) refuse({ reason: 'NOT_OPEN' });

          // THE GUARD, with every lock in hand and as a CURRENT read: cancelling a
          // shipment that already produced real stock would be a lie, and the
          // snapshot this transaction started from cannot see a line that
          // graduated while we waited for these locks.
          if (await claimCount(tx, { shipmentId: id, status: StagingItemStatus.GRADUATED })) {
            const graduated = await tx.stagingItem.findMany({
              where: { shipmentId: id, status: StagingItemStatus.GRADUATED },
              select: { id: true },
              orderBy: { id: 'asc' },
            });
            refuse({ reason: 'GRADUATED', itemIds: graduated.map((g) => g.id) });
          }

          // FD-2: the set this cancel is about to unlink, re-derived as a current
          // read now that the header is held. It runs AFTER the graduation gate
          // on purpose — a line that graduated mid-flight deserves the refusal
          // that NAMES it, not the generic "membership changed".
          const unlinked = await currentMembers(
            tx,
            id,
            toUnlink.map((i) => i.id),
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
            // cancelledBy rides this audit line — T1 deliberately gives the table
            // no cancelledBy column. The ids are the CURRENT membership (FD-2),
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
