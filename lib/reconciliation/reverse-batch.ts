/**
 * THE REVERSE (reconciliation Part 2, spec §2.5; pack CB2b.1).
 *
 * "Put this batch back." Until now the workbench Undo did that with N positive
 * adjusts that named nothing — no link to the batch they reversed, no bound on
 * how many times the same units could be handed back, and no way for the report
 * to tell a correction from a fresh count. This core writes the same restoration
 * as ONE act that NAMES its subject: CORRECTION rows for the REMAINDER, per
 * `(productId, locationId)` key, under one new batch id, stamped like the batch
 * they reverse, with an audit event whose entity is the REVERSED batch.
 *
 * TX-SCOPED and Next-free. The caller owns the transaction, the order lock, the
 * retry wrapper and the audit event's contents; this core owns the ladder, the
 * arithmetic and the writes.
 *
 * THE REMAINDER, NEVER THE BATCH (I-R2). What is owed on a key is the units the
 * batch took OUT of it minus everything already put back through this lane's
 * three restoring events. That is why the restoration ledger is read at all: a
 * CORRECTION row carries its OWN batch id, so "has this been reversed?" is not a
 * question the ledger rows can answer about themselves. Nothing owed anywhere is
 * `ALREADY_REVERSED` with both numbers — the second click of a double-click, and
 * the second attempt of a retried request, get the same honest answer.
 *
 * AFTER A MOVE, THE UNITS ARE SOMEWHERE ELSE (spec REV-9 CX6-2). A batch whose
 * stock was reclassified to a physical location is restored THERE, not at the
 * ledger location its rows still name, and `restoredByKey` is keyed by the
 * location a restoration WROTE TO for exactly that reason.
 *
 * THE STATEMENT ORDER IS THE CONTRACT (I-R1, spec §2.7(4)): the batch's rows
 * `FOR UPDATE` (inside the preamble) → the evidence → the latest attempt → the
 * restoration ledger (plain, and fresh because the lock precedes it) → the
 * canonical prelock → the writes, in `(productId, locationId)` ascending order.
 *
 * NO ATTEMPT ROW. A reverse is not an attribution and files none — the attempts
 * allow-list stays at five writers, and this module imports none of them.
 */

import { Prisma, inventory_logs_logType } from '@prisma/client';

import { applyStockDelta } from '@/lib/inventory';
import { prelockKey, prelockProductLocations } from '@/lib/inventory/prelock';
import { lockAttributableBatch, partiallyStamped } from '@/lib/reconciliation/lock-attributable-batch';
import {
  priorRestorations,
  RestorationLedgerCorrupt,
  type RestorationRow,
} from '@/lib/reconciliation/restorations';
import {
  AlreadyReversedRefusal,
  BatchMovedRefusal,
  FulfilledBatchRefusal,
  NullLocationRowRefusal,
  PartiallyStampedRefusal,
  UnattributedRefusal,
} from '@/lib/reconciliation/refusals';

export type ReverseInput = {
  batchId: string;
  /** What the ROUTE's discovery read — the stale-discovery compare keys on it. */
  discovered: { orderRecordId: string | null };
  actor: { userId: number; isAdmin: boolean };
  /** Minted by the route; the CORRECTION rows AND the event carry it. */
  newBatchId: string;
};

export type ReverseContext = {
  /** The batch that was reversed. */
  reversedBatchId: string;
  /** The NEW batch this call's rows and its event carry. */
  batchId: string;
  /** The uniform stamp the rows carried — the CORRECTION rows carry it too. */
  orderRecordId: string | null;
  /** What THIS call wrote: the restore location, and the units put back there. */
  rows: RestorationRow[];
  /** This call's units. */
  restoredUnits: number;
  /** Prior CORRECTION + REVERSE units, from the ledger. */
  previouslyRestored: number;
  /** The batch's outbound Σ. */
  totalUnits: number;
  /** Set when a prior MOVE relocated the stock — it was restored THERE. */
  physicalLocationId: number | null;
};

/** The prelock's comparator (`prelock.ts:94-96`), which is not exported. */
function byKey(
  a: { productId: number; locationId: number },
  b: { productId: number; locationId: number },
): number {
  return a.productId === b.productId ? a.locationId - b.locationId : a.productId - b.productId;
}

/**
 * Reverse one batch: restore what is still owed, per key, and hand the caller
 * the fact it just committed.
 *
 * @throws every refusal on the frozen ladder below, and
 *         `RestorationLedgerCorrupt` when the ledger cannot be read honestly
 */
export async function reverseBatch(
  tx: Prisma.TransactionClient,
  input: ReverseInput,
  onRecord: (tx: Prisma.TransactionClient, ctx: ReverseContext) => Promise<void>,
): Promise<ReverseContext> {
  // 1. THE SHARED PREAMBLE — the rows locked, the evidence read, and the three
  //    refusals every batch writer inherits in the same order.
  const b = await lockAttributableBatch(tx, input.batchId);

  // 2. THE ACTOR RULE, FIRST among this core's own refusals (spec REV-9 CX6-20).
  //    Authorisation precedes every DATA-BEARING refusal: a caller who may not
  //    touch this batch must not learn its shape by being told why it refused.
  //    Evaluated on the LOCKED rows — the route's aggregate decided the same
  //    question a moment earlier, and this is the copy that holds a lock.
  if (
    b.current === null &&
    !input.actor.isAdmin &&
    !b.rows.every((r) => r.userId !== null && r.userId === input.actor.userId)
  ) {
    throw new UnattributedRefusal();
  }

  // 3. THE STALE-DISCOVERY GUARD. An admin attributed this batch between the
  //    route's discovery read and this lock, so the caller is acting on a
  //    picture that no longer holds: refuse, refetch, decide again.
  if (b.current !== input.discovered.orderRecordId) {
    throw new BatchMovedRefusal(b.current, input.discovered.orderRecordId);
  }

  // 4. ONE id on some rows and none on the others. A restoration would be built
  //    from a batch whose own stamp is a repair waiting to happen.
  const partial = partiallyStamped(b.rows, b.stamps);
  if (partial) {
    throw new PartiallyStampedRefusal(partial.stamped, partial.unstamped);
  }

  // 5. A ROW THAT NAMES NO LOCATION. `locationId` is nullable in the ledger and
  //    both the prelock and the write core take a non-null one: there is no
  //    place to put these units back, and guessing one is not a repair.
  const nullRow = b.rows.find((r) => r.locationId === null);
  if (nullRow) {
    throw new NullLocationRowRefusal(nullRow.id);
  }

  // 6. FULFILLED — WITHOUT attribution's `current !== null` guard. A batch whose
  //    stock left through a fulfil is put back by UNFULFILL, stamped or not,
  //    because the line-level `fulfilledQty` bookkeeping lives there and nowhere
  //    else. That includes the attempt-only shape: the evidence is the same
  //    predicate the report shows, so no control ever lights on this batch.
  if (b.fulfilled) {
    throw new FulfilledBatchRefusal(b.evidence.fulfillmentOrderId ?? b.current, null);
  }

  // 7. WHAT HAS ALREADY BEEN PUT BACK — a plain read, AFTER the lock, so its
  //    view postdates every committed restoration (the order pin).
  const prior = await priorRestorations(tx, input.batchId);

  // 8. THE REMAINDER, PER KEY.
  //
  // `outbound` is what the batch took out of each key (every locked row is a
  // negative by the population predicate). `restoreLocation` is where those
  // units physically are NOW: their own location, or the location a prior MOVE
  // relocated them to — and `restoredByKey` is keyed by the location a
  // restoration WROTE TO, so the lookup uses the restore location, never the
  // ledger one.
  const outbound = new Map<string, { productId: number; locationId: number; units: number }>();
  b.rows.forEach((r) => {
    const locationId = r.locationId as number;
    const key = prelockKey(r.productId, locationId);
    const seen = outbound.get(key);
    if (seen) {
      seen.units += -r.delta;
    } else {
      outbound.set(key, { productId: r.productId, locationId, units: -r.delta });
    }
  });

  const move = prior.move;
  if (move !== null) {
    // THE MOVE AND THE ROWS MUST DESCRIBE ONE BATCH (G6-3/G7-1). A move event
    // whose ledger location is not where these rows sit, or which names a
    // product this batch never carried, is not this batch's move — and a
    // remainder computed from it would restore units at a location the stock
    // never reached.
    const carried = new Set(b.rows.map((r) => r.productId));
    const mismatched =
      b.rows.some((r) => r.locationId !== move.ledgerLocationId) ||
      move.productIds.some((productId) => !carried.has(productId));
    if (mismatched) {
      throw new RestorationLedgerCorrupt(move.eventId);
    }
  }

  const restoreLocationOf = (locationId: number): number => move?.physicalLocationId ?? locationId;

  // 9. THE BELT, BEFORE THE CAP IS USED (PK-4/FR-8). Every key the ledger says
  //    was restored must be a key this batch could have restored TO, and no key
  //    may hold more units than the batch ever took out of it. A cap computed
  //    from a ledger that disagrees with itself is the one number this lane
  //    never writes.
  const expected = new Map<string, number>();
  outbound.forEach((group) => {
    expected.set(prelockKey(group.productId, restoreLocationOf(group.locationId)), group.units);
  });
  prior.restoredByKey.forEach((units, key) => {
    const cap = expected.get(key);
    if (cap === undefined || units < 0 || units > cap) {
      throw new RestorationLedgerCorrupt(prior.eventIdByKey.get(key) ?? move?.eventId ?? 0);
    }
  });

  // 10. NOTHING OWED ANYWHERE. Both figures ride out: "already reversed" without
  //     them reads as a refusal to try rather than as the ledger stating what it
  //     has already done.
  const groups: Array<{ productId: number; locationId: number; remaining: number }> = [];
  let totalUnits = 0;
  outbound.forEach((group) => {
    totalUnits += group.units;
    const locationId = restoreLocationOf(group.locationId);
    const restored = prior.restoredByKey.get(prelockKey(group.productId, locationId)) ?? 0;
    const remaining = group.units - restored;
    if (remaining > 0) {
      groups.push({ productId: group.productId, locationId, remaining });
    }
  });

  let previouslyRestored = 0;
  prior.restoredByKey.forEach((units) => {
    previouslyRestored += units;
  });

  if (groups.length === 0) {
    throw new AlreadyReversedRefusal(previouslyRestored, totalUnits);
  }

  // 11. THE CANONICAL PRELOCK, over the keys this call will write. The rows it
  //     returns are NOT a guard here — a restoration adds stock and has no floor
  //     — the prelock exists for the lock ORDER (spec §2.7(3)).
  groups.sort(byKey);
  await prelockProductLocations(
    tx,
    groups.map((group) => ({ productId: group.productId, locationId: group.locationId })),
  );

  // 12. THE WRITES, in the canonical order the prelock took them in. The locks
  //     are already held; the order is what makes the statement trace
  //     deterministic for the pins that read it.
  const rows: RestorationRow[] = [];
  let restoredUnits = 0;
  for (const group of groups) {
    await applyStockDelta(tx, {
      userId: input.actor.userId,
      productId: group.productId,
      locationId: group.locationId,
      delta: group.remaining,
      logType: inventory_logs_logType.CORRECTION,
      reasonCode: 'CORRECTION',
      batchId: input.newBatchId,
      // I-R4: stamped like the batch it reverses, so the matcher nets the two
      // sides of the same order rather than reading a mystery credit.
      orderRecordId: b.current,
    });
    rows.push({ productId: group.productId, locationId: group.locationId, delta: group.remaining });
    restoredUnits += group.remaining;
  }

  const ctx: ReverseContext = {
    reversedBatchId: input.batchId,
    batchId: input.newBatchId,
    orderRecordId: b.current,
    rows,
    restoredUnits,
    previouslyRestored,
    totalUnits,
    physicalLocationId: move?.physicalLocationId ?? null,
  };

  // 13. THE RECORD, inside the same transaction: the ledger rows, the event and
  //     the response all describe the same committed fact or none of them do.
  await onRecord(tx, ctx);

  return ctx;
}
