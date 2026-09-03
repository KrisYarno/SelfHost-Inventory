/**
 * THE WRONG-LOCATION MOVE (reconciliation Part 2, spec §2.6; pack CB2c.1).
 *
 * "The stock left location P, not the ledger's L." Until now there was no way to
 * say that at all: the only repairs available were an adjust pair somebody typed
 * by hand, which named nothing, or an Undo-and-redo that rewrote the order's
 * attribution to fix a location. This core says it as ONE act — a TRANSFER pair
 * per product, `physical → ledger`, under one new batch id, stamped like the
 * batch it reclassifies.
 *
 * AN ACCOUNTING RECLASSIFICATION, NOT A CORRECTION (SETTLED 18a). The batch's
 * own outbound rows stay exactly as written; the order stays attributed once;
 * nothing is restored and nothing is deducted again. What moves is the BOOKS:
 * the physical location gives up the units that actually left it, and the ledger
 * location gets back the units it was wrongly charged. Both ends end right, and
 * the pair nets to zero — which is why a MOVE's legs contribute metadata to the
 * restoration ledger and never units (spec REV-9 CX6-2).
 *
 * A FULFILMENT-EVIDENCED BATCH IS NEVER MOVED IN B2 (PK-1, spec §2.6 REV-14).
 * Unfulfill restores at the REQUEST's own location and reads no restoration
 * ledger, so a MOVE followed by an unfulfill would leave the physical location
 * short and the ledger location over — and an unfulfill followed by a MOVE would
 * apply the pair to stock that has already been put back. The wrong-location fix
 * for a fulfilment is unfulfill + refulfil at the correct location; both dialogs
 * exist, and rung 7 sends the operator to them.
 *
 * THE SOURCE IS CHECKED ON THE LOCKED ROW (I-M3, spec §2.6). `INSUFFICIENT_AT_
 * SOURCE` compares the units against the `product_locations` row the canonical
 * prelock just returned — never `validateStockAvailability`'s consistent read,
 * which answers from a view another writer can already have moved past.
 *
 * TX-SCOPED and Next-free, like every writer this lane shares: the caller owns
 * the transaction, the order lock, the retry wrapper and the audit event's
 * contents; this core owns the ladder, the arithmetic and the two legs.
 *
 * NO ATTEMPT ROW. A move is not an attribution and files none — the attempts
 * allow-list stays at five writers, and this module imports none of them.
 */

import { Prisma, inventory_logs_logType } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

import { applyStockDelta } from '@/lib/inventory';
import { prelockKey, prelockProductLocations } from '@/lib/inventory/prelock';
import { lockAttributableBatch, partiallyStamped } from '@/lib/reconciliation/lock-attributable-batch';
import { priorRestorations, type RestorationRow } from '@/lib/reconciliation/restorations';
import {
  AlreadyMovedRefusal,
  BatchMovedRefusal,
  BatchRestoredRefusal,
  FulfilledBatchRefusal,
  InsufficientAtSourceRefusal,
  MultiLocationRefusal,
  NullLocationRowRefusal,
  PartiallyStampedRefusal,
  SameLocationRefusal,
  UnattributedRefusal,
} from '@/lib/reconciliation/refusals';

export type MoveInput = {
  batchId: string;
  /** Where the stock PHYSICALLY went. The ledger end is read off the batch. */
  physicalLocationId: number;
  /** What the ROUTE's discovery read — the stale-discovery compare keys on it. */
  discovered: { orderRecordId: string | null };
  actor: { userId: number; isAdmin: boolean };
  /** Minted by the route; the TRANSFER rows AND the event carry it. */
  newBatchId: string;
};

export type MoveContext = {
  /** The batch that was moved. */
  movedBatchId: string;
  /** The NEW batch this call's rows and its event carry. */
  batchId: string;
  /** The uniform stamp the rows carried — the TRANSFER legs carry it too. */
  orderRecordId: string | null;
  /** The location the batch's own rows name — the books that were wrong. */
  ledgerLocationId: number;
  /** The location the stock actually left. */
  physicalLocationId: number;
  /** ONE TRANSFER pair per product, with the id its two legs share. */
  pairs: Array<{ productId: number; units: number; transferId: string }>;
  /**
   * ALL the legs as written — exactly 2 × `pairs.length`, two per product
   * (the physical −units, then the ledger +units), `delta` SIGNED as the ledger
   * carries it so the restoration reader can validate them as the pair they are.
   */
  rows: RestorationRow[];
};

/**
 * Move one batch's books from the location its rows name to the location its
 * stock actually left, and hand the caller the fact it just committed.
 *
 * @throws every refusal on the frozen ladder below, and
 *         `RestorationLedgerCorrupt` when the restoration ledger cannot be read
 */
export async function moveBatch(
  tx: Prisma.TransactionClient,
  input: MoveInput,
  onRecord: (tx: Prisma.TransactionClient, ctx: MoveContext) => Promise<void>,
): Promise<MoveContext> {
  // 1. THE SHARED PREAMBLE — the rows locked, the evidence read, and the three
  //    refusals every batch writer inherits in the same order.
  const b = await lockAttributableBatch(tx, input.batchId);

  // 2. THE ACTOR RULE, FIRST among this core's own refusals (spec REV-9 CX6-20).
  //    Authorisation precedes every DATA-BEARING refusal: a caller who may not
  //    touch this batch must not learn its shape — its locations, its units —
  //    by being told why it refused.
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

  // 4. ONE id on some rows and none on the others. A reclassification built from
  //    a batch whose own stamp is a repair waiting to happen would carry that
  //    repair into two new ledger rows per product.
  const partial = partiallyStamped(b.rows, b.stamps);
  if (partial) {
    throw new PartiallyStampedRefusal(partial.stamped, partial.unstamped);
  }

  // 5. A ROW THAT NAMES NO LOCATION. There is no ledger end to move FROM, and
  //    guessing one is not a repair.
  const nullRow = b.rows.find((r) => r.locationId === null);
  if (nullRow) {
    throw new NullLocationRowRefusal(nullRow.id);
  }

  // 6. ONE SOURCE, ASSERTED RATHER THAN ASSUMED. A deduct-simple or fulfil batch
  //    sits at one location by construction — but "by construction" is what the
  //    ledger looked like before this lane found rows that disagreed with it, so
  //    the batch is asked rather than trusted.
  const locationIds = Array.from(new Set(b.rows.map((r) => r.locationId as number))).sort(
    (x, y) => x - y,
  );
  if (locationIds.length > 1) {
    throw new MultiLocationRefusal(locationIds);
  }
  const ledgerLocationId = locationIds[0];

  // 7. FULFILLED — THE MOVE NEVER TOUCHES ONE (PK-1). Unfulfill restores at the
  //    request's own location and reads no restoration ledger, so a move on
  //    either side of it leaves one location short and the other over. The
  //    repair is unfulfill + refulfil at the correct location, and the sentence
  //    says so.
  if (b.fulfilled) {
    throw new FulfilledBatchRefusal(b.evidence.fulfillmentOrderId ?? b.current, null);
  }

  // 8. THE DESTINATION IS ALREADY THE SOURCE. Nothing to reclassify, and the
  //    operator fixes it by choosing another location.
  if (input.physicalLocationId === ledgerLocationId) {
    throw new SameLocationRefusal(ledgerLocationId);
  }

  // 9. WHAT HAS ALREADY HAPPENED TO THIS BATCH — a plain read, AFTER the lock,
  //    so its view postdates every committed restoration (the order pin).
  //
  //    A batch whose units have been put back cannot be reclassified: the
  //    restoring rows carry their OWN batch id, so a pair applied afterwards
  //    would move books that no longer describe stock this batch took out. And
  //    two moves are two disagreeing accounts of where the units are (G7-7).
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

  // 10. THE UNITS, PER PRODUCT, and the 2P keys the pair will write. Every
  //     locked row is a negative by the population predicate, so the units this
  //     batch took out of the ledger location are the negated sum.
  const unitsByProduct = new Map<number, number>();
  b.rows.forEach((r) => {
    unitsByProduct.set(r.productId, (unitsByProduct.get(r.productId) ?? 0) + -r.delta);
  });

  const productIds: number[] = [];
  unitsByProduct.forEach((_units, productId) => productIds.push(productId));
  productIds.sort((x, y) => x - y);

  const keys = productIds.flatMap((productId) => [
    { productId, locationId: input.physicalLocationId },
    { productId, locationId: ledgerLocationId },
  ]);
  const locked = await prelockProductLocations(tx, keys);

  // I-M3: THE SOURCE CHECK READS THE LOCKED ROW. The physical location's books
  // must hold what physically left it — moving anyway books a negative on-hand
  // at the source, and both figures ride out so the operator decides what the
  // real story is.
  for (const productId of productIds) {
    const units = unitsByProduct.get(productId) as number;
    const onBook = locked.get(prelockKey(productId, input.physicalLocationId))?.quantity ?? 0;
    if (onBook < units) {
      throw new InsufficientAtSourceRefusal(productId, input.physicalLocationId, onBook, units);
    }
  }

  // 11. THE PAIR, per product, in `productId` ascending order. The two legs
  //     share ONE `transferId` (the `createInventoryTransfer` mint) so the
  //     ledger view pairs them exactly, and the ORDER of the pair is fixed by
  //     ROLE rather than by location id — the locks are already held, and
  //     physical-then-ledger is what the pin reads. They are TRANSFER rows, so
  //     the attribution population never admits the physical leg and the
  //     matcher's deducted-side aggregate is unchanged.
  const pairs: MoveContext['pairs'] = [];
  const rows: RestorationRow[] = [];
  for (const productId of productIds) {
    const units = unitsByProduct.get(productId) as number;
    const transferId = uuidv4();

    await applyStockDelta(tx, {
      userId: input.actor.userId,
      productId,
      locationId: input.physicalLocationId,
      delta: -units,
      logType: inventory_logs_logType.TRANSFER,
      transferId,
      batchId: input.newBatchId,
      // Stamped like the batch it reclassifies: the order stays attributed once.
      orderRecordId: b.current,
    });
    rows.push({ productId, locationId: input.physicalLocationId, delta: -units });

    await applyStockDelta(tx, {
      userId: input.actor.userId,
      productId,
      locationId: ledgerLocationId,
      delta: units,
      logType: inventory_logs_logType.TRANSFER,
      transferId,
      batchId: input.newBatchId,
      orderRecordId: b.current,
    });
    rows.push({ productId, locationId: ledgerLocationId, delta: units });

    pairs.push({ productId, units, transferId });
  }

  const ctx: MoveContext = {
    movedBatchId: input.batchId,
    batchId: input.newBatchId,
    orderRecordId: b.current,
    ledgerLocationId,
    physicalLocationId: input.physicalLocationId,
    pairs,
    rows,
  };

  // 12. THE RECORD, inside the same transaction: the ledger rows, the event and
  //     the response all describe the same committed fact or none of them do.
  //     NOT a decision site.
  await onRecord(tx, ctx);

  return ctx;
}
