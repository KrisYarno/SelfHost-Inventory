import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { apiHandler, requireAdmin, requireCSRF } from '@/lib/api-utils';
import { AppError } from '@/lib/error-handling';
import prisma from '@/lib/prisma';
import { newBatchId, recordChange } from '@/lib/change-tracking';
import { withDeadlockRetry } from '@/lib/inventory';
import { applyRateLimitHeaders, enforceRateLimit } from '@/lib/rateLimit';
import { recordAttributionAttempt } from '@/lib/attribution/attempts';
import { getBatchDetail } from '@/lib/reconciliation/attribution';
import { attributeBatch } from '@/lib/reconciliation/attribute-batch';
import {
  BatchMovedRefusal,
  FulfilledBatchRefusal,
  MixedStampsRefusal,
  NotAttributableRefusal,
  PartiallyStampedRefusal,
  R2bOtherTargetRefusal,
  TooManyRowsRefusal,
} from '@/lib/reconciliation/refusals';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    batchId: string;
  };
}

/**
 * GET /api/reconciliation/attribution/[batchId] — the drill-down (pack C2a.5;
 * spec REV-7 §4.2 / §5).
 *
 * The batch's ledger rows, the audit event that wrote them (labelled: it carries
 * the operator's own free text), every attempt ever recorded against it, the
 * manual attributions, and the derivation when that is what classified it.
 *
 * 404 `{ error: 'unknown batch', code: 'NOT_FOUND' }` when the id names no
 * POPULATION rows — a batch of transfers or counts is not "hidden", it is simply
 * not something this report speaks about, and the same answer covers a batch id
 * that never existed.
 *
 * The manual attribution's POST sits below, on the same path: the drill-down is
 * what an admin reads before deciding, and the correction is what they do next.
 */
export const GET = apiHandler(async (_request: NextRequest, { params }: RouteParams) => {
  await requireAdmin();

  const detail = await getBatchDetail(params.batchId, { kind: 'admin' });
  if (!detail) {
    return NextResponse.json({ error: 'unknown batch', code: 'NOT_FOUND' }, { status: 404 });
  }

  return NextResponse.json(detail);
});

/**
 * The body of a manual attribution (pack C2b.3).
 *
 * `expectPreviousOrderRecordId` is REQUIRED and nullable — the house
 * stale-client guard, the same idiom as verify's `expectPrevious`. `null` is a
 * STATEMENT ("I am looking at an unattributed batch"), which is why an omitted
 * field is a 400 rather than a default: a client that forgets to send what it
 * saw must not be allowed to overwrite whatever it finds.
 */
const AttributeSchema = z.object({
  orderRecordId: z.string().min(1),
  expectPreviousOrderRecordId: z.string().min(1).nullable(),
  reason: z.string().trim().max(500).optional(),
});

/**
 * The frozen 409 envelopes (pack C2b.1). Assembled HERE, from the refusal's own
 * fields, because `apiHandler` renders an `AppError` as `{ error, code }` and
 * every one of these has something further to name.
 */
function refusalResponse(err: unknown): NextResponse | null {
  if (err instanceof NotAttributableRefusal) {
    return NextResponse.json(
      { error: err.message, code: err.code, batchId: err.batchId },
      { status: 409 },
    );
  }
  if (err instanceof TooManyRowsRefusal) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        rowCount: err.rowCount,
        productCount: err.productCount,
        limit: err.limit,
      },
      { status: 409 },
    );
  }
  if (err instanceof MixedStampsRefusal) {
    return NextResponse.json(
      { error: err.message, code: err.code, orderRecordIds: err.orderRecordIds },
      { status: 409 },
    );
  }
  if (err instanceof BatchMovedRefusal) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        currentOrderRecordId: err.currentOrderRecordId,
        expected: err.expected,
      },
      { status: 409 },
    );
  }
  if (err instanceof PartiallyStampedRefusal) {
    return NextResponse.json(
      { error: err.message, code: err.code, stamped: err.stamped, unstamped: err.unstamped },
      { status: 409 },
    );
  }
  if (err instanceof FulfilledBatchRefusal) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        orderRecordId: err.orderRecordId,
        orderNumber: err.orderNumber,
      },
      { status: 409 },
    );
  }
  if (err instanceof R2bOtherTargetRefusal) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        fulfillmentOrderRecordId: err.fulfillmentOrderRecordId,
      },
      { status: 409 },
    );
  }
  return null;
}

/**
 * POST /api/reconciliation/attribution/[batchId] — MANUAL ATTRIBUTION (spec
 * REV-7 D4; pack C2b.3).
 *
 * "That batch belongs to order #1009." The route is admin-only, CSRF-guarded and
 * rate-limited, and everything it changes happens inside ONE transaction:
 *
 *   1. LOCK THE TARGET ORDER `FOR SHARE`, first, inside the transaction. The
 *      order id is a SOFT reference with no foreign key, so a webhook or an
 *      integration sync can delete it between a pre-flight check and the COMMIT
 *      — and the batch would end up stamped with an order that no longer exists.
 *      The lock order is frozen: external_orders target, then inventory_logs
 *      batch (CX-5). The two-column projection is D6's writer-only exception.
 *      The id it READS BACK is the canonical one, and it is what the rest of this
 *      handler uses — never the caller's spelling (CR-2, below).
 *   2. RUN THE CORE, which owns the eligibility ladder and the guarded write.
 *   3. RECORD, inside `onRecord`: the attempt row (attributed / manual) and the
 *      `INVENTORY_ATTRIBUTE` audit event. The audit event carries a NEWLY MINTED
 *      batchId — the house rule that every request mints its own — while its
 *      ENTITY is the ledger batchId from the path. That distinction is load
 *      bearing: the derivation reads "the audit event" of a ledger batch as the
 *      earliest row under the ledger's OWN batchId, so an attribution event must
 *      never file itself there or it would re-classify the deduction (G1p-8).
 *
 * The refusals are rendered after the retry wrapper, so a deadlock retry sees the
 * exception first and a refusal is never mistaken for a transient failure.
 *
 * This route is the FIFTH allow-listed importer of the attempt writer
 * (`__tests__/integration/attempts-write-boundary.test.ts`).
 */
export const POST = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireAdmin();

  const rateLimitHeaders = enforceRateLimit(request, 'reconciliation-attribute:POST', {
    identifier: user.id,
    limit: 30,
  });

  await requireCSRF(request);

  const body = AttributeSchema.parse(await request.json());
  const batchId = params.batchId;
  const reason = body.reason?.trim() ? body.reason.trim() : null;

  // The AUDIT batch id, minted by the route — never the ledger's (see above).
  const auditBatchId = newBatchId();

  let result;
  try {
    result = await withDeadlockRetry(() =>
      prisma.$transaction(async (tx) => {
        const [order] = await tx.$queryRaw<Array<{ id: string; orderNumber: string }>>(
          Prisma.sql`SELECT id, orderNumber FROM external_orders WHERE id = ${body.orderRecordId} FOR SHARE`,
        );
        if (!order) {
          throw new AppError('unknown order', 'NOT_FOUND', 404);
        }

        // THE CANONICAL ID IS THE ONE THE LOCK READ BACK (CR-2). `external_orders.id`
        // is `utf8mb4_unicode_ci`, so the lookup above matches case-INSENSITIVELY:
        // `ORD-A` finds the row stored as `ord-a`. Everything downstream of this
        // point is JavaScript string identity — the report's order map, the core's
        // stamp `Set`, the same-id short circuit, the R2b target comparison — so
        // carrying the caller's spelling stamped the ledger with an id no later
        // read could match, and the next report said "order missing" about an
        // order that is right there. The lock is still ASKED with what the caller
        // typed (the collation is what resolves it); it is the ANSWER that travels.
        const orderRecordId = order.id;

        return attributeBatch(
          tx,
          {
            batchId,
            orderRecordId,
            expectPreviousOrderRecordId: body.expectPreviousOrderRecordId,
            reason,
            actorUserId: user.id,
          },
          async (txn, ctx) => {
            await recordAttributionAttempt(txn, {
              batchId,
              ledgerRowId: ctx.firstRowId,
              outcome: 'attributed',
              evidence: 'manual',
              source: 'manual',
              actorUserId: user.id,
              orderRecordId,
              previousOrderRecordId: ctx.previousOrderRecordId,
              details: {
                rowCount: ctx.rowCount,
                ...(reason ? { overwriteReason: reason } : {}),
                ...(ctx.completedFulfillment ? { completedFulfillment: true } : {}),
              },
            });

            await recordChange(txn, {
              actor: { userId: user.id },
              actionType: 'INVENTORY_ATTRIBUTE',
              entityType: 'INVENTORY',
              entityId: batchId,
              action: `Attributed outbound batch ${batchId} to order ${order.orderNumber}`,
              details: {
                orderRecordId,
                previousOrderRecordId: ctx.previousOrderRecordId,
                reason,
                rowCount: ctx.rowCount,
              },
              batchId: auditBatchId,
              affectedCount: ctx.rowCount,
            });
          },
        );
      }),
    );
  } catch (err) {
    const refusal = refusalResponse(err);
    if (refusal) {
      return refusal;
    }
    // The 404 and the two bare AppErrors (REASON_REQUIRED, CONFLICT) render
    // through apiHandler as `{ error, code }`, which is all they have to say.
    throw err;
  }

  const response = NextResponse.json({
    changed: result.changed,
    orderRecordId: result.orderRecordId,
    previousOrderRecordId: result.previousOrderRecordId,
    rowCount: result.rowCount,
    completedFulfillment: result.completedFulfillment,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
