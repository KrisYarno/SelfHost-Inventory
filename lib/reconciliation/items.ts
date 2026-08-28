/**
 * THE ORDER-ITEMS READ (reconciliation lane Part 2, spec REV-8 §2.1/§2.2;
 * pack CA1.3) — the matcher's ORDERED side.
 *
 * One frozen select, one statement per page, and the expansion rule spelled
 * ONCE (pack cross-wave rule 8: the ordered-side predicate lives here and
 * nowhere else). The workbench's client-side labels answer the same question
 * for a human filling an order; they are display, and this is the SERVER's
 * truth — a second spelling would be a second definition of "what the order
 * asked for", and two of those produce two honest reports that disagree.
 *
 * PII: `external_order_items` carries the customer's variant string, so the
 * select is an allowlist frozen at module load, and the bundle resolver's
 * `internalProductName` is dropped AT THIS BOUNDARY — an `OrderedLine` is ids
 * and integers, never a name (pack rule 5, and the item-shape pin proves it).
 *
 * Next-free and textually write-free (pack cross-wave rule 2): this module is
 * on the assistant's read path.
 */

import type { Prisma } from '@prisma/client';

import { resolveBundleComponents } from '@/lib/external-orders/bundle-snapshot';

import { deepFreeze } from './pii';
import type { OrderItems, OrderedLine } from './match';

/**
 * THE item projection. `bundleComponentSnapshot` is the frozen composition the
 * fulfil path wrote; `productLink.bundleComponents` is the live fallback for
 * rows that pre-date it. Never `name`, `variantName`, `sku`, `price` or either
 * external id.
 */
export const RECONCILIATION_ITEM_SELECT = deepFreeze({
  id: true,
  orderId: true,
  quantity: true,
  fulfilledQty: true,
  isMapped: true,
  productLinkId: true,
  bundleComponentSnapshot: true,
  productLink: {
    select: {
      internalProductId: true,
      isBundle: true,
      bundleComponents: {
        select: { internalProductId: true, quantity: true, sortOrder: true },
        orderBy: { sortOrder: 'asc' },
      },
    },
  },
} as const);

export type ReconciliationItemRow = Prisma.ExternalOrderItemGetPayload<{
  select: typeof RECONCILIATION_ITEM_SELECT;
}>;

/**
 * The reader's client — the singleton OR a transaction client, because the
 * exception decider (P2-C) runs this read inside the order lock.
 */
export type ItemReader = Pick<Prisma.TransactionClient, 'externalOrderItem'>;

/** At most this many orders per read; the caller pages (spec §2.0, D2). */
const MAX_ORDERS = 200;

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
 * PURE: rows (any order) into per-order `OrderItems`. Exported for the pins,
 * and because the rule is the contract — see the module header.
 *
 * Per row, IN THIS ORDER (spec §2.2):
 *   1. `isMapped === false` or no link at all: unmapped (a counter);
 *   2. a BUNDLE link: resolve the components and multiply
 *      `line.quantity x component.quantity` (the fulfil path's arithmetic); an
 *      unresolvable one is COUNTED, never fatal to the order;
 *   3. a mapped link with no internal product: unmapped FOR MATCHING — the
 *      second branch of the formula, and never a zero-quantity product;
 *   4. otherwise one ordered line.
 */
export function expandOrderItems(
  rows: readonly ReconciliationItemRow[],
): Map<string, OrderItems> {
  const byOrder = new Map<string, OrderItems>();

  for (const r of rows) {
    let items = byOrder.get(r.orderId);
    if (items === undefined) {
      items = emptyOrderItems();
      byOrder.set(r.orderId, items);
    }

    if (r.isMapped === false || r.productLink === null) {
      items.unmappedLines += 1;
      items.unmappedUnits += r.quantity;
      continue;
    }

    if (r.productLink.isBundle) {
      const resolved = resolveBundleComponents(
        r.bundleComponentSnapshot,
        Array.from(r.productLink.bundleComponents),
      );
      if (!resolved.ok) {
        items.unresolvableBundleLines += 1;
        continue;
      }
      items.bundleLines += 1;
      for (const c of resolved.components) {
        // ids and integers only: the resolver's `internalProductName` stops here
        const line: OrderedLine = {
          productId: c.internalProductId,
          quantity: r.quantity * c.quantity,
          fulfilledQty: r.fulfilledQty * c.quantity,
          fromBundle: true,
          itemId: r.id,
        };
        items.lines.push(line);
      }
      continue;
    }

    if (r.productLink.internalProductId === null) {
      items.unmappedLines += 1;
      items.unmappedUnits += r.quantity;
      continue;
    }

    items.lines.push({
      productId: r.productLink.internalProductId,
      quantity: r.quantity,
      fulfilledQty: r.fulfilledQty,
      fromBundle: false,
      itemId: r.id,
    });
  }

  return byOrder;
}

/**
 * ONE statement for the page's orders.
 *
 * THE MAP IS KEYED BY THE ID THAT WAS ASKED (the FD-1 idiom): the ledger's
 * `orderRecordId` is a soft ref and MySQL matches `IN (...)` case-insensitively
 * under utf8mb4_unicode_ci, so a variant-spelled stamp finds its rows but comes
 * back spelled the database's way. A map keyed only by the returned spelling
 * would tell an admin the order has no lines at all. A first pass keys by the
 * returned `orderId`; a lowercase pass then fills every asked id still absent,
 * overwriting nothing. Every asked id ends up a key — an order with no rows is
 * the empty `OrderItems`, which the matcher reads as unmatchable.
 */
export async function readOrderItems(
  client: ItemReader,
  orderIds: readonly string[],
): Promise<Map<string, OrderItems>> {
  const asked = Array.from(new Set(orderIds));
  if (asked.length > MAX_ORDERS) {
    throw new RangeError(`readOrderItems: at most ${MAX_ORDERS} orders`);
  }
  if (asked.length === 0) return new Map<string, OrderItems>();

  const rows = (await client.externalOrderItem.findMany({
    where: { orderId: { in: asked } },
    select: RECONCILIATION_ITEM_SELECT,
    orderBy: [{ orderId: 'asc' }, { id: 'asc' }],
  })) as unknown as ReconciliationItemRow[];

  const byOrder = expandOrderItems(rows);

  const byLower = new Map<string, OrderItems>();
  byOrder.forEach((items, returned) => byLower.set(returned.toLowerCase(), items));
  for (const id of asked) {
    if (byOrder.has(id)) continue;
    byOrder.set(id, byLower.get(id.toLowerCase()) ?? emptyOrderItems());
  }

  return byOrder;
}
