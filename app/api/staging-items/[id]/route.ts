import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import { AppError } from '@/lib/error-handling';
import prisma from '@/lib/prisma';
import { Prisma, StagingItemStatus } from '@prisma/client';
import { PatchStagingSchema, assertStagingPatchOmitsCount } from '@/lib/validation/staging';
import { getStagingItem } from '@/lib/staging/queries';
import { recordChange, type ChangeDiff } from '@/lib/change-tracking';
import { applyShipmentLink, claimShipmentForCount } from '@/lib/shipments/lifecycle';
import { withDeadlockRetry } from '@/lib/inventory';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
  };
}

// GET /api/staging-items/[id] - Fetch a single staging item
export const GET = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  await requireApproved();

  const id = parseInt(params.id, 10);
  if (isNaN(id)) {
    return NextResponse.json({ error: 'Invalid staging item ID' }, { status: 400 });
  }

  const item = await getStagingItem(id);
  if (!item) {
    return NextResponse.json({ error: 'Staging item not found' }, { status: 404 });
  }

  return NextResponse.json(item);
});

/**
 * The state-bearing fields (pack REV-3 T2, W1-2b). Every one of them describes
 * WHAT MOVED — the receipt figures, the product it became, where it landed, and
 * which receipt it belongs to. Once the line graduated, all of them are the
 * history of a real stock movement, and a PATCH would rewrite that story after
 * the fact: 409. (`countedQuantity` is another frozen field; it never reaches
 * this list because it left the PATCH surface entirely — the count endpoint's
 * own RECEIVED guard freezes it.)
 *
 * W1-4b added `unitCostCents` to the list: graduation books the ledger's
 * receipt cost FROM it, so after graduation it is the price real stock was
 * valued at — a receipt figure by the same definition as expectedQuantity.
 *
 * Free-text annotation (description / vendor / reference / notes) is
 * deliberately NOT frozen: it labels the box, it does not restate the movement.
 *
 * W1S-1 (W1-C fix round) made the freeze ATOMIC. The list below still produces
 * the READ-based 409 (it is what names the offending fields in the message), but
 * it is no longer what enforces the rule: every write of a field on this list
 * carries `status: RECEIVED` in its own WHERE, so a graduation that commits
 * between the read and the write takes the row and the PATCH gets a 409 instead
 * of quietly rewriting a settled receipt.
 */
const STATE_FIELDS = [
  'expectedQuantity',
  'resolvedProductId',
  'locationId',
  'shipmentId',
  'unitCostCents',
] as const;

// PATCH /api/staging-items/[id] - Edit / label a staging item
export const PATCH = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'staging-items:PATCH', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const id = parseInt(params.id, 10);
  if (isNaN(id)) {
    return NextResponse.json({ error: 'Invalid staging item ID' }, { status: 400 });
  }

  // Counting left this surface (pack REV-3 T2): refuse the field outright
  // rather than let Zod strip it, so a caller can never believe it counted.
  const raw = await request.json();
  assertStagingPatchOmitsCount(raw);
  const body = PatchStagingSchema.parse(raw);

  // Build a true partial update: only keys explicitly present in the body are
  // written, so PATCH never clobbers untouched columns.
  //
  // The body splits in TWO (W1S-1), because the two halves are governed
  // differently: `labelData` may be written at any time, while `stateData` may
  // only be written to a line that is STILL RECEIVED — and that precondition
  // rides in the write's own WHERE, which means scalar FK columns rather than
  // Prisma relation connects (`updateMany` takes no nested writes).
  //
  // `after` collects the SCALAR after-values for the change diff, unchanged.
  const stateData: Prisma.StagingItemUncheckedUpdateManyInput = {};
  const labelData: Prisma.StagingItemUncheckedUpdateManyInput = {};
  const after: Record<string, unknown> = {};
  if (body.description !== undefined) {
    labelData.description = body.description;
    after.description = body.description;
  }
  if (body.expectedQuantity !== undefined) {
    stateData.expectedQuantity = body.expectedQuantity;
    after.expectedQuantity = body.expectedQuantity;
  }
  if (body.vendor !== undefined) {
    labelData.vendor = body.vendor;
    after.vendor = body.vendor;
  }
  if (body.reference !== undefined) {
    labelData.reference = body.reference;
    after.reference = body.reference;
  }
  if (body.notes !== undefined) {
    labelData.notes = body.notes;
    after.notes = body.notes;
  }
  if (body.locationId !== undefined) {
    stateData.locationId = body.locationId;
    after.locationId = body.locationId;
  }
  if (body.resolvedProductId !== undefined) {
    stateData.resolvedProductId = body.resolvedProductId;
    after.resolvedProductId = body.resolvedProductId;
  }
  // W1-4b (T3): the receipt line's cost. `null` is a legal WRITE here (it means
  // "un-price this line"), so the `!== undefined` test is the only one that can
  // distinguish it from an untouched field.
  if (body.unitCostCents !== undefined) {
    stateData.unitCostCents = body.unitCostCents;
    after.unitCostCents = body.unitCostCents;
  }
  // shipmentId is deliberately NOT part of the generic field path: it is a state
  // transition with its own guards and its own audit verbs (T4), handled below.
  // Its write is already conditional — `applyShipmentLink`'s claim pins
  // (id, RECEIVED, current link) — so W1S-1 leaves it alone.
  const writesState = Object.keys(stateData).length > 0;

  // Update + record atomically (D4); the before-image is read inside the tx.
  //
  // FD6-1 (fix round 8) — AND THE HOUSE DEADLOCK RETRY AROUND IT. This route is
  // item-first (the preclaim below), so it holds a line and then asks for that
  // line's header; the freight bill (POST /api/inbound-shipments/[id]/costs)
  // holds the header and then asks — through its `FOR UPDATE` membership read —
  // for lines it does not hold. A real cycle, and InnoDB rolls back whichever
  // transaction did the LEAST work, which against a whole bill is this one. The
  // bill was already wrapped; unwrapped, a PATCH lost that race with an
  // unhandled 500 rather than its own named 409.
  //
  // Re-running is safe because EVERY database-derived decision is made inside
  // this callback: `existing` is the transaction's first read, and the freeze
  // verdict, the relink/reclaim classification, the preclaim, the link and the
  // diff are all computed from it. What is built above the transaction is built
  // from the parsed request body alone (`stateData` / `labelData` / `after` /
  // `writesState`), which no retry can change, so a re-run re-derives everything
  // that could have moved from a fresh snapshot.
  const item = await withDeadlockRetry(() =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.stagingItem.findUnique({ where: { id } });
      if (!existing) {
        throw new AppError('Staging item not found', 'NOT_FOUND', 404);
      }

      // --- the post-graduation FREEZE (pack REV-3 T2) ---------------------
      // Checked before ANY write, and over the whole body at once, so a request
      // that mixes a frozen field with a legal one is refused entirely rather
      // than applied in part.
      const frozen = STATE_FIELDS.filter((field) => body[field] !== undefined);
      if (frozen.length > 0 && existing.status !== StagingItemStatus.RECEIVED) {
        throw new AppError(
          `Staging item ${id} is ${existing.status.toLowerCase()}; ${frozen.join(', ')} can no longer be changed`,
          'CONFLICT',
          409,
        );
      }

      // --- LOCK ORDER: THE ITEM FIRST, THEN ITS SHIPMENT (W1-4b ride-along) -
      // The count endpoint and graduation both take these two rows item ->
      // shipment. This route took them the other way round — every shipment claim
      // below fired while the item row was still only READ, its lock arriving at
      // the closing `update`. That is a genuine ABBA between two acts the
      // receiving workflow puts back-to-back (price a line, count the same box).
      //
      // So: one claim on the ITEM, before any shipment work. It is a NO-OP write
      // (it re-states the status it matched) whose value is the row lock, and its
      // WHERE is the precondition — a line that changed status or moved between
      // the read above and this write loses with `count === 0`.
      //
      // Only the paths that ACTUALLY touch a shipment take it. A label edit, an
      // unlinked line, and a link that is already where it was asked to be do no
      // shipment work at all, so there is no lock pair to order and no reason to
      // write.
      const relinking = body.shipmentId !== undefined && body.shipmentId !== existing.shipmentId;
      const reclaimingQuantity = body.expectedQuantity !== undefined && existing.shipmentId !== null;
      if (relinking || reclaimingQuantity) {
        const lock = await tx.stagingItem.updateMany({
          where: { id, status: existing.status, shipmentId: existing.shipmentId },
          data: { status: existing.status },
        });
        if (lock.count === 0) {
          throw new AppError(
            `Staging item ${id} changed state while it was being updated; reload and retry`,
            'CONFLICT',
            409,
          );
        }
      }

      // expectedQuantity is the count's counterpart in the discrepancy
      // arithmetic, so it freezes when receiving ends: its shipment must be OPEN.
      // resolvedProductId / locationId / unitCostCents deliberately do NOT take
      // this claim — under the stranded-line amendment a CLOSED shipment's lines
      // can still graduate, and those three fields are exactly what a graduation
      // consumes.
      //
      // FD-3 (fix round 2): this claim runs here ONLY when the request changes no
      // link. A combined quantity+relink PATCH would otherwise claim the source
      // header before `applyShipmentLink`'s sorted pair, putting one request's
      // headers in request order and another's in id order — the very ABBA the
      // sort exists to remove. On that path the guard travels INTO the link as
      // `alsoOpen`, so all three headers are claimed once each, in one order.
      if (reclaimingQuantity && !relinking && existing.shipmentId !== null) {
        await claimShipmentForCount(tx, existing.shipmentId);
      }

      // Inventory-accuracy lane (pack REV-2 T4): join / leave a receiving header.
      // Legal only while the item is RECEIVED and every shipment involved is OPEN;
      // applyShipmentLink throws 404/409 (its claims are the guards) and the throw
      // aborts this whole transaction, field edits included.
      if (body.shipmentId !== undefined) {
        const link = await applyShipmentLink(tx, {
          item: existing,
          targetShipmentId: body.shipmentId,
          // The quantity guard, when this request also carries one. It is the
          // source header — already in the link's own set — but naming it keeps
          // the rule structural instead of incidental.
          alsoOpen:
            reclaimingQuantity && relinking && existing.shipmentId !== null
              ? [existing.shipmentId]
              : [],
        });

        if (link.action === 'UNLINK' || link.action === 'RELINK') {
          await recordChange(tx, {
            actor: { userId: user.id },
            actionType: 'SHIPMENT_UNLINK',
            entityType: 'SHIPMENT',
            entityId: link.previousShipmentId,
            action: `Unlinked staging item ${id} from inbound shipment ${link.previousShipmentId}`,
            details: { stagingItemId: id },
          });
        }
        if (link.action === 'LINK' || link.action === 'RELINK') {
          await recordChange(tx, {
            actor: { userId: user.id },
            actionType: 'SHIPMENT_LINK',
            entityType: 'SHIPMENT',
            entityId: body.shipmentId,
            action: `Linked staging item ${id} to inbound shipment ${body.shipmentId}`,
            details: { stagingItemId: id, previousShipmentId: link.previousShipmentId },
          });
        }
      }

      // --- the write, and the OTHER half of the freeze (W1S-1) -------------
      // A state-bearing write carries its own precondition. The read-based verdict
      // above is a snapshot: a graduation committing between it and this line
      // would leave the old, unconditional `update` rewriting the receipt figures
      // of stock that is already on the shelf. Conditioning the write on
      // `status: RECEIVED` hands the decision to MySQL, and the loser writes
      // nothing at all — label fields included, since they ride the same statement.
      //
      // FD3-1 (fix round 4) took round 3's caller-supplied cost precondition back
      // OUT of this statement. It existed for the freight panel's per-line
      // fan-out, and the fan-out itself was the defect — a bill is now ONE atomic
      // request (POST /api/inbound-shipments/[id]/costs) which owns those
      // preconditions. What is left here is the MANUAL per-line save,
      // unconditional as originally built.
      let updated;
      if (writesState) {
        const write = await tx.stagingItem.updateMany({
          where: { id, status: StagingItemStatus.RECEIVED },
          data: { ...stateData, ...labelData },
        });
        if (write.count === 0) {
          throw new AppError(
            `Staging item ${id} changed state while it was being updated; reload and retry`,
            'CONFLICT',
            409,
          );
        }
        const row = await tx.stagingItem.findUnique({ where: { id } });
        if (!row) {
          // Unreachable: the claim above matched exactly this row in this tx.
          throw new AppError('Staging item not found', 'NOT_FOUND', 404);
        }
        updated = row;
      } else {
        // Annotation only — legal at any status, so deliberately unconditional.
        updated = await tx.stagingItem.update({
          where: { id },
          data: labelData,
        });
      }

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
          actionType: 'STAGING_UPDATE',
          entityType: 'STAGING',
          entityId: id,
          action: `Updated staging item #${id}`,
          changes,
        });
      }

      return updated;
    }),
  );

  const response = NextResponse.json(item);
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
