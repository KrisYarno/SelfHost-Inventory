/**
 * THE MATCH PRODUCER (reconciliation lane Part 2, spec REV-8 §2.2 / D2;
 * pack CA2.1) — what one page of orders COSTS, said once.
 *
 * The matcher is pure and the two side-readers each own their own statement, so
 * something has to decide how many statements a page of orders is worth. That
 * decision lives here and nowhere else: EXACTLY THREE for a non-empty id set —
 * the ordered side, the deducted side, and the decomposition facts the mass
 * balance needs — and ZERO for an empty one. A per-order producer would have
 * been three statements per row, which is how a report page becomes a hundred
 * and fifty reads nobody budgeted for.
 *
 * THE RESULT IS KEYED BY THE ID THAT WAS ASKED (the FD-1 idiom, applied to BOTH
 * reads). The ledger's `orderRecordId` is a soft reference and MySQL matches it
 * case-INSENSITIVELY under utf8mb4_unicode_ci, so a variant-spelled stamp finds
 * its rows and its items and comes back spelled the way the database holds it.
 * A map keyed only by the returned spelling would tell an admin the order has
 * no movement at all — a confident, wrong number.
 *
 * NO VIEWER PARAMETER. Whether an order may be looked at is decided BEFORE the
 * id set is built (a redacted order is never asked), so this module holds no
 * opinion about who is reading — one less place for the membership rule to be
 * re-spelled.
 *
 * Next-free, and textually write-free (pack cross-wave rule 2): this module is
 * on the assistant's read path.
 */

import type { Prisma } from '@prisma/client';

import { readOrderItems } from './items';
import {
  matchOrder,
  type DeductedProduct,
  type OrderItems,
  type OrderMatch,
  type ProductFacts,
} from './match';
import { deductedSideSql, type DeductedSideSqlRow } from './population';

/**
 * The reader's client — the singleton OR a transaction client, because the
 * exception decider (P2-C) runs this read inside the order lock.
 */
export type MatchReader = Pick<
  Prisma.TransactionClient,
  'externalOrderItem' | 'product' | '$queryRaw'
>;

/** At most this many orders per read; symmetric with the two readers below. */
const MAX_ORDERS = 200;

/**
 * The empty ordered side. `readOrderItems` answers for every id that was asked,
 * so this is a totality at the type level rather than a branch the reader can
 * reach.
 */
function emptyOrderItems(): OrderItems {
  return {
    lines: [],
    unmappedLines: 0,
    unmappedUnits: 0,
    bundleLines: 0,
    unresolvableBundleLines: 0,
  };
}

/**
 * A SUM comes back as whatever the driver decided (a Decimal, a string, a
 * number), so the aggregate typed its two columns `unknown` and the conversion
 * is the consumer's — this one, the `attribution.ts` `toNumber` idiom. The
 * matcher's integer guard is what stands behind it: a value that is not a unit
 * count throws there rather than being rounded onto an admin's screen.
 */
function toUnits(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value === null || value === undefined) return 0;
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? asNumber : 0;
}

/**
 * `numericValue` in INTEGER HUNDREDTHS, EXACTLY (spec §2.4a): the column is
 * `Decimal(10,2)`, so its own `toFixed(2)` renders every digit that exists and
 * dropping the point is then a lossless integer read. `numericValue * 100`
 * would go through a float — 0.29 * 100 is 28.999999999999996 — and two masses
 * that are equal would stop balancing.
 *
 * `<= 0` is null: a product with no mass cannot enter a group, and the matcher
 * excludes it as undecomposable rather than dividing by nothing.
 */
function hundredthsOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const fixed =
    typeof (value as { toFixed?: unknown }).toFixed === 'function'
      ? (value as { toFixed(dp: number): string }).toFixed(2)
      : Number(value).toFixed(2);
  const hundredths = Number.parseInt(fixed.replace('.', ''), 10);
  return Number.isFinite(hundredths) && hundredths > 0 ? hundredths : null;
}

/**
 * The deducted-side rows, grouped by the id that was ASKED (see the header).
 * `l.orderRecordId` comes back as the database spelled it; a first pass keys by
 * that spelling and a lowercase pass then fills every asked id still absent,
 * overwriting nothing.
 */
function deductedByAskedId(
  rows: readonly DeductedSideSqlRow[],
  asked: readonly string[],
): Map<string, DeductedProduct[]> {
  const byOrder = new Map<string, DeductedProduct[]>();
  for (const row of rows) {
    const product: DeductedProduct = {
      productId: row.productId,
      out: toUnits(row.outUnits),
      corrected: toUnits(row.correctedUnits),
    };
    const list = byOrder.get(row.orderRecordId);
    if (list === undefined) byOrder.set(row.orderRecordId, [product]);
    else list.push(product);
  }

  const byLower = new Map<string, DeductedProduct[]>();
  byOrder.forEach((list, returned) => byLower.set(returned.toLowerCase(), list));
  for (const id of asked) {
    if (byOrder.has(id)) continue;
    const hit = byLower.get(id.toLowerCase());
    if (hit !== undefined) byOrder.set(id, hit);
  }
  return byOrder;
}

/**
 * Match a page of orders: THREE statements, in this order —
 *
 *   1. the ordered side (`readOrderItems`, one `findMany` through the frozen
 *      item select);
 *   2. the deducted side (`deductedSideSql`, rendered by the population module
 *      and issued in the `Prisma.sql` OBJECT form);
 *   3. the decomposition facts, skipped entirely when neither side names a
 *      product — a fourth statement to look up nothing is a statement spent to
 *      learn we already knew the answer.
 *
 * They are AWAITED IN SEQUENCE rather than raced: the same code runs inside the
 * order lock in P2-C, and a transaction client is not a place to issue two
 * statements at once.
 *
 * `[]` spends nothing and answers with an empty map. More than 200 orders is a
 * caller error (`RangeError`), symmetric with both readers — the caller pages.
 * Every asked id is a key of the result: an order with no items and no ledger
 * rows is the matcher's unmatchable result, never a missing key.
 */
export async function getOrderMatches(
  client: MatchReader,
  orderIds: readonly string[],
): Promise<Map<string, OrderMatch>> {
  const asked = Array.from(new Set(orderIds));
  if (asked.length > MAX_ORDERS) {
    throw new RangeError(`getOrderMatches: at most ${MAX_ORDERS} orders`);
  }
  const byOrder = new Map<string, OrderMatch>();
  if (asked.length === 0) return byOrder;

  // (1) the ordered side — the expansion rule's ONE owner.
  const items = await readOrderItems(client, asked);

  // (2) the deducted side — the population's ONE owner.
  const deducted = deductedByAskedId(
    await client.$queryRaw<DeductedSideSqlRow[]>(deductedSideSql(asked)),
    asked,
  );

  // (3) the products named by EITHER side. A product missing from this read is
  // never dropped: the matcher synthesises `unknown product` for it, which is
  // the honest answer and keeps the order's class intact.
  const productIds = new Set<number>();
  for (const id of asked) {
    const orderItems = items.get(id);
    if (orderItems !== undefined) {
      for (const line of orderItems.lines) productIds.add(line.productId);
    }
    const rows = deducted.get(id);
    if (rows !== undefined) {
      for (const row of rows) productIds.add(row.productId);
    }
  }
  const ids = Array.from(productIds).sort((a, b) => a - b);
  const products =
    ids.length === 0
      ? []
      : await client.product.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, baseName: true, unit: true, numericValue: true },
        });
  const facts: ProductFacts[] = products.map((product) => ({
    productId: product.id,
    productName: product.name,
    baseName: product.baseName,
    unit: product.unit,
    hundredths: hundredthsOf(product.numericValue),
  }));

  for (const id of asked) {
    byOrder.set(
      id,
      matchOrder({
        items: items.get(id) ?? emptyOrderItems(),
        deducted: deducted.get(id) ?? [],
        products: facts,
        // The declared substitutions are P2-D's; until then the tolerance is
        // the mass balance alone.
        declarations: [],
      }),
    );
  }
  return byOrder;
}
