import { NextRequest, NextResponse } from 'next/server';

import { apiHandler, requireApproved, requireCompanyMembership, requireCSRF } from '@/lib/api-utils';
import { newBatchId, recordChange } from '@/lib/change-tracking';
import { AppError } from '@/lib/error-handling';
import { STOCK_TX_OPTIONS, withDeadlockRetry } from '@/lib/inventory';
import { ORDER_GONE, withOrderLock } from '@/lib/inventory/order-lock';
import prisma from '@/lib/prisma';
import { rowWhereSql } from '@/lib/reconciliation/population';
import { MANUAL_ATTRIBUTION_ROW_LIMIT, TooManyRowsRefusal, UnattributedRefusal } from '@/lib/reconciliation/refusals';
import { refusalResponse } from '@/lib/reconciliation/refusal-response';
import { reverseBatch } from '@/lib/reconciliation/reverse-batch';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';
import { BatchIdParamSchema } from '@/lib/validation/batches';
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
 * ONE ROW BACK, whatever the batch's size (pack CB2b.2 step 2). A `groupBy` by
 * product is not bounded — a pre-0b-1 mass-update batch carries thousands of
 * one-product ADJUSTMENT rows the population predicate admits — so the discovery
 * that decides whether to lock anything is an aggregate, not a row read.
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
 * POST /api/inventory/batches/[batchId]/reverse — THE ATOMIC REVERSE
 * (reconciliation Part 2, spec §2.5; pack CB2b.2).
 *
 * "Put this batch back." The workbench Undo's manual leg is one call to this
 * route, and the drill-down offers the same act to an admin looking at the
 * report. What it writes is CORRECTION rows for the REMAINDER, per key, under
 * one new batch id, stamped like the batch they reverse — and ONE audit event
 * whose entity is the reversed batch.
 *
 * NOT ADMIN-ONLY, deliberately (spec REV-9 CX6-20). An approved operator undoes
 * their own completion, which is the whole point of the toast; the trust
 * boundary is enforced HERE, in step 4, before any refusal that could describe
 * the batch:
 *
 *   STAMPED, and the order exists → per-company membership decides (a miss is
 *     the house 404, so a non-member cannot enumerate batches).
 *   STAMPED, and the order is GONE → the stamp is ADVISORY (spec §2.7(1)): no
 *     membership can be derived from it, so the act is open to an admin OR the
 *     batch's PROVABLE ACTOR (F11 — every row this batch's own, all carrying
 *     this user's id), nothing is locked, and the CORRECTION rows still carry
 *     the soft reference.
 *   UNSTAMPED → the batch's own rows name their actor: that person, or an admin.
 *
 * ONE 404 SENTENCE covers "no such batch", "not a member" and "an advisory stamp
 * on a batch you cannot prove is yours" — three different facts an outsider must
 * not be able to tell apart.
 *
 * THE ROUTE IS NOT A DECISION SITE (spec REV-14). It discovers, authorises,
 * bounds, locks and records; the ladder lives in the core, and the exception
 * raise an Undo might one day file is C2a's.
 */
export const POST = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  // 1. THE GUARDS, in the frozen order. No body is parsed — a reverse takes none.
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, 'batches:reverse', {
    identifier: user.id,
    limit: 30,
  });

  await requireCSRF(request);

  // A ledger batch id is a v4 uuid. A non-uuid renders through `apiHandler`'s
  // ZodError arm as the house 400 — there is no bespoke code for it, and one is
  // not invented here.
  const batchId = BatchIdParamSchema.parse(params.batchId);

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

  // THE PROVABLE ACTOR, off the aggregate: every population row carries an
  // actor, they are all the same person, and that person is the caller. Read
  // once — the unstamped arm and the advisory arm ask the same question.
  const provableActor = actorCount === 1 && actorRows === rowCount && firstActor === user.id;

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
      } else if (!user.isAdmin && !provableActor) {
        // The ADVISORY case (F11/GX-3): the stamp names an order a sync deleted,
        // so no membership can be derived — but the actor columns prove the same
        // thing here that they prove for an unstamped batch (CX6-20). An admin
        // or the person who recorded every row may act; anyone else gets the
        // same 404, because the alternative discloses the batch.
        throw new AppError('Resource not found', 'NOT_FOUND', 404);
      }
    } else if (!user.isAdmin && !provableActor) {
      // The core's rung 2 stays the authority on the LOCKED rows; this is the
      // same question asked of the aggregate, before anything is locked.
      throw new UnattributedRefusal();
    }

    // 5. THE BOUND, off the aggregate — zero rows pulled. ABSOLUTE: admins and
    //    actors alike (a reverse in parts is registered, not built).
    if (rowCount > MANUAL_ATTRIBUTION_ROW_LIMIT) {
      throw new TooManyRowsRefusal(rowCount, productCount, MANUAL_ATTRIBUTION_ROW_LIMIT, 'reverse');
    }

    // 6. MIXED STAMPS: the route refuses NOTHING itself. It locks no order and
    //    lets the preamble's `MixedStampsRefusal` answer from the LOCKED rows —
    //    MIN/MAX cannot name N ids, and this route never fabricates a list. The
    //    bounded read is sound with no order lock: that transaction writes
    //    nothing and takes no further lock.

    // 7. WHAT GETS LOCKED, and the batch this operation writes under.
    const lockedOrderId = stampCount === 1 && orderRow !== null ? discovered : null;
    const operationBatchId = newBatchId();

    // 8. ONE transaction: the order lock as statement 1, then the core.
    //    `withDeadlockRetry` retries the WHOLE transaction — the discovery sits
    //    outside it safely, because a stale `discovered` only ever produces
    //    BATCH_MOVED. The budget is the lane's (`STOCK_TX_OPTIONS`): a 50-key
    //    reverse runs a prelock plus, per key, a ledger create with a three-table
    //    include, an upsert and the audit create — far past Prisma's 5 s default.
    result = await withDeadlockRetry(() =>
      withOrderLock(
        prisma,
        { required: lockedOrderId ? [lockedOrderId] : [] },
        (tx) =>
          reverseBatch(
            tx,
            {
              batchId,
              discovered: { orderRecordId: discovered },
              actor: { userId: user.id, isAdmin: user.isAdmin },
              newBatchId: operationBatchId,
            },
            async (txn, ctx) => {
              const earlier =
                ctx.previouslyRestored > 0 ? ` (${ctx.previouslyRestored} restored earlier)` : '';
              await recordChange(txn, {
                actor: { userId: user.id },
                actionType: 'INVENTORY_BATCH_REVERSE',
                entityType: 'INVENTORY',
                // I-R5: the ENTITY is the reversed batch, the event's own
                // batchId is the new one — both halves, so the drawer reaches it.
                entityId: ctx.reversedBatchId,
                batchId: ctx.batchId,
                action:
                  `Reversed batch ${ctx.reversedBatchId}: restored ${ctx.restoredUnits} of ` +
                  `${ctx.totalUnits} units${earlier}`,
                details: {
                  reversedBatchId: ctx.reversedBatchId,
                  rows: ctx.rows,
                  restoredUnits: ctx.restoredUnits,
                  previouslyRestored: ctx.previouslyRestored,
                  totalUnits: ctx.totalUnits,
                  orderRecordId: ctx.orderRecordId,
                  physicalLocationId: ctx.physicalLocationId,
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
  const earlier =
    result.previouslyRestored > 0 ? ` (${result.previouslyRestored} restored earlier)` : '';
  const response = NextResponse.json({
    reversedBatchId: result.reversedBatchId,
    batchId: result.batchId,
    orderRecordId: result.orderRecordId,
    rows: result.rows,
    restoredUnits: result.restoredUnits,
    previouslyRestored: result.previouslyRestored,
    totalUnits: result.totalUnits,
    physicalLocationId: result.physicalLocationId,
    message: `reversed ${result.restoredUnits} of ${result.totalUnits} units${earlier}`,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
