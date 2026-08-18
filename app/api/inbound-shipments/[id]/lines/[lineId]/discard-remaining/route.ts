import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, apiHandler, requireCSRF } from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { recordChange, newBatchId } from '@/lib/change-tracking';
import { DiscardRemainingSchema } from '@/lib/validation/supply-orders';
import { getSupplyOrderDetail } from '@/lib/supply-orders/queries';
import { discardRemaining } from '@/lib/supply-orders/booking';
import { labelingLossKey } from '@/lib/exceptions/kinds';
import { upsertException } from '@/lib/exceptions/write';
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
 * POST /api/inbound-shipments/[id]/lines/[lineId]/discard-remaining — WRITE OFF
 * WHAT NEVER MADE IT INTO STOCK (spec §4.3.5, pack C3b).
 *
 * Units that were verified at the dock and then lost at the labeling bench:
 * dropped, mislabelled, broken. NEVER a stock movement — nothing touches the
 * ledger, the locations or the product, because these units were never stock.
 * (A loss AFTER stocking is an inventory ADJUSTMENT with `reasonCode DAMAGE`, on
 * the existing surface. That boundary is the spec's, and it is why this route
 * writes an exception row and an audit line and nothing else.)
 *
 * THE REASON IS THE OPERATOR'S. `discardRemaining` carries it through into the
 * subject it assembles, and this route writes that subject as given: the
 * `labeling-loss:<lineId>` row is CUMULATIVE (one row per line, refreshed), and
 * spec §6 says its `reason` is the LATEST one a person gave. A later stock-in on
 * the same line re-prices the row and deliberately preserves this string (S25).
 *
 * Idempotent by construction: a second call finds nothing remaining and refuses
 * 409 `NOT_BOOKABLE` rather than writing a second, invented loss.
 *
 * This route IS an exception writer — allow-listed in
 * `__tests__/integration/exceptions-write-boundary.test.ts`.
 */
export const POST = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'supply-order-line-discard-remaining:POST', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const id = params.id;
  const lineId = parseInt(params.lineId, 10);
  if (isNaN(lineId)) {
    return NextResponse.json({ error: 'Invalid supply-order line ID' }, { status: 400 });
  }

  const body = DiscardRemainingSchema.parse(await request.json());

  const batchId = newBatchId();

  const result = await withDeadlockRetry(() =>
    prisma.$transaction((tx) =>
      discardRemaining(
        tx,
        {
          lineId,
          shipmentId: id,
          reason: body.reason,
          actor: { id: user.id, isAdmin: user.isAdmin },
        },
        {
          batchId,
          onRecord: async (txn, ctx) => {
            await upsertException(txn, {
              kind: 'labeling-loss',
              key: labelingLossKey(lineId),
              subject: {
                ...ctx.labelingLoss,
                // Stated rather than inherited: the OPERATOR'S words are what
                // spec §6 stores, and this route is where they enter the row.
                reason: body.reason,
              },
            });

            await recordChange(txn, {
              actor: { userId: user.id },
              actionType: 'STAGING_DISCARD',
              entityType: 'STAGING',
              entityId: lineId,
              action: `Discarded the remaining ${ctx.discarded} unit(s) on supply-order line ${lineId}`,
              batchId,
              details: {
                shipmentId: id,
                productId: ctx.productId,
                reason: body.reason,
                discarded: ctx.discarded,
                disposedAfter: ctx.disposedAfter,
                stockedQuantity: ctx.stockedQuantity,
                verified: ctx.verified,
                remaining: ctx.remaining,
                unitCostCents: ctx.unitCostCents,
                lossCents: ctx.lossCents,
              },
            });
          },
        },
      ),
    ),
  );

  const detail = await getSupplyOrderDetail(id);
  const line =
    detail && detail.model === 'supply-order'
      ? (detail.lines.find((row) => row.id === lineId) ?? null)
      : null;

  const response = NextResponse.json({ ...result, line });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
