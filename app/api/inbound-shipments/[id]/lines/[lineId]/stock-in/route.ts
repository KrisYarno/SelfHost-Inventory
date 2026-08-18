import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { recordChange, newBatchId } from '@/lib/change-tracking';
import { StockInSchema } from '@/lib/validation/supply-orders';
import { getSupplyOrderDetail } from '@/lib/supply-orders/queries';
import { bookSupplyOrderBatch, withBookingRetry } from '@/lib/supply-orders/booking';
import { CeilingRefusal } from '@/lib/supply-orders/refusals';
import { costDiffersKey, labelingLossKey, pendingWithStockKey } from '@/lib/exceptions/kinds';
import { upsertException } from '@/lib/exceptions/write';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
    lineId: string;
  };
}

/**
 * The reason stored on an existing `labeling-loss` row, if it has one.
 *
 * `subject` is a JSON column, so a driver may hand it back parsed or as text; a
 * value that is not a usable string means "this row has nothing to preserve",
 * and the caller falls back to the primitive's own wording rather than writing
 * an empty reason over a real one.
 */
function storedReason(subject: Prisma.JsonValue | undefined): string | null {
  const value = typeof subject === 'string' ? safeParse(subject) : subject;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const reason = (value as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason.trim().length > 0 ? reason : null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * POST /api/inbound-shipments/[id]/lines/[lineId]/stock-in — BOOK ONE LABELED
 * BATCH (spec §4.3.3, pack C3b).
 *
 * The act IS the physical stock confirmation: somebody labelled N units and put
 * them somewhere. `bookSupplyOrderBatch` owns the locks, the ledger row, the
 * counters and the money; this route owns the envelope around it —
 *
 *   `withBookingRetry(() => prisma.$transaction(...))` (seam S13), with the
 *   batchId minted OUTSIDE the retry so a re-run after a deadlock or a losing
 *   race on the `bookingKey` UNIQUE never emits a second audit batch;
 *
 *   the THREE exception rows the primitive assembles and this route writes —
 *   `cost-differs` (the receipt disagreed with the catalog cost), `pending-with-
 *   stock` (units are on hand for an unapproved product), and the `labeling-loss`
 *   REFRESH (S20: the line already lost units at the bench, so their cumulative
 *   money moved when this batch landed);
 *
 *   the `STAGING_STOCK_IN` audit line.
 *
 * THE OPERATOR'S REASON SURVIVES (S25, pack amendment 3b). The primitive cannot
 * read the register — the write boundary is route-only — so the reason it puts
 * in the refresh subject is a SYSTEM string describing the re-pricing. Spec §6
 * says the row carries the LATEST OPERATOR reason, so the route reads the
 * existing row here (a plain read; the writer takes its own locking read
 * immediately after) and writes that reason back over the system one.
 *
 * A REPLAY writes nothing: the primitive returns the original batch before it
 * ever reaches `onRecord`, so there is no exception row and no audit event —
 * only the 200 the first attempt would have produced.
 *
 * This route IS an exception writer — allow-listed in
 * `__tests__/integration/exceptions-write-boundary.test.ts`.
 */
export const POST = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'supply-order-line-stock-in:POST', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const id = params.id;
  const lineId = parseInt(params.lineId, 10);
  if (isNaN(lineId)) {
    return NextResponse.json({ error: 'Invalid supply-order line ID' }, { status: 400 });
  }

  const body = StockInSchema.parse(await request.json());

  const batchId = newBatchId();

  let result;
  try {
    result = await withBookingRetry(() =>
      prisma.$transaction((tx) =>
        bookSupplyOrderBatch(
          tx,
          {
            lineId,
            shipmentId: id,
            bookingKey: body.bookingKey,
            quantity: body.quantity,
            locationId: body.locationId,
            note: body.note ?? null,
            actor: { id: user.id, isAdmin: user.isAdmin },
          },
          {
            batchId,
            onRecord: async (txn, ctx) => {
              if (ctx.costDiffers) {
                await upsertException(txn, {
                  kind: 'cost-differs',
                  key: costDiffersKey(lineId),
                  subject: { ...ctx.costDiffers },
                });
              }

              if (ctx.pendingWithStock) {
                await upsertException(txn, {
                  kind: 'pending-with-stock',
                  key: pendingWithStockKey(ctx.productId),
                  subject: { ...ctx.pendingWithStock },
                });
              }

              if (ctx.labelingLossRefresh) {
                const key = labelingLossKey(lineId);
                // The route never asks the writer WHETHER a row exists — the
                // primitive already decided that from the locked line's disposed
                // counter (PK2-11). This read exists only to carry the
                // operator's own words forward (S25).
                const existing = await txn.inventoryException.findUnique({ where: { key } });
                await upsertException(txn, {
                  kind: 'labeling-loss',
                  key,
                  subject: {
                    ...ctx.labelingLossRefresh,
                    reason:
                      storedReason(existing?.subject) ?? ctx.labelingLossRefresh.reason,
                  },
                });
              }

              await recordChange(txn, {
                actor: { userId: user.id },
                actionType: 'STAGING_STOCK_IN',
                entityType: 'STAGING',
                entityId: lineId,
                action: `Stocked ${ctx.quantity} labeled unit(s) from supply-order line ${lineId}`,
                batchId,
                details: {
                  shipmentId: id,
                  productId: ctx.productId,
                  approvalStatus: ctx.approvalStatus,
                  quantity: ctx.quantity,
                  locationId: ctx.locationId,
                  unitCostCents: ctx.unitCostCents,
                  receiptCostCents: ctx.receiptCostCents,
                  stockedAfter: ctx.stockedAfter,
                  disposed: ctx.disposed,
                  verified: ctx.verified,
                  remaining: ctx.remaining,
                  bookingKey: ctx.bookingKey,
                  note: ctx.note,
                  // WHICH batch this was on the line: the first one carries the
                  // cost decision and the basis freeze, later ones do not.
                  batch: ctx.firstBatch ? 'first' : 'subsequent',
                  fastPath: ctx.fastPath,
                  basisFrozen: ctx.basisFrozen,
                },
              });
            },
          },
        ),
      ),
    );
  } catch (error) {
    // The frozen CEILING envelope, mapped AFTER the retry wrapper (pack C3a.0).
    // The counters come off the LOCKED row, so they are the current truth rather
    // than the numbers the client was looking at.
    if (error instanceof CeilingRefusal) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          stocked: error.stocked,
          disposed: error.disposed,
          verified: error.verified,
          requested: error.requested,
        },
        { status: 409 },
      );
    }
    throw error;
  }

  const detail = await getSupplyOrderDetail(id);
  const line =
    detail && detail.model === 'supply-order'
      ? (detail.lines.find((row) => row.id === lineId) ?? null)
      : null;

  const response = NextResponse.json({ ...result, line });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
