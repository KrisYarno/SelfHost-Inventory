import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import { AppError } from '@/lib/error-handling';
import prisma from '@/lib/prisma';
import { Prisma, StagingItemStatus } from '@prisma/client';
import { recordChange, newBatchId, type ChangeDiff } from '@/lib/change-tracking';
import {
  PatchLineSchema,
  assertLinePatchNotEmpty,
  assertProductCreateOmitsCostPrice,
  assertProductSizePair,
} from '@/lib/validation/supply-orders';
import { getSupplyOrderDetail } from '@/lib/supply-orders/queries';
import { resolveSupplyOrderProduct } from '@/lib/supply-orders/product-resolve';
import { VerifiedLockedRefusal } from '@/lib/supply-orders/refusals';
import { withDeadlockRetry } from '@/lib/inventory';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
    lineId: string;
  };
}

/** The line columns this route decides from, read under the line's own lock. */
type LockedLine = {
  id: number;
  status: StagingItemStatus;
  description: string;
  orderedProductId: number | null;
  resolvedProductId: number | null;
  orderedQuantity: number | null;
  lineTotalCents: number | null;
  labelingRequired: boolean;
  notes: string | null;
  stockedQuantity: number;
  disposedQuantity: number;
};

/**
 * THE LINE, LOCKED (the lane's uniform first step: line -> header).
 *
 * A plain `findUnique` answers from this transaction's REPEATABLE READ snapshot,
 * so a verify or a booking that committed since would be invisible and this
 * PATCH would decide — and diff — against numbers that were already wrong.
 * `SELECT ... FOR UPDATE` reads the latest committed row and holds it.
 *
 * `shipmentId` is in the WHERE, not merely in a later check: the question is not
 * "does this line exist" but "is this line still one of THIS order's", and a
 * line addressed through another order's URL is a 404, never an edit.
 */
async function lockedLine(
  tx: Prisma.TransactionClient,
  shipmentId: string,
  lineId: number,
): Promise<LockedLine | null> {
  const rows = await tx.$queryRaw<LockedLine[]>(
    Prisma.sql`SELECT id, status, description, orderedProductId, resolvedProductId, orderedQuantity, lineTotalCents, labelingRequired, notes, stockedQuantity, disposedQuantity FROM staging_items WHERE id = ${lineId} AND shipmentId = ${shipmentId} FOR UPDATE`,
  );
  return rows[0] ?? null;
}

/** The diff over exactly the fields this PATCH wrote (ER-B9: from===to drops). */
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

/**
 * PATCH /api/inbound-shipments/[id]/lines/[lineId] — edit ONE line (spec §4.1.4).
 *
 * The line's STATUS says what may still be edited, and the two branches are
 * different in kind:
 *
 *   ORDERED    the order has not been delivered against, so everything the order
 *              form collected is still an editable statement about the order:
 *              the product (through the resolver — the description is
 *              RE-SNAPSHOTTED to the name it returns), the units, the total, the
 *              labeling flag and the notes.
 *   VERIFIED   with NOTHING stocked and NOTHING disposed: only the notes and the
 *              labeling flag. The counted quantity is verify's to move (that is
 *              an event, not a field), and the delivered product is verify's
 *              `deliveredProduct` re-map — this route must never be the quiet
 *              way to rewrite what a delivery said.
 *
 * Anything else is 409, and a line that has already booked or disposed units
 * answers the frozen `VERIFIED_LOCKED` envelope naming both counters — the
 * client can then say what is actually true rather than "conflict".
 */
export const PATCH = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'supply-order-line:PATCH', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const id = params.id;
  const lineId = parseInt(params.lineId, 10);
  if (isNaN(lineId)) {
    return NextResponse.json({ error: 'Invalid supply-order line ID' }, { status: 400 });
  }

  const raw = await request.json();
  assertProductCreateOmitsCostPrice(
    (raw as { product?: { productFields?: unknown } })?.product?.productFields,
  );

  const body = PatchLineSchema.parse(raw);
  assertLinePatchNotEmpty(body);
  if (body.product?.mode === 'new') assertProductSizePair(body.product.productFields);

  const actor = { id: user.id, isAdmin: user.isAdmin };
  const batchId = newBatchId();

  try {
    await withDeadlockRetry(() =>
      prisma.$transaction(async (tx): Promise<void> => {
        const line = await lockedLine(tx, id, lineId);
        if (!line) {
          throw new AppError('Supply-order line not found', 'NOT_FOUND', 404);
        }

        const booked = line.stockedQuantity > 0 || line.disposedQuantity > 0;
        if (booked) {
          throw new VerifiedLockedRefusal(line.stockedQuantity, line.disposedQuantity);
        }

        const orderedLine = line.status === StagingItemStatus.ORDERED;
        const verifiedLine = line.status === StagingItemStatus.VERIFIED;
        if (!orderedLine && !verifiedLine) {
          throw new AppError(
            `Supply-order line ${lineId} is ${line.status.toLowerCase()} and can no longer be edited here`,
            'CONFLICT',
            409,
          );
        }
        if (
          verifiedLine &&
          (body.product !== undefined ||
            body.orderedQuantity !== undefined ||
            body.lineTotalCents !== undefined)
        ) {
          throw new AppError(
            `Supply-order line ${lineId} is verified — only its notes and labeling flag are still editable (the delivered product and the counted quantity are the verify route's)`,
            'CONFLICT',
            409,
          );
        }

        const data: Prisma.StagingItemUncheckedUpdateInput = {};
        const after: Record<string, unknown> = {};

        if (body.product !== undefined) {
          const product = await resolveSupplyOrderProduct(tx, body.product, actor);
          // Both ids move: nothing has been delivered against an ORDERED line, so
          // correcting its product corrects WHAT WAS ORDERED, and the description
          // is re-snapshotted in the SAME guarded write.
          data.orderedProductId = product.productId;
          data.resolvedProductId = product.productId;
          data.description = product.productName;
          after.orderedProductId = product.productId;
          after.resolvedProductId = product.productId;
          after.description = product.productName;
        }
        if (body.orderedQuantity !== undefined) {
          data.orderedQuantity = body.orderedQuantity;
          after.orderedQuantity = body.orderedQuantity;
        }
        if (body.lineTotalCents !== undefined) {
          data.lineTotalCents = body.lineTotalCents;
          after.lineTotalCents = body.lineTotalCents;
        }
        if (body.labelingRequired !== undefined) {
          data.labelingRequired = body.labelingRequired;
          after.labelingRequired = body.labelingRequired;
        }
        if (body.notes !== undefined) {
          data.notes = body.notes;
          after.notes = body.notes;
        }

        // THE CLAIM carries the whole precondition: the line is still this
        // order's, still in the status this request was decided under, and (on
        // the verified branch) still untouched by any booking.
        const claim = await tx.stagingItem.updateMany({
          where: orderedLine
            ? { id: lineId, shipmentId: id, status: StagingItemStatus.ORDERED }
            : {
                id: lineId,
                shipmentId: id,
                status: StagingItemStatus.VERIFIED,
                stockedQuantity: 0,
                disposedQuantity: 0,
              },
          data,
        });
        if (claim.count !== 1) {
          throw new AppError(
            `Supply-order line ${lineId} changed state while it was being edited; reload and retry`,
            'CONFLICT',
            409,
          );
        }

        const changes = fieldChanges(line, after);
        if (Object.keys(changes).length > 0) {
          await recordChange(tx, {
            actor: { userId: user.id },
            actionType: 'STAGING_UPDATE',
            entityType: 'STAGING',
            entityId: lineId,
            action: `Updated supply-order line ${lineId}`,
            batchId,
            changes,
            details: { shipmentId: id },
          });
        }
      }),
    );
  } catch (error) {
    if (error instanceof VerifiedLockedRefusal) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          stocked: error.stocked,
          disposed: error.disposed,
        },
        { status: 409 },
      );
    }
    throw error;
  }

  const detail = await getSupplyOrderDetail(id);
  const view =
    detail && detail.model === 'supply-order'
      ? (detail.lines.find((line) => line.id === lineId) ?? null)
      : null;

  const response = NextResponse.json(view);
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
