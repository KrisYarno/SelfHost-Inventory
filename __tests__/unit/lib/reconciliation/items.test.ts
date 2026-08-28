// @jest-environment node
//
// Reconciliation lane Part 2, A1 (spec REV-8 §2.1/§2.2, pack CA1.3) — THE
// ORDER-ITEMS READ.
//
// This is the ordered side of the match, and it is the only place in the lane
// that touches `external_order_items` — a table whose row carries the customer's
// variant string. Two layers, the same two the lane already runs on orders:
// the frozen SELECT is what SHOULD reach the reader (pinned by deep equality
// and by call-site identity, so a hand-written select at the call site fails),
// and the ITEM-SHAPE pin is what proves nothing else did — a resolved bundle
// component arrives carrying `internalProductName` and must not leave with it.
//
// The expansion rule is SERVER truth (the workbench's client labels are
// display only), so both unmapped branches are pinned here: `isMapped === false`
// and a mapped non-bundle link with no internal product. Neither becomes a
// zero-quantity product; both are COUNTERS beside the lines.
import fs from 'node:fs';
import path from 'node:path';

import { resolveBundleComponents } from '@/lib/external-orders/bundle-snapshot';
import {
  RECONCILIATION_ITEM_SELECT,
  expandOrderItems,
  readOrderItems,
  type ItemReader,
  type ReconciliationItemRow,
} from '@/lib/reconciliation/items';

// --------------------------------------------------------------------------
// Fixtures — rows exactly as the frozen select returns them.
// --------------------------------------------------------------------------

type RowInput = {
  id: string;
  orderId: string;
  quantity: number;
  fulfilledQty?: number;
  isMapped?: boolean;
  productLinkId?: string | null;
  bundleComponentSnapshot?: unknown;
  productLink?: {
    internalProductId: number | null;
    isBundle: boolean;
    bundleComponents: Array<{ internalProductId: number; quantity: number; sortOrder: number }>;
  } | null;
};

function row(input: RowInput): ReconciliationItemRow {
  return {
    id: input.id,
    orderId: input.orderId,
    quantity: input.quantity,
    fulfilledQty: input.fulfilledQty ?? 0,
    isMapped: input.isMapped ?? true,
    productLinkId: input.productLinkId ?? (input.productLink === null ? null : 'link-1'),
    bundleComponentSnapshot: input.bundleComponentSnapshot ?? null,
    productLink:
      input.productLink === undefined
        ? { internalProductId: 1, isBundle: false, bundleComponents: [] }
        : input.productLink,
  } as unknown as ReconciliationItemRow;
}

function reader(rows: ReconciliationItemRow[]) {
  const findMany = jest.fn().mockResolvedValue(rows);
  return { client: { externalOrderItem: { findMany } } as unknown as ItemReader, findMany };
}

// --------------------------------------------------------------------------
// Layer 1 — the frozen select
// --------------------------------------------------------------------------

describe('RECONCILIATION_ITEM_SELECT — the projection, by SHAPE', () => {
  it('is exactly the literal spec §2.1 spells out (never name, sku, price or the external ids)', () => {
    expect(RECONCILIATION_ITEM_SELECT).toEqual({
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
    });
  });

  it('carries none of the forbidden item columns', () => {
    const keys = Object.keys(RECONCILIATION_ITEM_SELECT);
    for (const forbidden of [
      'name',
      'variantName',
      'sku',
      'price',
      'externalProductId',
      'externalVariantId',
      'externalItemId',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('is deep-frozen — an allowlist that can be widened at runtime is a suggestion', () => {
    expect(Object.isFrozen(RECONCILIATION_ITEM_SELECT)).toBe(true);
    expect(Object.isFrozen(RECONCILIATION_ITEM_SELECT.productLink)).toBe(true);
    expect(Object.isFrozen(RECONCILIATION_ITEM_SELECT.productLink.select)).toBe(true);
    expect(
      Object.isFrozen(RECONCILIATION_ITEM_SELECT.productLink.select.bundleComponents),
    ).toBe(true);
    expect(
      Object.isFrozen(RECONCILIATION_ITEM_SELECT.productLink.select.bundleComponents.select),
    ).toBe(true);
    expect(
      Object.isFrozen(RECONCILIATION_ITEM_SELECT.productLink.select.bundleComponents.orderBy),
    ).toBe(true);
  });
});

// --------------------------------------------------------------------------
// The statement
// --------------------------------------------------------------------------

describe('readOrderItems — ONE statement, the frozen select, the asked ids', () => {
  it('spends exactly one findMany, with the select BY IDENTITY and the pinned orderBy', async () => {
    const { client, findMany } = reader([]);
    await readOrderItems(client, ['o1', 'o2']);
    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0];
    expect(arg.select).toBe(RECONCILIATION_ITEM_SELECT);
    expect(arg.where).toEqual({ orderId: { in: ['o1', 'o2'] } });
    expect(arg.orderBy).toEqual([{ orderId: 'asc' }, { id: 'asc' }]);
  });

  it('dedupes the asked ids before asking', async () => {
    const { client, findMany } = reader([]);
    await readOrderItems(client, ['o1', 'o2', 'o1', 'o2', 'o1']);
    expect(findMany.mock.calls[0][0].where).toEqual({ orderId: { in: ['o1', 'o2'] } });
  });

  it('an EMPTY id list spends ZERO statements and returns an empty map', async () => {
    const { client, findMany } = reader([]);
    const map = await readOrderItems(client, []);
    expect(findMany).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });

  it('refuses more than 200 orders (symmetric with the aggregate builder)', async () => {
    const { client, findMany } = reader([]);
    const ids = Array.from({ length: 201 }, (_, i) => `o${i}`);
    await expect(readOrderItems(client, ids)).rejects.toThrow(RangeError);
    await expect(readOrderItems(client, ids)).rejects.toThrow(
      'readOrderItems: at most 200 orders',
    );
    expect(findMany).not.toHaveBeenCalled();
    await expect(
      readOrderItems(client, Array.from({ length: 200 }, (_, i) => `o${i}`)),
    ).resolves.toBeInstanceOf(Map);
  });

  it('keys the map by the ASKED id even when MySQL matched it case-insensitively', async () => {
    // `inventory_logs.orderRecordId` is a soft ref and the column collation is
    // utf8mb4_unicode_ci, so an id asked as 'ORD-1' comes back spelled 'ord-1'.
    // A map keyed only by the returned spelling would report the order as having
    // no items at all (the FD-1 class, read-path twin).
    const { client } = reader([row({ id: 'i1', orderId: 'ord-1', quantity: 2 })]);
    const map = await readOrderItems(client, ['ORD-1']);
    expect(map.has('ORD-1')).toBe(true);
    expect(map.get('ORD-1')?.lines).toHaveLength(1);
  });

  it('gives EVERY asked id a key — an order with no rows is the empty OrderItems', async () => {
    const { client } = reader([row({ id: 'i1', orderId: 'o1', quantity: 1 })]);
    const map = await readOrderItems(client, ['o1', 'o2']);
    expect(map.get('o2')).toEqual({
      lines: [],
      unmappedLines: 0,
      unmappedUnits: 0,
      bundleLines: 0,
      unresolvableBundleLines: 0,
    });
  });

  it('never overwrites a first-pass hit with a case-folded one', async () => {
    const { client } = reader([
      row({ id: 'i1', orderId: 'o1', quantity: 1 }),
      row({ id: 'i2', orderId: 'O1', quantity: 5 }),
    ]);
    const map = await readOrderItems(client, ['o1']);
    expect(map.get('o1')?.lines[0].quantity).toBe(1);
  });
});

// --------------------------------------------------------------------------
// The expansion rule (spec §2.2 — SERVER truth)
// --------------------------------------------------------------------------

describe('expandOrderItems — the ordered-side predicate', () => {
  it('a mapped non-bundle line becomes ONE OrderedLine with exactly five keys', () => {
    const items = expandOrderItems([
      row({ id: 'i1', orderId: 'o1', quantity: 3, fulfilledQty: 1 }),
    ]).get('o1');
    expect(items?.lines).toEqual([
      { productId: 1, quantity: 3, fulfilledQty: 1, fromBundle: false, itemId: 'i1' },
    ]);
    expect(Object.keys(items!.lines[0]).sort()).toEqual([
      'fromBundle',
      'fulfilledQty',
      'itemId',
      'productId',
      'quantity',
    ]);
  });

  it('branch 1: isMapped === false is UNMAPPED — a counter, never a zero-quantity product', () => {
    const items = expandOrderItems([
      row({ id: 'i1', orderId: 'o1', quantity: 4, isMapped: false }),
    ]).get('o1');
    expect(items).toEqual({
      lines: [],
      unmappedLines: 1,
      unmappedUnits: 4,
      bundleLines: 0,
      unresolvableBundleLines: 0,
    });
  });

  it('branch 1: a null productLink is UNMAPPED too (the link was deleted under the row)', () => {
    const items = expandOrderItems([
      row({ id: 'i1', orderId: 'o1', quantity: 2, productLink: null }),
    ]).get('o1');
    expect(items).toMatchObject({ lines: [], unmappedLines: 1, unmappedUnits: 2 });
  });

  it('branch 3: a MAPPED non-bundle link with no internal product is unmapped-FOR-MATCHING', () => {
    const items = expandOrderItems([
      row({
        id: 'i1',
        orderId: 'o1',
        quantity: 5,
        isMapped: true,
        productLink: { internalProductId: null, isBundle: false, bundleComponents: [] },
      }),
    ]).get('o1');
    expect(items).toEqual({
      lines: [],
      unmappedLines: 1,
      unmappedUnits: 5,
      bundleLines: 0,
      unresolvableBundleLines: 0,
    });
  });

  it('an order with no rows at all is absent from the pure expansion (readOrderItems adds the key)', () => {
    expect(expandOrderItems([]).size).toBe(0);
  });
});

describe('expandOrderItems — bundle expansion, the fulfil path way', () => {
  const SNAPSHOT = [
    { internalProductId: 7, internalProductName: 'Component A', quantity: 3, sortOrder: 0 },
    { internalProductId: 8, internalProductName: 'Component B', quantity: 1, sortOrder: 1 },
  ];

  function bundleRow(over: Partial<RowInput> = {}): ReconciliationItemRow {
    return row({
      id: 'b1',
      orderId: 'o1',
      quantity: 2,
      fulfilledQty: 1,
      bundleComponentSnapshot: SNAPSHOT,
      productLink: {
        internalProductId: null,
        isBundle: true,
        bundleComponents: [{ internalProductId: 99, quantity: 5, sortOrder: 0 }],
      },
      ...over,
    });
  }

  it('multiplies line quantity by component quantity (2 x 3 = 6) and counts the bundle line', () => {
    const items = expandOrderItems([bundleRow()]).get('o1');
    expect(items?.bundleLines).toBe(1);
    expect(items?.unresolvableBundleLines).toBe(0);
    expect(items?.lines).toEqual([
      { productId: 7, quantity: 6, fulfilledQty: 3, fromBundle: true, itemId: 'b1' },
      { productId: 8, quantity: 2, fulfilledQty: 1, fromBundle: true, itemId: 'b1' },
    ]);
  });

  it('PREFERS the frozen snapshot over the live components', () => {
    const items = expandOrderItems([bundleRow()]).get('o1');
    expect(items?.lines.map((l) => l.productId)).toEqual([7, 8]);
    expect(items?.lines.map((l) => l.productId)).not.toContain(99);
  });

  it('falls back to the LIVE components when the snapshot is null (legacy rows)', () => {
    const items = expandOrderItems([bundleRow({ bundleComponentSnapshot: null })]).get('o1');
    expect(items?.lines).toEqual([
      { productId: 99, quantity: 10, fulfilledQty: 5, fromBundle: true, itemId: 'b1' },
    ]);
  });

  it('a MALFORMED snapshot is COUNTED, never fatal — the order still classifies', () => {
    const items = expandOrderItems([
      bundleRow({ bundleComponentSnapshot: [{ internalProductId: 'not-a-number' }] }),
      row({ id: 'i2', orderId: 'o1', quantity: 1 }),
    ]).get('o1');
    expect(items?.unresolvableBundleLines).toBe(1);
    expect(items?.bundleLines).toBe(0);
    expect(items?.lines).toEqual([
      { productId: 1, quantity: 1, fulfilledQty: 0, fromBundle: false, itemId: 'i2' },
    ]);
  });

  it('an EMPTY live component set with no snapshot is unresolvable', () => {
    const items = expandOrderItems([
      bundleRow({
        bundleComponentSnapshot: null,
        productLink: { internalProductId: null, isBundle: true, bundleComponents: [] },
      }),
    ]).get('o1');
    expect(items?.unresolvableBundleLines).toBe(1);
    expect(items?.lines).toEqual([]);
  });

  it('POSITIVE CONTROL: the resolver DOES emit internalProductName, and no line carries it', () => {
    const resolved = resolveBundleComponents(SNAPSHOT, null);
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.components[0].internalProductName).toBe('Component A');

    const items = expandOrderItems([bundleRow()]).get('o1');
    for (const l of items!.lines) {
      expect(Object.keys(l)).not.toContain('internalProductName');
      expect(JSON.stringify(l)).not.toContain('Component A');
    }
  });

  it('groups rows by order and keeps each order independent', () => {
    const map = expandOrderItems([
      row({ id: 'i1', orderId: 'o1', quantity: 1 }),
      row({ id: 'i2', orderId: 'o2', quantity: 2, isMapped: false }),
    ]);
    expect(map.get('o1')?.lines).toHaveLength(1);
    expect(map.get('o2')).toMatchObject({ lines: [], unmappedLines: 1, unmappedUnits: 2 });
  });
});

// --------------------------------------------------------------------------
// The read-path rule, on this module's own source
// --------------------------------------------------------------------------

describe('the module stays on the read path (pack cross-wave rule 2)', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../../../lib/reconciliation/items.ts'),
    'utf8',
  );

  it('carries no Prisma write-method token, comments included', () => {
    const re =
      /\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|\$(executeRaw|executeRawUnsafe|queryRawUnsafe)\b/g;
    expect(src.match(re)).toBeNull();
  });

  it('names neither the manual-attribution core nor the attempt writer', () => {
    expect(src).not.toContain('attribute-batch');
    expect(src).not.toContain('lib/attribution/attempts');
  });
});
