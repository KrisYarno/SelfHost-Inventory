import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import { AppError } from '@/lib/error-handling';
import prisma from '@/lib/prisma';
import { recordChange, newBatchId } from '@/lib/change-tracking';
import {
  VerifyLineSchema,
  assertProductCreateOmitsCostPrice,
  assertProductSizePair,
} from '@/lib/validation/supply-orders';
import { getSupplyOrderDetail } from '@/lib/supply-orders/queries';
import { verifyLine, type VerifyRecordContext } from '@/lib/supply-orders/verify';
import { VerifiedLockedRefusal } from '@/lib/supply-orders/refusals';
import { recvDiscrepancyKey } from '@/lib/exceptions/kinds';
import { upsertException, resolveException } from '@/lib/exceptions/write';
import { withDeadlockRetry } from '@/lib/inventory';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
    lineId: string;
  };
}

/**
 * The product a re-map landed on, for the `PRODUCT_CREATE` audit line.
 *
 * `VerifyRecordContext` carries `productCreated` but no product id of its own
 * (pack C2c.1), so the id is taken from the two places the core DOES publish it:
 * the remap (`productRemapped.to`) and the discrepancy subject's `productId`,
 * which is the resolved product by construction. A creation the route cannot
 * NAME is an invariant break, not something to audit vaguely — the throw aborts
 * the verify rather than writing a product event pointing at nothing.
 */
function createdProductId(ctx: VerifyRecordContext): number {
  const fromRemap = ctx.productRemapped?.to ?? null;
  const fromSubject =
    ctx.recvDiscrepancy === null
      ? null
      : ctx.recvDiscrepancy.action === 'upsert'
        ? ctx.recvDiscrepancy.subject.productId
        : ctx.recvDiscrepancy.subjectPatch.productId;
  const productId = fromRemap ?? fromSubject;
  if (productId === null || productId === undefined) {
    throw new AppError(
      `Supply-order line ${ctx.lineId} created a product the verify context does not name`,
      'INVARIANT',
      500,
    );
  }
  return productId;
}

/**
 * POST /api/inbound-shipments/[id]/lines/[lineId]/verify — RECORD THE DELIVERED
 * COUNT (spec §4.2, pack C3b).
 *
 * One act with three shapes, all decided inside the core from the LOCKED row:
 * the FIRST count on an ordered line, a RAISE when box 2 turns up later, a LOWER
 * when the first count was wrong. The route owns everything around it:
 *
 *   the transaction   `withDeadlockRetry(() => prisma.$transaction(...))`, with
 *                     the batchId minted OUTSIDE the retry so a re-run after a
 *                     deadlock stays ONE batch in the change feed;
 *   the writes        the core assembles the `recv-discrepancy` INTENT and this
 *                     route executes it — an upsert while the count misses the
 *                     order, a resolution when it lands back on it (spec §6:
 *                     every resolution refreshes the row's money, which is what
 *                     the intent's `subjectPatch` carries);
 *   the audit         `STAGING_VERIFY` against the LINE, carrying both counts,
 *                     the delta, the money and what kind of act this was.
 *
 * ORDER INSIDE `onRecord` (the M3a fan-out idiom): product event, then the
 * exception row, then the line event. Everything runs in the core's transaction
 * with its locks still held, so a writer failure takes the count with it.
 *
 * This route IS an exception writer — allow-listed in
 * `__tests__/integration/exceptions-write-boundary.test.ts`.
 */
export const POST = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'supply-order-line-verify:POST', {
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
    (raw as { deliveredProduct?: { productFields?: unknown } })?.deliveredProduct?.productFields,
  );

  const body = VerifyLineSchema.parse(raw);
  if (body.deliveredProduct?.mode === 'new') {
    assertProductSizePair(body.deliveredProduct.productFields);
  }

  const batchId = newBatchId();

  let result;
  try {
    result = await withDeadlockRetry(() =>
      prisma.$transaction((tx) =>
        verifyLine(
          tx,
          {
            lineId,
            shipmentId: id,
            verifiedQuantity: body.verifiedQuantity,
            note: body.note ?? null,
            labelingRequired: body.labelingRequired,
            deliveredProduct: body.deliveredProduct,
            actor: { id: user.id, isAdmin: user.isAdmin },
          },
          {
            batchId,
            onRecord: async (txn, ctx) => {
              if (ctx.productCreated) {
                const productId = createdProductId(ctx);
                await recordChange(txn, {
                  actor: { userId: user.id },
                  actionType: 'PRODUCT_CREATE',
                  entityType: 'PRODUCT',
                  entityId: productId,
                  action: `Created product ${productId} while verifying supply-order line ${lineId}`,
                  batchId,
                  details: {
                    shipmentId: id,
                    lineId,
                    productName: ctx.productRemapped?.productName ?? null,
                  },
                });
              }

              // THE INTENT, EXECUTED. The core decided WHICH act this is from
              // the locked counters; the route only knows how to write it.
              if (ctx.recvDiscrepancy?.action === 'upsert') {
                await upsertException(txn, {
                  kind: 'recv-discrepancy',
                  key: recvDiscrepancyKey(lineId),
                  subject: { ...ctx.recvDiscrepancy.subject },
                });
              } else if (ctx.recvDiscrepancy?.action === 'resolve') {
                await resolveException(txn, {
                  key: recvDiscrepancyKey(lineId),
                  resolvedBy: user.id,
                  resolution: ctx.recvDiscrepancy.resolution,
                  // Every resolution refreshes the money (spec §6) — the patch
                  // is recomputed from the counters being written, never the
                  // stale figures the row was raised with.
                  subjectPatch: { ...ctx.recvDiscrepancy.subjectPatch },
                });
              }

              await recordChange(txn, {
                actor: { userId: user.id },
                actionType: 'STAGING_VERIFY',
                entityType: 'STAGING',
                entityId: lineId,
                action: `Verified ${ctx.verified} unit(s) on supply-order line ${lineId}`,
                batchId,
                details: {
                  shipmentId: id,
                  kind: ctx.kind,
                  previous: ctx.previousVerified,
                  ordered: ctx.ordered,
                  verified: ctx.verified,
                  delta: ctx.delta,
                  lossCents: ctx.lossCents,
                  surplusValueCents: ctx.surplusValueCents,
                  unitCostCents: ctx.unitCostCents,
                  note: ctx.note,
                  headerPromoted: ctx.headerPromoted,
                  productRemapped: ctx.productRemapped,
                },
              });
            },
          },
        ),
      ),
    );
  } catch (error) {
    // The STRUCTURED refusal, mapped AFTER the retry wrapper (pack C3a.0): an
    // `AppError` renders as `{ error, code }` only, and a count that is locked
    // has to NAME what the ledger already booked.
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
  const line =
    detail && detail.model === 'supply-order'
      ? (detail.lines.find((row) => row.id === lineId) ?? null)
      : null;

  const response = NextResponse.json({ ...result, line });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
