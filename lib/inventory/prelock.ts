/**
 * lib/inventory/prelock.ts — THE CANONICAL PRELOCK (reconciliation Part 2, spec
 * §2.7(3); contract pack CB0.1, plan P-2).
 *
 * Every covered writer takes the SAME `product_locations` rows in the SAME
 * order, before its transaction has pinned a read view, and reads its guards off
 * what this returns. That is the whole of the discipline, and it lives here so
 * there is exactly one spelling of it — a second copy is not a second
 * implementation, it is a second lock order (pinned from the outside by
 * `__tests__/unit/lib/inventory/prelock-source-pin.test.ts`).
 *
 * TWO STATEMENTS, for the DEDUPED key set in canonical (productId, locationId)
 * ascending order:
 *
 *   1. MATERIALIZE — one multi-row `INSERT … ON DUPLICATE KEY UPDATE version =
 *      version`. The VALUES ride in canonical order because ODKU X-locks the
 *      existing rows in that order, and the self-assignment changes nothing, so
 *      `updatedAt` is NOT bumped on an existing row: the
 *      `idx_product_locations_updated` consumers must never see phantom
 *      activity from a lock. What it buys is that a never-stocked key EXISTS
 *      before anyone reads it — the gap where two writers both saw "no row" and
 *      both created one is closed, and `{ quantity: 0, version: 0 }` (the live
 *      column defaults) becomes a value a guard can compare against rather than
 *      an absence a guard has to skip.
 *   2. THE RETURNING LOCKING READ — one `SELECT … FOR UPDATE` over the same
 *      set. Kept deliberately even though statement 1 already holds the locks:
 *      it returns the quantities and versions the guards compare against, so no
 *      covered writer needs a second read inside its lock window.
 *
 * `minQuantity` is absent from the column list on purpose: the live DDL defaults
 * it to 0 (the B1-0 preflight recorded the whole table, plan §8).
 *
 * Next-free and Prisma-type-only by contract: this module is imported by the
 * stock primitives, the routes and the concurrency gate alike.
 */

import { Prisma } from '@prisma/client';

/** One `product_locations` row, as a caller names it. */
export type PrelockKeyInput = { productId: number; locationId: number };

/** What the locking read returns for one key. */
export type PrelockedRow = { quantity: number; version: number };

/**
 * A LIB BACKSTOP, not the request bound. The four feeding routes cap their item
 * arrays at 100 in their own schemas (a ZodError → 400 through the existing
 * ladder), so this RangeError is unreachable through a validated route; it
 * exists so an in-process caller cannot quietly build a statement with
 * thousands of locked rows in it.
 */
export const MAX_PRELOCK_KEYS = 200;

/** The map key every consumer uses. Exported — never re-spelled. */
export function prelockKey(productId: number, locationId: number): string {
  return `${productId}:${locationId}`;
}

/**
 * Materialize + lock the given `product_locations` rows, and return what they
 * hold. Empty keys → NO statement and an empty map (the caller does not have to
 * remember the empty case).
 */
export async function prelockProductLocations(
  tx: Prisma.TransactionClient,
  keys: ReadonlyArray<PrelockKeyInput>
): Promise<Map<string, PrelockedRow>> {
  const locked = new Map<string, PrelockedRow>();

  // Dedupe first — the cap, both statements and the returned map are all about
  // the deduped set. (A request naming one key twice is legal; it locks once.)
  const deduped = new Map<string, PrelockKeyInput>();
  keys.forEach((key) => {
    const k = prelockKey(key.productId, key.locationId);
    if (!deduped.has(k)) deduped.set(k, { productId: key.productId, locationId: key.locationId });
  });
  if (deduped.size === 0) return locked;
  if (deduped.size > MAX_PRELOCK_KEYS) {
    throw new RangeError(`prelockProductLocations: at most ${MAX_PRELOCK_KEYS} keys`);
  }

  const canonical: PrelockKeyInput[] = [];
  deduped.forEach((key) => canonical.push(key));
  canonical.sort((a, b) =>
    a.productId === b.productId ? a.locationId - b.locationId : a.productId - b.productId
  );

  // Statement 1 — materialize, in canonical VALUES order.
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO product_locations (productId, locationId, quantity, version, updatedAt)
    VALUES ${Prisma.join(
      canonical.map((key) => Prisma.sql`(${key.productId}, ${key.locationId}, 0, 0, NOW())`),
      ', '
    )}
    ON DUPLICATE KEY UPDATE version = version
  `);

  // Statement 2 — the returning locking read, same set, same order.
  const rows = await tx.$queryRaw<Array<PrelockKeyInput & PrelockedRow>>(Prisma.sql`
    SELECT productId, locationId, quantity, version FROM product_locations
    WHERE (productId, locationId) IN (${Prisma.join(
      canonical.map((key) => Prisma.sql`(${key.productId}, ${key.locationId})`),
      ', '
    )})
    ORDER BY productId, locationId
    FOR UPDATE
  `);

  rows.forEach((row) => {
    locked.set(prelockKey(row.productId, row.locationId), {
      quantity: row.quantity,
      version: row.version,
    });
  });

  return locked;
}
