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
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
  };
}

/**
 * Thrown inside the CANCEL transaction to roll back a claim that has ALREADY
 * written. The cancel is conditional on "no linked GRADUATED line", and that
 * condition can only be evaluated after the auto-unlink has run — so the abort
 * is a rollback, never a pre-write read that a concurrent graduation could
 * invalidate. Caught in the handler; never escapes this module.
 */
class GraduatedLinesError extends Error {
  constructor(readonly itemIds: number[]) {
    super('inbound shipment has graduated lines');
    this.name = 'GraduatedLinesError';
  }
}

type PatchOutcome =
  | { ok: true }
  | { ok: false; reason: 'NOT_FOUND' }
  | { ok: false; reason: 'NOT_OPEN' }
  | { ok: false; reason: 'UNCOUNTED'; itemIds: number[] };

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

  let outcome: PatchOutcome;
  try {
    outcome = await prisma.$transaction(async (tx): Promise<PatchOutcome> => {
      const existing = await tx.inboundShipment.findUnique({ where: { id } });
      if (!existing) return { ok: false, reason: 'NOT_FOUND' };

      // --- OPEN -> CLOSED ---------------------------------------------------
      if (body.status === InboundShipmentStatus.CLOSED) {
        // One read serves both the close guard and the audit rollup.
        const lines = await tx.stagingItem.findMany({
          where: { shipmentId: id },
          select: { id: true, status: true, expectedQuantity: true, countedQuantity: true },
          orderBy: { id: 'asc' },
        });

        // Only lines still in receiving block the close: a GRADUATED line is
        // already real stock and a DISCARDED one is a decision, not a gap.
        const uncounted = lines
          .filter((l) => l.status === StagingItemStatus.RECEIVED && l.countedQuantity === null)
          .map((l) => l.id);
        if (uncounted.length > 0) {
          return { ok: false, reason: 'UNCOUNTED', itemIds: uncounted };
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
        if (claim.count === 0) return { ok: false, reason: 'NOT_OPEN' };

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

        return { ok: true };
      }

      // --- OPEN -> CANCELLED ------------------------------------------------
      if (body.status === InboundShipmentStatus.CANCELLED) {
        // The claim comes FIRST — it is the serialization point against a
        // concurrent cancel/close.
        const claim = await tx.inboundShipment.updateMany({
          where: { id, status: InboundShipmentStatus.OPEN },
          data: { ...fields, status: InboundShipmentStatus.CANCELLED },
        });
        if (claim.count === 0) return { ok: false, reason: 'NOT_OPEN' };

        // Auto-unlink: the lines lose their header but STAY in staging, so a
        // cancelled shipment never destroys received work. The unlink is itself
        // a claim scoped to RECEIVED, so a line that graduated mid-flight is
        // left alone — and then caught by the guard below.
        const toUnlink = await tx.stagingItem.findMany({
          where: { shipmentId: id, status: StagingItemStatus.RECEIVED },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        await tx.stagingItem.updateMany({
          where: { shipmentId: id, status: StagingItemStatus.RECEIVED },
          data: { shipmentId: null },
        });

        const graduated = await tx.stagingItem.findMany({
          where: { shipmentId: id, status: StagingItemStatus.GRADUATED },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        if (graduated.length > 0) {
          // Cancelling a shipment that already produced real stock would be a
          // lie. Roll the whole transaction back — claim, unlink and all.
          throw new GraduatedLinesError(graduated.map((g) => g.id));
        }

        await recordChange(tx, {
          actor: { userId: user.id },
          actionType: 'SHIPMENT_CANCEL',
          entityType: 'SHIPMENT',
          entityId: id,
          action: `Cancelled inbound shipment ${id}`,
          // cancelledBy rides this audit line — T1 deliberately gives the table
          // no cancelledBy column.
          details: { unlinkedItemIds: toUnlink.map((i) => i.id) },
        });

        return { ok: true };
      }

      // --- field edit while OPEN --------------------------------------------
      const claim = await tx.inboundShipment.updateMany({
        where: { id, status: InboundShipmentStatus.OPEN },
        data: fields,
      });
      if (claim.count === 0) return { ok: false, reason: 'NOT_OPEN' };

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

      return { ok: true };
    });
  } catch (error) {
    if (error instanceof GraduatedLinesError) {
      return NextResponse.json(
        {
          error:
            'Inbound shipment has graduated lines and cannot be cancelled; unlink or reverse them first',
          code: 'CONFLICT',
          graduatedItemIds: error.itemIds,
        },
        { status: 409 },
      );
    }
    throw error;
  }

  if (!outcome.ok) {
    if (outcome.reason === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Inbound shipment not found' }, { status: 404 });
    }
    if (outcome.reason === 'UNCOUNTED') {
      return NextResponse.json(
        {
          error: 'Inbound shipment has uncounted received items and cannot be closed',
          code: 'CONFLICT',
          uncountedItemIds: outcome.itemIds,
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: 'Inbound shipment is not open and cannot be changed', code: 'CONFLICT' },
      { status: 409 },
    );
  }

  // Respond with the SAME shape GET serves, so a mutating client never has to
  // reconcile two dialects.
  const detail = await getInboundShipmentDetail(id);
  const response = NextResponse.json(detail);
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
