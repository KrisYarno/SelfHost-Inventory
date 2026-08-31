/**
 * lib/inventory/order-lock.ts — THE ORDER LOCK (reconciliation Part 2, spec
 * §2.7(1); contract pack CB0.2, plan P-2).
 *
 * Statement 1 of every transaction that moves an order's stock is this one
 * `SELECT … FOR UPDATE` over the deduped union of the ids the request names.
 * Taking it FIRST is what makes the rest of the lane's lock order meaningful:
 * two requests touching one order serialize here, before either has pinned a
 * read view, rather than discovering each other halfway through a ledger write.
 *
 * REQUIRED vs ADVISORY is the one distinction worth reading twice. A required id
 * that no longer exists is a 409 `ORDER_GONE` — the caller asked to write
 * against an order that vanished between discovery and the lock. An advisory id
 * (a deleted previous order, an order a mapping seam derived from its register)
 * is simply absent from the map: a stale reference must never brick the write
 * that names it.
 *
 * THE MAP ANSWERS FOR THE ID THAT WAS ASKED. MySQL matches these ids case-
 * INSENSITIVELY (`utf8mb4_unicode_ci`), so a hand-cased id finds its row; if the
 * map were keyed only by the returned spelling, that caller would be told its
 * order is gone. The fold is used for the dedupe and the lookup ONLY — the
 * `loadOrders` idiom, `lib/reconciliation/attribution.ts:1087-1110`. (It is
 * `toLowerCase()`, narrower than the collation: accent and `ß` folds are out of
 * scope, and these ids are cuids and Woo numbers.)
 *
 * Next-free: `@prisma/client`, `AppError`, and the client's TYPE only.
 */

import { Prisma } from '@prisma/client';

import { AppError } from '@/lib/error-handling';
import type prisma from '@/lib/prisma';

/** The code string IS the wire contract (routes compare `err.code === ORDER_GONE`). */
export const ORDER_GONE = 'ORDER_GONE' as const;

/** What the lock returns per order — never customer data. */
export type LockedOrder = { id: string; orderNumber: string };

/** The ids one transaction locks: what it must have, and what it would like. */
export type OrderLockIds = { required: readonly string[]; advisory?: readonly string[] };

/** `$transaction`'s options, passed through verbatim by `withOrderLock`. */
export type OrderLockTxOptions = {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
};

/**
 * THE first statement. Locks every id in `required ∪ advisory` in one
 * statement, `ORDER BY id` so the acquisition order is total across writers.
 * Empty union → NO statement, empty map.
 *
 * Throws ONLY for a missing REQUIRED id, naming the first one, with the id the
 * CALLER asked with (an order id or number — never customer data).
 */
export async function lockFirst(
  tx: Prisma.TransactionClient,
  ids: OrderLockIds
): Promise<Map<string, LockedOrder>> {
  const locked = new Map<string, LockedOrder>();

  // Every asked spelling, in ask order; one lookup id per fold (first wins).
  const asked: string[] = [];
  const byFold = new Map<string, string>();
  const collect = (id: string) => {
    asked.push(id);
    const folded = id.toLowerCase();
    if (!byFold.has(folded)) byFold.set(folded, id);
  };
  ids.required.forEach(collect);
  if (ids.advisory) ids.advisory.forEach(collect);
  if (byFold.size === 0) return locked;

  const lookup: string[] = [];
  byFold.forEach((id) => lookup.push(id));

  const rows = await tx.$queryRaw<LockedOrder[]>(Prisma.sql`
    SELECT id, orderNumber FROM external_orders
    WHERE id IN (${Prisma.join(lookup)})
    ORDER BY id
    FOR UPDATE
  `);

  // Pass 1 keys by the returned id; pass 2 fills every asked spelling still
  // absent. Nothing is overwritten, and case-variant asks of one row share ONE
  // object — the identity a caller can rely on.
  const rowByFold = new Map<string, LockedOrder>();
  rows.forEach((row) => {
    const order: LockedOrder = { id: row.id, orderNumber: row.orderNumber };
    locked.set(row.id, order);
    rowByFold.set(row.id.toLowerCase(), order);
  });
  asked.forEach((id) => {
    if (locked.has(id)) return;
    const hit = rowByFold.get(id.toLowerCase());
    if (hit) locked.set(id, hit);
  });

  const missing = ids.required.find((id) => !locked.has(id));
  if (missing !== undefined) {
    throw new AppError(`order ${missing} no longer exists`, ORDER_GONE, 409);
  }

  return locked;
}

/**
 * The route-owned transaction's wrapper: `$transaction` + `lockFirst` as
 * statement 1 + `fn(tx, orders)`.
 *
 * TOTAL on the id set. An empty union (a count, an admin's unstamped move, a
 * mapping seam whose intersection is empty — the common case on deploy day)
 * runs a plain `$transaction` with ZERO locking statements and hands `fn` the
 * empty map. That branch lives inside `lockFirst`, which owns the emptiness
 * question for both entry points; it is never a rule a caller has to remember
 * (OCp2-4).
 *
 * `txOptions` reaches `$transaction` verbatim — unfulfill carries
 * `{ timeout: 30000 }` today and the wrapper must not drop it.
 */
export async function withOrderLock<T>(
  client: typeof prisma,
  ids: OrderLockIds,
  fn: (tx: Prisma.TransactionClient, orders: Map<string, LockedOrder>) => Promise<T>,
  txOptions?: OrderLockTxOptions
): Promise<T> {
  return client.$transaction(async (tx) => {
    const orders = await lockFirst(tx, ids);
    return fn(tx, orders);
  }, txOptions);
}
