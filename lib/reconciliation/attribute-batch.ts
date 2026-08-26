/**
 * THE MANUAL-ATTRIBUTION CORE (reconciliation lane, spec REV-7 D4; pack C2b.2).
 *
 * An admin looking at the Attribution tab can say "that batch belongs to order
 * #1009". This is what happens when they do — and nothing else: the batch's
 * ledger rows get the order's id, an attempt row and an audit event record who
 * said so and why. NO stock moves, `fulfilledQty` does not change, no status is
 * pushed to a store. Attribution is a CLASSIFICATION of a deduction that already
 * happened, which is exactly why it is safe to correct by hand.
 *
 * TX-SCOPED BY CONSTRUCTION. This module imports no Prisma client of its own and
 * opens no transaction: it receives the caller's `tx` and writes only through it.
 * That is what lets the ROUTE own `withDeadlockRetry` + `$transaction`, and lets
 * the concurrency gate drive the core directly over two real sessions with no
 * HTTP in the way. It also imports NEITHER `@/lib/prisma` NOR the attempt writer
 * (`lib/attribution/attempts.ts`) — the attempt and the audit row are written by
 * the caller's `onRecord`, inside the same transaction, so the attempts write
 * boundary stays a ROUTE boundary (pack C1b.5) and the four read modules beside
 * this one can never reach a writer through it (pack C2b.5).
 *
 * THE STEP ORDER IS THE CONTRACT (spec D4). Every refusal below is evaluated in
 * a frozen position, and two of those positions carry meaning on their own:
 *
 *   BATCH_MOVED comes BEFORE the same-id and reason rules, so the loser of a
 *   race is told "someone attributed this while you were looking" — never
 *   "reason required" for a change it never saw (OCp-8).
 *   PARTIALLY_STAMPED (step 5b) comes after that guard and before the same-id
 *   short circuit: a batch half-carrying the id the client asked for is NOT
 *   "already attributed", and it is not a race either — it is a ledger the
 *   guarded write cannot move uniformly (OC-6).
 *   The FULFILLMENT rules come after the stale-client guard and before the
 *   write, because whether a batch may be re-stamped at all depends on how it
 *   was stamped, not on what the client wants.
 *
 * THE EVIDENCE IS READ ONCE, through `batchEvidence` in the population module —
 * the SAME helper the report row reads. The write path used to keep its own
 * copy of "which events mean a fulfillment" and its own R0 call, and the report
 * drifted away from it: the control lit on batches this ladder refuses (OC-1),
 * and the two read different sets of audit rows for R0 (OC-2). The helper is
 * Prisma-free and Next-free, so importing it costs this module none of its
 * TX-scoped isolation.
 *
 * THE WRITE IS GUARDED. The UPDATE names the id the rows were LOCKED carrying,
 * and its `count` must equal the number of rows locked. A partial match means
 * the batch is not what this transaction read, and a half-stamped batch is worse
 * than an unstamped one — so it refuses instead of committing.
 */

import { Prisma } from '@prisma/client';

import { batchEvidence, rowWhere, rowWhereSql } from '@/lib/reconciliation/population';
import {
  BatchMovedRefusal,
  CountMismatch,
  FulfilledBatchRefusal,
  MANUAL_ATTRIBUTION_ROW_LIMIT,
  MixedStampsRefusal,
  NotAttributableRefusal,
  PartiallyStampedRefusal,
  R2bOtherTargetRefusal,
  ReasonRequired,
  TooManyRowsRefusal,
} from '@/lib/reconciliation/refusals';

/** What the admin asked for, plus the stale-client guard they were looking at. */
export type AttributeInput = {
  batchId: string;
  orderRecordId: string;
  /** REQUIRED: `null` means "the client saw this batch unattributed". */
  expectPreviousOrderRecordId: string | null;
  reason: string | null;
  actorUserId: number;
};

/** What the core learned, handed to `onRecord` and returned to the caller. */
export type AttributeContext = {
  changed: boolean;
  previousOrderRecordId: string | null;
  rowCount: number;
  productCount: number;
  completedFulfillment: boolean;
  /** The first locked row's id — the attempt row's `ledgerRowId`. */
  firstRowId: number;
};

export type AttributeResult = AttributeContext & { orderRecordId: string };

/** One locked population row: everything the rules below decide from. */
type LockedRow = {
  id: number;
  productId: number;
  logType: string;
  orderRecordId: string | null;
};

/** The audit rows filed under the LEDGER batchId (the deduction's own events). */
type BatchAuditEvent = {
  id: number;
  actionType: string;
  entityId: string | null;
  details: Prisma.JsonValue | null;
};

/**
 * Attribute one outbound batch to one order, inside the caller's transaction.
 *
 * `onRecord` runs ONLY on a real change, after the guarded write and before the
 * return, with the same `tx`: the caller writes the attempt row and the audit
 * event there, so all three land or none do.
 *
 * @throws the pack C2b.1 refusals — the route renders their envelopes
 */
export async function attributeBatch(
  tx: Prisma.TransactionClient,
  input: AttributeInput,
  onRecord: (tx: Prisma.TransactionClient, ctx: AttributeContext) => Promise<void>,
): Promise<AttributeResult> {
  // 1. LOCK THE BATCH'S POPULATION ROWS. `rowWhereSql` is the one spelling of
  //    the population (pack R-3), and the batchId predicate keeps the lock to
  //    this batch's index range — the next-key locks on it are the point: a
  //    second admin attributing the same batch waits here rather than racing.
  const rows = await tx.$queryRaw<LockedRow[]>(
    Prisma.sql`SELECT l.id, l.productId, l.logType, l.orderRecordId FROM inventory_logs l WHERE l.batchId = ${input.batchId} AND ${rowWhereSql('l')} ORDER BY l.id FOR UPDATE`,
  );

  // 2. NOTHING TO ATTRIBUTE, or a batch the report does not speak about. Both
  //    answer the same way: a transfer/count/correction batch is not "hidden",
  //    it is simply not an outbound deduction, and neither is a pre-0b-1 mass
  //    update (R0) whose ADJUSTMENT rows pass the row predicate.
  if (rows.length === 0) {
    throw new NotAttributableRefusal(input.batchId);
  }
  const firstRowId = rows[0].id;

  const auditEvents: BatchAuditEvent[] = await tx.auditLog.findMany({
    where: { batchId: input.batchId },
    orderBy: { id: 'asc' },
    select: { id: true, actionType: true, entityId: true, details: true },
  });

  // ONE evidence assembly (OC-2): R0, whether a fulfillment moved this
  // stock, and which order that event named — read through the SAME helper the
  // report row reads, so the Attribute… control and this ladder can no longer
  // disagree about the batch in front of them.
  const evidence = batchEvidence(auditEvents, rows);

  if (!evidence.attributable) {
    throw new NotAttributableRefusal(input.batchId);
  }

  // 3. THE BOUND, said out loud with both figures.
  const productCount = new Set(rows.map((r) => r.productId)).size;
  if (rows.length > MANUAL_ATTRIBUTION_ROW_LIMIT) {
    throw new TooManyRowsRefusal(rows.length, productCount, MANUAL_ATTRIBUTION_ROW_LIMIT);
  }

  // 4. THE STAMPS the rows carry. Distinct NON-NULL ids: a batch where some rows
  //    are stamped and some are not has one stamp and a repair to make, while a
  //    batch carrying two different ids has no "current" id at all and is
  //    reported rather than averaged (spec §2.2).
  const stamps = Array.from(
    new Set(rows.map((r) => r.orderRecordId).filter((s): s is string => s !== null)),
  );
  if (stamps.length > 1) {
    throw new MixedStampsRefusal(stamps);
  }

  // 5. THE STALE-CLIENT GUARD — before anything else that reasons about
  //    `current`, so a racer is never asked for a reason (spec D4, OCp-8).
  const current = stamps[0] ?? null;
  if (current !== input.expectPreviousOrderRecordId) {
    throw new BatchMovedRefusal(current, input.expectPreviousOrderRecordId);
  }

  // 5b. PARTLY STAMPED (OC-6). One id on some rows and none on the others. The
  //     guarded write in step 9 names the id it locked, so it can move the
  //     stamped half OR the unstamped half — never the batch. Left to fall
  //     through, that surfaced as the step-9 count mismatch, whose sentence
  //     ("the batch moved") describes a RACE and sends the admin off to refresh
  //     a page that will show them exactly the same thing.
  //
  //     AFTER the stale-client guard, so a racer is still told they raced
  //     (OCp-8), and BEFORE the same-id short circuit, because "already
  //     attributed to that order" is false while half the rows carry nothing.
  const unstampedRows = rows.filter((r) => r.orderRecordId === null).length;
  if (stamps.length === 1 && unstampedRows > 0) {
    throw new PartiallyStampedRefusal(rows.length - unstampedRows, unstampedRows);
  }

  // 6. ALREADY THERE. Not an error and not a write: the client's intent is
  //    already the ledger's state, so the transaction ends without a statement.
  //    Recording an attempt here would file a "manual attribution" that changed
  //    nothing, and every later report would count it.
  if (current === input.orderRecordId) {
    return {
      changed: false,
      previousOrderRecordId: current,
      rowCount: rows.length,
      productCount,
      completedFulfillment: false,
      firstRowId,
      orderRecordId: input.orderRecordId,
    };
  }

  // 7. THE FULFILLMENT RULES (spec D4 / SETTLED 11), read off evidence this
  //    transaction already holds plus the latest attempt row.
  const latestAttempt = await tx.orderAttributionAttempt.findFirst({
    where: { batchId: input.batchId },
    orderBy: [{ attemptedAt: 'desc' }, { id: 'desc' }],
  });
  const fulfillmentEvent = evidence.fulfillmentEvent;

  let completedFulfillment = false;
  if (current !== null && (latestAttempt?.evidence === 'fulfillment' || fulfillmentEvent !== null)) {
    // R2: the stamp came from a fulfillment. Re-stamping it here would leave
    // `fulfilledQty` and the pushed store status pointing at the old order.
    throw new FulfilledBatchRefusal(current, null);
  }
  if (current === null && fulfillmentEvent !== null) {
    // R2b: fulfilled, but the ledger was never stamped. The only manual
    // attribution allowed is COMPLETING that stamp. An event naming neither an
    // order id nor an entity cannot be completed against anything, and
    // `fulfillmentOrderId` is null rather than a guess.
    const eventOrder = evidence.fulfillmentOrderId;
    if (input.orderRecordId !== eventOrder) {
      throw new R2bOtherTargetRefusal(eventOrder);
    }
    completedFulfillment = true;
  }

  // 8. MOVING A BATCH OFF AN EXISTING STAMP is a correction of an earlier
  //    decision, and it is recorded with its reason or not at all.
  if (current !== null && current !== input.orderRecordId && !input.reason?.trim()) {
    throw new ReasonRequired();
  }

  // 9. THE GUARDED WRITE. The population predicate comes FIRST and the batch id
  //    AFTER it: `rowWhere` carries its own `batchId: { not: null }` clause, and
  //    a spread that landed on top of this batch's id would widen the statement
  //    to every batch in the ledger. `orderRecordId: current` renders as IS NULL
  //    for an unstamped batch and as equality otherwise — so the rows this
  //    statement moves are exactly the rows this transaction locked.
  const { count } = await tx.inventory_logs.updateMany({
    where: { ...rowWhere, batchId: input.batchId, orderRecordId: current },
    data: { orderRecordId: input.orderRecordId },
  });
  if (count !== rows.length) {
    throw new CountMismatch(count, rows.length);
  }

  // 10. THE RECORDS, in the caller's hands and in this transaction.
  const ctx: AttributeContext = {
    changed: true,
    previousOrderRecordId: current,
    rowCount: rows.length,
    productCount,
    completedFulfillment,
    firstRowId,
  };
  await onRecord(tx, ctx);

  return { ...ctx, orderRecordId: input.orderRecordId };
}
