/**
 * lib/inventory/count.ts — THE SPOT COUNT (reconciliation Part 2, pack
 * § P2-B3-2 C2-1).
 *
 * An operator counts the shelf and says how many are there. The record is
 * compared against that number UNDER THE PRELOCK and at the row version the
 * operator's screen read, and the difference is booked as ONE ledger row of
 * logType COUNT (reasonCode COUNT) — or, when the count matches the record,
 * nothing is booked at all and the caller files an audit-only "confirmed count".
 *
 * THE VERSION IS THE GUARD. A count is an absolute statement about the shelf,
 * so a count taken before a sale must never overwrite the stock that sale left:
 * a row whose version moved since the operator's read answers the ONE 409
 * envelope (`OptimisticLockError` → `apiHandler`), and nothing is written.
 *
 * The core takes the ROUTE's transaction and never opens one; it never records
 * the change itself either — `onRecord` is the route's (it owns the product and
 * location names and the actor), and a throw from it aborts the transaction, so
 * no ledger row ever commits without its event.
 *
 * No stock floor: `countedQuantity >= 0` is the schema's, and a record below
 * zero (legacy negatives) counted up books a positive COUNT.
 *
 * Next-free: Prisma types, the canonical prelock, the stock primitive and the
 * transient/optimistic error leaf. Nothing under `lib/reconciliation/`.
 */

import { inventory_logs_logType, Prisma } from '@prisma/client';

import { applyStockDelta } from '@/lib/inventory';
import { prelockKey, prelockProductLocations } from '@/lib/inventory/prelock';
import { OptimisticLockError } from '@/lib/inventory/tx-errors';

type CountLog = Awaited<ReturnType<typeof applyStockDelta>>['log'];

/** What a count did: confirmed the record, or set it (and by how much). */
export type CountResult =
  | { changed: false; previousQuantity: number; version: number }
  | { changed: true; previousQuantity: number; delta: number; log: CountLog; newVersion: number };

export async function countAtLocation(
  tx: Prisma.TransactionClient,
  input: {
    userId: number;
    productId: number;
    locationId: number;
    countedQuantity: number;
    expectedVersion: number;
    batchId: string;
  },
  onRecord: (tx: Prisma.TransactionClient, result: CountResult) => Promise<void>
): Promise<CountResult> {
  const { userId, productId, locationId, countedQuantity, expectedVersion, batchId } = input;

  // 1. THE CANONICAL PRELOCK, first: the row is materialised and X-locked
  // before anything reads it, and the guard below reads what it returns. The
  // fallback is spelled locally (lib/inventory.ts keeps its own private); on a
  // real engine the materialised never-stocked row reads the same `{ 0, 0 }`,
  // which is what the dialog's location read synthesises for it.
  const locked = await prelockProductLocations(tx, [{ productId, locationId }]);
  const row = locked.get(prelockKey(productId, locationId)) ?? { quantity: 0, version: 0 };

  // 2. The operator counted against a version; anything else moved the shelf.
  if (row.version !== expectedVersion) {
    throw new OptimisticLockError('Stock changed while you counted', row.version, expectedVersion);
  }

  // 3. The count, measured against the locked record.
  const delta = countedQuantity - row.quantity;

  // 4. A match books nothing: the record was right, and the route's event says so.
  if (delta === 0) {
    const confirmed: CountResult = {
      changed: false,
      previousQuantity: row.quantity,
      version: row.version,
    };
    await onRecord(tx, confirmed);
    return confirmed;
  }

  // 5. A difference is ONE COUNT/COUNT ledger row (the primitive bumps the version).
  const { log, newVersion } = await applyStockDelta(tx, {
    userId,
    productId,
    locationId,
    delta,
    logType: inventory_logs_logType.COUNT,
    reasonCode: 'COUNT',
    batchId,
  });
  const counted: CountResult = {
    changed: true,
    previousQuantity: row.quantity,
    delta,
    log,
    newVersion,
  };
  await onRecord(tx, counted);
  return counted;
}
