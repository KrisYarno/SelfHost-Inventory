import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import { AppError } from '@/lib/error-handling';
import prisma from '@/lib/prisma';
import { InboundShipmentStatus, Prisma, StagingItemStatus } from '@prisma/client';
import { recordChange, newBatchId, type ChangeDiff } from '@/lib/change-tracking';
import {
  PatchSupplyOrderSchema,
  assertPatchNotEmpty,
  assertRealCalendarDate,
} from '@/lib/validation/supply-orders';
import { getSupplyOrderDetail, modelOf } from '@/lib/supply-orders/queries';
import { claimHeaderTransition, lockLinesForUpdate } from '@/lib/supply-orders/claims';
import { UnverifiedRefusal } from '@/lib/supply-orders/refusals';
import { rollupDiscrepancies } from '@/lib/shipments/rollup';
import { withDeadlockRetry } from '@/lib/inventory';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
  };
}

/** The header fields a diff on this route can name, plus the current status. */
type CurrentHeader = {
  status: InboundShipmentStatus;
  supplier: string | null;
  supplierRef: string | null;
  notes: string | null;
  feesCents: number | null;
  feesNote: string | null;
  orderedAt: Date | null;
};

/**
 * THE AUDIT'S BEFORE-IMAGE, LOCKED (the FD4-2 idiom this route was rebuilt on).
 *
 * The `findUnique` above answers the 404 and the MODEL question from this
 * transaction's snapshot, which is older than every lock below it. A field-only
 * PATCH that commits A -> B in between is invisible to it, and the diff would
 * then lie in one of two directions: A -> C when the truth is B -> C, or nothing
 * at all when this request restates A over that B. An overwrite IS a change.
 *
 * So the before-image — and the STATUS every refusal below is worded from —
 * comes from HERE: one `SELECT ... FOR UPDATE` of exactly the diffable fields,
 * taken with the lines already locked (lock order lines -> header, uniform
 * across the lane) and immediately before the claim that would take that lock
 * anyway.
 *
 * Raw SQL because Prisma has no `FOR UPDATE` (house precedent:
 * `lib/products/decline.ts`, `lib/supply-orders/claims.ts`). The id is a BOUND
 * parameter, never interpolated.
 */
async function lockedHeader(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<CurrentHeader | null> {
  const rows = await tx.$queryRaw<CurrentHeader[]>(
    Prisma.sql`SELECT status, supplier, supplierRef, notes, feesCents, feesNote, orderedAt FROM inbound_shipments WHERE id = ${id} FOR UPDATE`,
  );
  return rows[0] ?? null;
}

/**
 * The diff for the fields this PATCH explicitly provided (ER-B9: a `from === to`
 * entry drops, and an empty diff attaches nothing).
 *
 * QA-14: this rides the CLOSE and CANCEL records too. Field edits are legal in
 * the same request as a transition, and one transaction commits them together —
 * so a note rewritten on the way out must be recorded by the event that carried
 * it, not by nothing at all.
 */
function fieldChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ChangeDiff {
  const changes: ChangeDiff = {};
  for (const [field, to] of Object.entries(after)) {
    const from = before[field] ?? null;
    const normalizedTo = to ?? null;
    if (!sameValue(from, normalizedTo)) {
      changes[field] = { from, to: normalizedTo };
    }
  }
  return changes;
}

/**
 * `orderedAt` is the one diffable field that arrives as a Date, and two Date
 * objects holding the same instant are never `Object.is`-equal — restating
 * today's date would otherwise record a change that did not happen.
 */
function sameValue(from: unknown, to: unknown): boolean {
  if (from instanceof Date && to instanceof Date) return from.getTime() === to.getTime();
  return Object.is(from, to);
}

/** `changes: {...}` when there is a diff, nothing at all when there is not. */
function changesFragment(changes: ChangeDiff): { changes?: ChangeDiff } {
  return Object.keys(changes).length > 0 ? { changes } : {};
}

/** The line-status census a close records beside its money rollup. */
function lineStatusCounts(lines: readonly { status: StagingItemStatus }[]) {
  const counts = { ordered: 0, verified: 0, labeling: 0, complete: 0, discarded: 0 };
  for (const line of lines) {
    if (line.status === StagingItemStatus.ORDERED) counts.ordered += 1;
    else if (line.status === StagingItemStatus.VERIFIED) counts.verified += 1;
    else if (line.status === StagingItemStatus.LABELING) counts.labeling += 1;
    else if (line.status === StagingItemStatus.COMPLETE) counts.complete += 1;
    else if (line.status === StagingItemStatus.DISCARDED) counts.discarded += 1;
  }
  return counts;
}

// GET /api/inbound-shipments/[id] — one order (or one legacy receipt), whole.
export const GET = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  await requireApproved();

  const detail = await getSupplyOrderDetail(params.id);
  if (!detail) {
    return NextResponse.json({ error: 'Inbound shipment not found' }, { status: 404 });
  }

  return NextResponse.json(detail);
});

/**
 * PATCH /api/inbound-shipments/[id] — the SUPPLY-ORDER state machine (§4.0).
 *
 * It forks on the header's MODEL first and on its STATUS second, never on the
 * body: CLOSED and CANCELLED exist in both machines, so status could never tell
 * the two families apart. A legacy (W1) receipt is history — 409
 * `LEGACY_READ_ONLY`, with no mutation path at all.
 *
 *   fields          supplier / supplierRef / orderedAt / notes / fees, legal
 *                   while ORDERED or RECEIVING (audit `SHIPMENT_UPDATE`).
 *   action: close   RECEIVING only. Refused while ANY line is still ORDERED —
 *                   the frozen 409 `UNVERIFIED` naming them, because closing a
 *                   receipt nobody counted is exactly the lie this flow exists
 *                   to stop. An ORDERED header is refused BY NAME: nothing was
 *                   verified, so cancel is the honest act, not close.
 *   action: cancel  ORDERED only. Its lines go DISCARDED (they are kept, not
 *                   unlinked — the order records what was ordered), and the
 *                   header is CANCELLED, never CLOSED.
 *
 * LOCK ORDER, uniform with every other writer in the lane: lines (ascending)
 * then the header. `lockLinesForUpdate` is the FD2-1 idiom — ascending no-op
 * claims for the order, then ONE `ORDER BY id FOR UPDATE` read that every
 * decision, every named id and the audit rollup derive from. It can genuinely
 * deadlock, which is why the whole transaction runs inside `withDeadlockRetry`;
 * the retry is only safe because nothing here is decided outside it.
 */
export const PATCH = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'inbound-shipments:PATCH', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const id = params.id;
  const body = PatchSupplyOrderSchema.parse(await request.json());
  assertPatchNotEmpty(body);
  if (body.orderedAt !== undefined) assertRealCalendarDate(body.orderedAt, 'orderedAt');

  // A true partial update: only keys explicitly present in the body are written,
  // and they ride ALONG with a transition when both are asked for.
  const fields: Prisma.InboundShipmentUncheckedUpdateInput = {};
  const after: Record<string, unknown> = {};
  if (body.supplier !== undefined) {
    fields.supplier = body.supplier;
    after.supplier = body.supplier;
  }
  if (body.supplierRef !== undefined) {
    fields.supplierRef = body.supplierRef;
    after.supplierRef = body.supplierRef;
  }
  if (body.notes !== undefined) {
    fields.notes = body.notes;
    after.notes = body.notes;
  }
  if (body.feesCents !== undefined) {
    fields.feesCents = body.feesCents;
    after.feesCents = body.feesCents;
  }
  if (body.feesNote !== undefined) {
    fields.feesNote = body.feesNote;
    after.feesNote = body.feesNote;
  }
  if (body.orderedAt !== undefined) {
    const orderedAt = new Date(`${body.orderedAt}T00:00:00.000Z`);
    fields.orderedAt = orderedAt;
    after.orderedAt = orderedAt;
  }

  const batchId = newBatchId();

  try {
    await withDeadlockRetry(() =>
      prisma.$transaction(async (tx): Promise<void> => {
        const existing = await tx.inboundShipment.findUnique({ where: { id } });
        if (!existing) {
          throw new AppError('Inbound shipment not found', 'NOT_FOUND', 404);
        }
        if (modelOf(existing) === 'legacy') {
          throw new AppError(
            `Inbound shipment ${id} is a legacy receipt (pre-staging history) and is read-only`,
            'LEGACY_READ_ONLY',
            409,
          );
        }

        // --- action: close ---------------------------------------------------
        if (body.action === 'close') {
          const lines = await lockLinesForUpdate(tx, id);

          const unverified = lines
            .filter((line) => line.status === StagingItemStatus.ORDERED)
            .map((line) => line.id);
          if (unverified.length > 0) throw new UnverifiedRefusal(unverified);

          const before = await lockedHeader(tx, id);
          if (before === null) {
            throw new AppError('Inbound shipment not found', 'NOT_FOUND', 404);
          }
          if (before.status === InboundShipmentStatus.ORDERED) {
            throw new AppError(
              `Supply order ${id} has nothing verified — cancel it instead of closing it`,
              'CONFLICT',
              409,
            );
          }
          if (!(await claimHeaderTransition(
            tx,
            id,
            [InboundShipmentStatus.RECEIVING],
            InboundShipmentStatus.CLOSED,
          ))) {
            throw new AppError(
              `Supply order ${id} is ${before.status.toLowerCase()} and cannot be closed`,
              'CONFLICT',
              409,
            );
          }

          // The claim already holds the header; this stamps WHO closed it and
          // WHEN, plus any field edit riding the same request.
          await tx.inboundShipment.update({
            where: { id },
            data: { ...fields, closedBy: user.id, closedAt: new Date() },
          });

          await recordChange(tx, {
            actor: { userId: user.id },
            actionType: 'SHIPMENT_CLOSE',
            entityType: 'SHIPMENT',
            entityId: id,
            action: `Closed supply order ${id}`,
            batchId,
            ...changesFragment(fieldChanges(before, after)),
            details: {
              // The rollup is read off the LOCKED rows: a close records the order
              // as it IS, never as this transaction first saw it.
              discrepancy: rollupDiscrepancies(lines, { model: 'supply-order' }),
              lineStatusCounts: lineStatusCounts(lines),
              lineCount: lines.length,
            },
          });

          return;
        }

        // --- action: cancel --------------------------------------------------
        if (body.action === 'cancel') {
          const lines = await lockLinesForUpdate(tx, id);

          const before = await lockedHeader(tx, id);
          if (before === null) {
            throw new AppError('Inbound shipment not found', 'NOT_FOUND', 404);
          }
          if (before.status !== InboundShipmentStatus.ORDERED) {
            throw new AppError(
              `Supply order ${id} is ${before.status.toLowerCase()} — a delivery has already been verified against it, so it closes rather than cancels`,
              'CONFLICT',
              409,
            );
          }

          const discardedLineIds = lines
            .filter((line) => line.status === StagingItemStatus.ORDERED)
            .map((line) => line.id);

          // The lines are DISCARDED, not unlinked: a cancelled order still says
          // what it ordered, and the products it minted are kept (OCs-6).
          await tx.stagingItem.updateMany({
            where: { shipmentId: id, status: StagingItemStatus.ORDERED },
            data: { status: StagingItemStatus.DISCARDED },
          });

          if (!(await claimHeaderTransition(
            tx,
            id,
            [InboundShipmentStatus.ORDERED],
            InboundShipmentStatus.CANCELLED,
          ))) {
            throw new AppError(
              `Supply order ${id} changed state while it was being cancelled; reload and retry`,
              'CONFLICT',
              409,
            );
          }

          if (Object.keys(fields).length > 0) {
            await tx.inboundShipment.update({ where: { id }, data: fields });
          }

          await recordChange(tx, {
            actor: { userId: user.id },
            actionType: 'SHIPMENT_CANCEL',
            entityType: 'SHIPMENT',
            entityId: id,
            action: `Cancelled supply order ${id}`,
            batchId,
            ...changesFragment(fieldChanges(before, after)),
            // cancelledBy rides this audit line — T1 deliberately gives the table
            // no cancelledBy column. The ids are the LOCKED membership (FD2-1).
            details: { discardedLineIds, lineCount: lines.length },
          });

          return;
        }

        // --- field edit ------------------------------------------------------
        // This path locks only the header, and its claim is where that lock is
        // taken — so the locking read goes immediately before it.
        const before = await lockedHeader(tx, id);
        if (before === null) {
          throw new AppError('Inbound shipment not found', 'NOT_FOUND', 404);
        }

        const claim = await tx.inboundShipment.updateMany({
          where: {
            id,
            status: { in: [InboundShipmentStatus.ORDERED, InboundShipmentStatus.RECEIVING] },
          },
          data: fields,
        });
        if (claim.count === 0) {
          throw new AppError(
            `Supply order ${id} is ${before.status.toLowerCase()} and can no longer be edited`,
            'CONFLICT',
            409,
          );
        }

        const changes = fieldChanges(before, after);
        if (Object.keys(changes).length > 0) {
          await recordChange(tx, {
            actor: { userId: user.id },
            actionType: 'SHIPMENT_UPDATE',
            entityType: 'SHIPMENT',
            entityId: id,
            action: `Updated supply order ${id}`,
            batchId,
            changes,
          });
        }
      }),
    );
  } catch (error) {
    // The STRUCTURED refusal, mapped AFTER the retry wrapper (pack C3a.0): an
    // `AppError` renders as `{ error, code }` only, and a close that refuses has
    // to NAME the lines still owed. Everything else travels through apiHandler.
    if (error instanceof UnverifiedRefusal) {
      return NextResponse.json(
        { error: error.message, code: error.code, lineIds: error.lineIds },
        { status: 409 },
      );
    }
    throw error;
  }

  // Respond with the SAME shape GET serves, so a mutating client never has to
  // reconcile two dialects.
  const detail = await getSupplyOrderDetail(id);
  const response = NextResponse.json(detail);
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
