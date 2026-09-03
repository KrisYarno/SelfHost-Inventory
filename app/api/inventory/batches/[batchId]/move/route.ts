import { NextRequest, NextResponse } from 'next/server';

import { apiHandler, requireApproved, requireCompanyMembership, requireCSRF } from '@/lib/api-utils';
import { newBatchId, recordChange } from '@/lib/change-tracking';
import { AppError } from '@/lib/error-handling';
import { STOCK_TX_OPTIONS, withDeadlockRetry } from '@/lib/inventory';
import { ORDER_GONE, withOrderLock } from '@/lib/inventory/order-lock';
import prisma from '@/lib/prisma';
import { moveBatch } from '@/lib/reconciliation/move-batch';
import { rowWhereSql } from '@/lib/reconciliation/population';
import { MANUAL_ATTRIBUTION_ROW_LIMIT, TooManyRowsRefusal, UnattributedRefusal } from '@/lib/reconciliation/refusals';
import { refusalResponse } from '@/lib/reconciliation/refusal-response';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';
import { BatchIdParamSchema, MoveBatchSchema } from '@/lib/validation/batches';
import { Prisma } from '@prisma/client';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    batchId: string;
  };
}

/** MySQL hands COUNT back as BigInt, which NextResponse.json cannot serialize. */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  return 0;
}

/**
 * ONE ROW BACK, whatever the batch's size (the reverse route's step 2, verbatim).
 * A `groupBy` by product is not bounded — a pre-0b-1 mass-update batch carries
 * thousands of one-product ADJUSTMENT rows the population predicate admits — so
 * the discovery that decides whether to lock anything is an aggregate, not a row
 * read.
 */
type DiscoveryRow = {
  rowCount: unknown;
  productCount: unknown;
  stampCount: unknown;
  firstStamp: string | null;
  actorRows: unknown;
  actorCount: unknown;
  firstActor: unknown;
};

/**
 * POST /api/inventory/batches/[batchId]/move — THE WRONG-LOCATION MOVE
 * (reconciliation Part 2, spec §2.6; pack CB2c.2).
 *
 * "The stock left location P, not the ledger's L." What this writes is a
 * TRANSFER pair per product — the physical location gives up the units, the
 * ledger location gets them back — under one new batch id, stamped like the
 * batch it reclassifies. The batch's own outbound rows are untouched and the
 * order stays attributed once: this is an accounting reclassification, not a
 * restoration (SETTLED 18a).
 *
 * THE SAME TEN STEPS AS THE REVERSE, deliberately. Discovery is one aggregate
 * row; the trust boundary runs BEFORE any refusal that could describe the batch;
 * the 50-row bound is absolute; a mixed batch locks no order and lets the
 * preamble answer from the locked rows; and ONE 404 sentence covers "no such
 * batch", "not a member" and "that stamp is advisory and you are not an admin".
 *
 * TWO THINGS THIS ROUTE HAS THAT THE REVERSE DOES NOT:
 *
 *   THE BODY. One field — where the stock physically went. The ledger end is
 *     read off the batch's own rows and is never sent by the client.
 *   THE LOCATION, PROVED TWICE (PK-11). Once before the transaction, because an
 *     unknown id would otherwise die inside the prelock's materialize INSERT as
 *     a foreign-key violation and reach the wire as a generic 500; and once more
 *     in the belt below, because an admin can delete an unused location in the
 *     window between the two.
 */
export const POST = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  // 1. THE GUARDS, in the frozen order, then the body.
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'batches:move', {
    identifier: user.id,
    limit: 30,
  });

  await requireCSRF(request);

  // A ledger batch id is a v4 uuid. A non-uuid — and a body that names no
  // location — render through `apiHandler`'s ZodError arm as the house 400;
  // there is no bespoke code for either, and one is not invented here.
  const batchId = BatchIdParamSchema.parse(params.batchId);
  const { physicalLocationId } = MoveBatchSchema.parse(await request.json());

  // 2. DISCOVERY — plain, OUTSIDE the transaction, ONE row. `COUNT(DISTINCT …)`
  //    and `MIN` ignore NULLs, so a stamped/unstamped mix reads `stampCount 1`
  //    and the core answers PARTIALLY_STAMPED rather than MIXED_STAMPS. The
  //    population predicate is rendered, never re-spelled.
  const discovery = await prisma.$queryRaw<DiscoveryRow[]>(Prisma.sql`
    SELECT COUNT(*) AS rowCount,
           COUNT(DISTINCT productId) AS productCount,
           COUNT(DISTINCT orderRecordId) AS stampCount,
           MIN(orderRecordId) AS firstStamp,
           COUNT(userId) AS actorRows,
           COUNT(DISTINCT userId) AS actorCount,
           MIN(userId) AS firstActor
      FROM inventory_logs l
     WHERE l.batchId = ${batchId} AND ${rowWhereSql('l')}
  `);

  const found = discovery[0];
  const rowCount = toNumber(found?.rowCount);
  const productCount = toNumber(found?.productCount);
  const stampCount = toNumber(found?.stampCount);
  // A STRING, never coerced: `firstStamp` is an order id.
  const discovered = found?.firstStamp ?? null;
  const actorRows = toNumber(found?.actorRows);
  const actorCount = toNumber(found?.actorCount);
  const firstActor = toNumber(found?.firstActor);

  // 3. NO POPULATION ROWS. The same sentence the membership guard throws, so a
  //    caller cannot tell "this batch does not exist" from "it is not yours".
  if (rowCount === 0) {
    throw new AppError('Resource not found', 'NOT_FOUND', 404);
  }

  /** The location, proved — one statement, the same shape in both places. */
  const locationExists = async (): Promise<boolean> =>
    (await prisma.location.findUnique({
      where: { id: physicalLocationId },
      select: { id: true },
    })) !== null;

  let result;
  try {
    // 4. AUTHORISATION, before ANY data-bearing refusal.
    let orderRow: { companyId: string } | null = null;
    if (discovered !== null) {
      orderRow = await prisma.externalOrder.findUnique({
        where: { id: discovered },
        select: { companyId: true },
      });
      if (orderRow) {
        await requireCompanyMembership(user.id, orderRow.companyId, user.isAdmin);
      } else if (!user.isAdmin) {
        // The advisory case: no company to check against, so an admin only —
        // and the same 404, because the alternative discloses the batch.
        throw new AppError('Resource not found', 'NOT_FOUND', 404);
      }
    } else if (
      !user.isAdmin &&
      !(actorCount === 1 && actorRows === rowCount && firstActor === user.id)
    ) {
      // The core's rung 2 stays the authority on the LOCKED rows; this is the
      // same question asked of the aggregate, before anything is locked.
      throw new UnattributedRefusal();
    }

    // 5. THE BOUND, off the aggregate — zero rows pulled. ABSOLUTE: admins and
    //    actors alike (moving a batch in parts is not a thing).
    if (rowCount > MANUAL_ATTRIBUTION_ROW_LIMIT) {
      throw new TooManyRowsRefusal(rowCount, productCount, MANUAL_ATTRIBUTION_ROW_LIMIT, 'move');
    }

    // 6. MIXED STAMPS: the route refuses NOTHING itself. It locks no order and
    //    lets the preamble's `MixedStampsRefusal` answer from the LOCKED rows —
    //    MIN/MAX cannot name N ids, and this route never fabricates a list. The
    //    bounded read is sound with no order lock: that transaction writes
    //    nothing and takes no further lock.

    // 7. WHAT GETS LOCKED, the batch this operation writes under, and THE
    //    DESTINATION, PROVED (the B1.5 F3 idiom). The prelock's materialize
    //    INSERT fires `fk_pl_location`, so an unknown id would die as MySQL 1452
    //    and take the whole transaction with it — reaching the wire as a generic
    //    500 rather than as the request error it is.
    const lockedOrderId = stampCount === 1 && orderRow !== null ? discovered : null;
    const operationBatchId = newBatchId();

    if (!(await locationExists())) {
      throw new AppError(`Location ${physicalLocationId} not found`, 'LOCATION_NOT_FOUND', 400);
    }

    // 8. ONE transaction: the order lock as statement 1, then the core.
    //    `withDeadlockRetry` retries the WHOLE transaction — the discovery sits
    //    outside it safely, because a stale `discovered` only ever produces
    //    BATCH_MOVED. The budget is the lane's (`STOCK_TX_OPTIONS`).
    //
    //    THE BELT (PK-11), SHAPE-AGNOSTIC. An admin can delete an unused
    //    location between the proof above and the prelock's INSERT, and the
    //    shape Prisma gives a `$executeRaw` foreign-key violation — P2010, a
    //    bare 1452, or no code at all — is pinned nowhere in this repo, so
    //    nothing here matches on one. On ANY throw the location is re-read after
    //    the rollback: absent, and the FK is what happened; present, and this
    //    was somebody's refusal, which is RETHROWN into the outer catch. The
    //    inner catch wraps the transaction and NOTHING ELSE, because every
    //    refusal extends `Error` rather than `AppError` — one catch that
    //    rethrew out of the route would turn SAME_LOCATION, ALREADY_MOVED and
    //    INSUFFICIENT_AT_SOURCE into generic 500s.
    try {
      result = await withDeadlockRetry(() =>
        withOrderLock(
          prisma,
          { required: lockedOrderId ? [lockedOrderId] : [] },
          (tx) =>
            moveBatch(
              tx,
              {
                batchId,
                physicalLocationId,
                discovered: { orderRecordId: discovered },
                actor: { userId: user.id, isAdmin: user.isAdmin },
                newBatchId: operationBatchId,
              },
              async (txn, ctx) => {
                const units = ctx.pairs.reduce((sum, pair) => sum + pair.units, 0);
                await recordChange(txn, {
                  actor: { userId: user.id },
                  actionType: 'INVENTORY_BATCH_MOVE',
                  entityType: 'INVENTORY',
                  // The ENTITY is the moved batch — the restoration ledger reads
                  // this event back by it — and the event's own batchId is the
                  // new one its TRANSFER rows carry.
                  entityId: ctx.movedBatchId,
                  batchId: ctx.batchId,
                  action:
                    `Moved batch ${ctx.movedBatchId}: ${units} units reclassified from ` +
                    `location ${ctx.ledgerLocationId} to ${ctx.physicalLocationId}`,
                  details: {
                    movedBatchId: ctx.movedBatchId,
                    ledgerLocationId: ctx.ledgerLocationId,
                    physicalLocationId: ctx.physicalLocationId,
                    pairs: ctx.pairs,
                    rows: ctx.rows,
                    orderRecordId: ctx.orderRecordId,
                  },
                  affectedCount: ctx.rows.length,
                  companyId: orderRow?.companyId,
                });
              },
            ),
          STOCK_TX_OPTIONS,
        ),
      );
    } catch (err) {
      if (!(await locationExists())) {
        throw new AppError(`Location ${physicalLocationId} not found`, 'LOCATION_NOT_FOUND', 400);
      }
      throw err;
    }
  } catch (err) {
    // 9. THE ORDER VANISHED between the membership read and the lock — the one
    //    path that reaches here (nothing is locked in the advisory case). Same
    //    404 sentence as everything else that must not be distinguishable.
    if (err instanceof AppError && err.code === ORDER_GONE) {
      throw new AppError('Resource not found', 'NOT_FOUND', 404);
    }
    // The ONE mapper. `isAdmin` decides whether BATCH_MOVED and MIXED_STAMPS
    // may name order ids — this route is reachable by approved non-admins.
    const refusal = refusalResponse(err, { isAdmin: user.isAdmin });
    if (refusal) {
      return refusal;
    }
    throw err;
  }

  // 10. THE ANSWER, in the numbers the event carries.
  const movedUnits = result.pairs.reduce((sum, pair) => sum + pair.units, 0);
  const response = NextResponse.json({
    movedBatchId: result.movedBatchId,
    batchId: result.batchId,
    orderRecordId: result.orderRecordId,
    ledgerLocationId: result.ledgerLocationId,
    physicalLocationId: result.physicalLocationId,
    pairs: result.pairs,
    rows: result.rows,
    message:
      `moved ${movedUnits} units from location ${result.ledgerLocationId} ` +
      `to ${result.physicalLocationId}`,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
