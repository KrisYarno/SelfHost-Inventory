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
 *   BATCH_RESTORED / ALREADY_MOVED (step 6b) come after the same-id short
 *   circuit and before the fulfillment rules: once a batch's units have been put
 *   back or relocated, re-stamping the population rows would leave the restoring
 *   rows carrying the OLD order id, and one batch's truth would be split across
 *   two stamps.
 *   The FULFILLMENT rules come after the stale-client guard and before the
 *   write, because whether a batch may be re-stamped at all depends on how it
 *   was stamped, not on what the client wants.
 *
 * THE PREAMBLE IS SHARED. Steps 1-4 — the row lock, the evidence read, and the
 * NOT_ATTRIBUTABLE -> TOO_MANY_ROWS -> MIXED_STAMPS ladder — are one call into
 * `lock-attributable-batch.ts`, which the reverse, the move and the attributable
 * correction call too. It reads the evidence through the SAME helper the report
 * row reads, and it computes the ONE fulfillment fact: the write path used to
 * keep its own copy of "which events mean a fulfillment" and its own R0 call,
 * and the report drifted away from it (OC-1/OC-2). Nothing in this module reads
 * the attempt row.
 *
 * THE WRITE IS GUARDED. The UPDATE names the id the rows were LOCKED carrying,
 * and its `count` must equal the number of rows locked. A partial match means
 * the batch is not what this transaction read, and a half-stamped batch is worse
 * than an unstamped one — so it refuses instead of committing.
 */

import { Prisma } from '@prisma/client';

import {
  lockAttributableBatch,
  partiallyStamped,
} from '@/lib/reconciliation/lock-attributable-batch';
import { rowWhere } from '@/lib/reconciliation/population';
import { priorRestorations } from '@/lib/reconciliation/restorations';
import {
  AlreadyMovedRefusal,
  BatchMovedRefusal,
  BatchRestoredRefusal,
  CountMismatch,
  FulfilledBatchRefusal,
  PartiallyStampedRefusal,
  R2bOtherTargetRefusal,
  ReasonRequired,
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
  // 1-4. THE SHARED PREAMBLE (pack CB2a.1): the batch's population rows locked
  //       in id order, its evidence read AFTER that lock, the frozen
  //       NOT_ATTRIBUTABLE -> TOO_MANY_ROWS -> MIXED_STAMPS ladder, and the ONE
  //       fulfilment fact. The reverse, the move and the attributable correction
  //       run exactly these four steps, so they are spelled once — this module
  //       no longer carries a locking statement of its own.
  const { rows, stamps, current, evidence, fulfilled, firstRowId, productCount } =
    await lockAttributableBatch(tx, input.batchId);

  // 5. THE STALE-CLIENT GUARD — before anything else that reasons about
  //    `current`, so a racer is never asked for a reason (spec D4, OCp-8).
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
  const partial = partiallyStamped(rows, stamps);
  if (partial !== null) {
    throw new PartiallyStampedRefusal(partial.stamped, partial.unstamped);
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

  // 6b. ALREADY RESTORED, ALREADY MOVED (pack CB2a.1). The restoration ledger is
  //     read AFTER the same-id short circuit (which answers without a
  //     statement) and BEFORE the fulfilment rules, so both refusals outrank
  //     FULFILLED_BATCH and R2B_OTHER_TARGET.
  //
  //     Why re-attribution is refused at all once units have moved: the guarded
  //     write below touches ONLY the population rows. The CORRECTION or TRANSFER
  //     rows a restoration wrote carry their own batch id and would keep the OLD
  //     stamp, so a re-attribution after a restoration splits one batch's truth
  //     across two order ids.
  const prior = await priorRestorations(tx, input.batchId);
  let restoredUnits = 0;
  prior.restoredByKey.forEach((units) => {
    restoredUnits += units;
  });
  if (restoredUnits > 0) {
    throw new BatchRestoredRefusal(restoredUnits);
  }
  if (prior.move !== null) {
    throw new AlreadyMovedRefusal(prior.move.physicalLocationId, prior.move.at);
  }

  // 7. THE FULFILLMENT RULES (spec D4 / SETTLED 11), read off the evidence and
  //    the fulfilment fact the preamble already assembled. Nothing here reads
  //    the attempt row: one spelling of "fulfilled", one reader of it.
  const fulfillmentEvent = evidence.fulfillmentEvent;

  let completedFulfillment = false;
  if (current !== null && fulfilled) {
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
