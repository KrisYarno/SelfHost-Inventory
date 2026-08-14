/**
 * @jest-environment node
 *
 * W2S-1 (codex W2 dual seam check, HIGH) — every write an item makes lives
 * inside that item's SAVEPOINT.
 *
 * `fulfillExternalOrder` runs ONE transaction and catches per item, so other
 * items in the same request can still succeed. Before this fix that catch
 * swallowed LATE errors too: the stock decrement, the loc-1 mirror and the
 * stamped SALE row had already landed on the transaction, and the transaction
 * went on to COMMIT them while the item was reported as `failed`. The result
 * was a ledger row naming an order whose item was never fulfilled — attribution
 * that is worse than none, because a reconciliation would believe it.
 *
 * These pins are STATE assertions against a stand-in transaction that honours
 * MySQL savepoint semantics (SAVEPOINT snapshots, ROLLBACK TO restores, RELEASE
 * drops), in the shape the T8R-1 harness established. A mock that only records
 * calls could not see this finding at all: "the row committed" is invisible to
 * a store with no rollback.
 *
 * NOT in scope, and deliberately untouched: unfulfill (codex confirmed clean)
 * and the whole-transaction abort (T8R-1's disposition, a DIFFERENT rule — here
 * the established per-item partial semantics stay exactly as they are).
 */

import { Prisma } from '@prisma/client';

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: { $transaction: jest.fn() },
}));

let _inventoryLogImpl: (...args: any[]) => Promise<any>;
jest.mock('@/lib/inventory', () => ({
  createInventoryLog: jest.fn((...args: any[]) => _inventoryLogImpl(...args)),
}));

import prisma from '@/lib/prisma';
import { fulfillExternalOrder } from '@/lib/fulfillment';

const ORDER_ID = 'ord-1';

// ---------------------------------------------------------------------------
// The stand-in transaction: real state, real savepoints, injectable faults.
// ---------------------------------------------------------------------------

type PlRow = { productId: number; locationId: number; quantity: number; version: number };
type LogRow = {
  productId: number;
  locationId: number;
  delta: number;
  logType: string;
  batchId: string | null;
  orderRecordId: string | null;
};
type ItemRow = { id: string; fulfilledQty: number; bundleComponentSnapshot: unknown };

const plKey = (productId: number, locationId: number) => `${productId}:${locationId}`;

function makeStore(seed: {
  /** The order `fulfillExternalOrder` loads inside its transaction. */
  order: any;
  products: Array<{ id: number; name: string; quantity: number }>;
  productLocations: PlRow[];
  /**
   * Fault injection, called with the args BEFORE `externalOrderItem.update`
   * applies them. Throwing here models a statement-level failure of an item's
   * LAST write — the fulfilledQty increment, which happens after that item's
   * stock decrement, its mirror and its stamped ledger row. That is exactly the
   * W2S-1 shape: an error that is not transaction-fatal, arriving late.
   */
  onOrderItemUpdate?: (args: { where: any; data: any }) => void;
}) {
  const products = new Map<number, { id: number; name: string; quantity: number }>();
  seed.products.forEach((p) => products.set(p.id, { ...p }));
  const productLocations = new Map<string, PlRow>();
  seed.productLocations.forEach((r) => productLocations.set(plKey(r.productId, r.locationId), { ...r }));
  const orderItems = new Map<string, ItemRow>();
  (seed.order.items as any[]).forEach((i) =>
    orderItems.set(i.id, {
      id: i.id,
      fulfilledQty: i.fulfilledQty,
      bundleComponentSnapshot: i.bundleComponentSnapshot ?? null,
    })
  );
  let logs: LogRow[] = [];
  let nextLogId = 1;
  const statements: string[] = [];

  type Snap = {
    products: Map<number, { id: number; name: string; quantity: number }>;
    productLocations: Map<string, PlRow>;
    orderItems: Map<string, ItemRow>;
    logs: LogRow[];
  };

  // (Map#forEach rather than spread/for-of: this repo's tsc target predates
  // downlevel Map iteration — same note as the T8R-1 harness.)
  function snapshot(): Snap {
    const p = new Map<number, { id: number; name: string; quantity: number }>();
    products.forEach((row, key) => p.set(key, { ...row }));
    const pl = new Map<string, PlRow>();
    productLocations.forEach((row, key) => pl.set(key, { ...row }));
    const oi = new Map<string, ItemRow>();
    orderItems.forEach((row, key) => oi.set(key, { ...row }));
    return { products: p, productLocations: pl, orderItems: oi, logs: logs.slice() };
  }

  function restore(snap: Snap) {
    products.clear();
    snap.products.forEach((row, key) => products.set(key, { ...row }));
    productLocations.clear();
    snap.productLocations.forEach((row, key) => productLocations.set(key, { ...row }));
    orderItems.clear();
    snap.orderItems.forEach((row, key) => orderItems.set(key, { ...row }));
    logs = snap.logs.slice();
  }

  /** MySQL savepoint stack: name -> the state at the moment it was set. */
  const savepoints: Array<{ name: string; snap: Snap }> = [];

  const tx: any = {
    $executeRawUnsafe: async (statement: string) => {
      statements.push(statement);
      let m = /^SAVEPOINT (\w+)$/.exec(statement);
      if (m) {
        // MySQL: setting a savepoint whose name exists deletes the old one.
        const existing = savepoints.findIndex((s) => s.name === m![1]);
        if (existing !== -1) savepoints.splice(existing, 1);
        savepoints.push({ name: m[1], snap: snapshot() });
        return 0;
      }
      m = /^ROLLBACK TO SAVEPOINT (\w+)$/.exec(statement);
      if (m) {
        const idx = savepoints.map((s) => s.name).lastIndexOf(m[1]);
        // MySQL raises 1305 for an unknown savepoint. A stand-in that silently
        // accepted it would hide exactly the bug this file is about.
        if (idx === -1) throw new Error(`SAVEPOINT ${m[1]} does not exist`);
        restore(savepoints[idx].snap);
        // ROLLBACK TO keeps the named savepoint and drops the ones set after it.
        savepoints.length = idx + 1;
        return 0;
      }
      m = /^RELEASE SAVEPOINT (\w+)$/.exec(statement);
      if (m) {
        const idx = savepoints.map((s) => s.name).lastIndexOf(m[1]);
        if (idx === -1) throw new Error(`SAVEPOINT ${m[1]} does not exist`);
        savepoints.length = idx;
        return 0;
      }
      throw new Error(`unexpected raw statement: ${statement}`);
    },

    $executeRaw: async (query: Prisma.Sql) => {
      const text = query.sql;
      const values = query.values as number[];
      if (/UPDATE product_locations/.test(text)) {
        const [deductQty, productId, locationId, guard] = values;
        const row = productLocations.get(plKey(productId, locationId));
        // The atomic guard IS the stock check: `WHERE ... AND quantity >= ?`.
        if (!row || row.quantity < guard) return 0;
        row.quantity -= deductQty;
        row.version += 1;
        return 1;
      }
      if (/UPDATE products\b/.test(text)) {
        const [deductQty, productId] = values;
        const row = products.get(productId);
        if (!row) return 0;
        row.quantity -= deductQty;
        return 1;
      }
      throw new Error(`unexpected sql: ${text}`);
    },

    externalOrder: {
      findUnique: async () => seed.order,
      update: async () => ({}),
    },
    externalOrderItem: {
      update: async ({ where, data }: any) => {
        seed.onOrderItemUpdate?.({ where, data });
        const row = orderItems.get(where.id);
        if (!row) throw new Error(`no order item ${where.id}`);
        if (data.fulfilledQty?.increment) row.fulfilledQty += data.fulfilledQty.increment;
        if (data.bundleComponentSnapshot !== undefined) {
          row.bundleComponentSnapshot = data.bundleComponentSnapshot;
        }
        return { ...row };
      },
      findMany: async () => {
        const out: Array<{ quantity: number; fulfilledQty: number }> = [];
        (seed.order.items as any[]).forEach((i) =>
          out.push({ quantity: i.quantity, fulfilledQty: orderItems.get(i.id)!.fulfilledQty })
        );
        return out;
      },
    },
    product: {
      findUnique: async ({ where }: any) => {
        const row = products.get(where.id);
        return row ? { name: row.name } : null;
      },
    },
    product_locations: {
      findUnique: async ({ where }: any) => {
        const { productId, locationId } = where.productId_locationId;
        return productLocations.get(plKey(productId, locationId)) ?? null;
      },
      findMany: async ({ where }: any) => {
        const ids: number[] = where.productId?.in ?? [];
        return ids
          .map((id) => productLocations.get(plKey(id, where.locationId)))
          .filter(Boolean)
          .map((r) => ({ productId: r!.productId, quantity: r!.quantity }));
      },
    },
  };

  _inventoryLogImpl = async (data: any) => {
    logs.push({
      productId: data.productId,
      locationId: data.locationId,
      delta: data.delta,
      logType: data.logType,
      batchId: data.batchId ?? null,
      orderRecordId: data.orderRecordId ?? null,
    });
    return { id: nextLogId++ };
  };

  /** A Prisma interactive transaction that throws commits NOTHING. */
  const runTransaction = async (cb: (client: any) => Promise<any>) => {
    const snap = snapshot();
    try {
      return await cb(tx);
    } catch (error) {
      restore(snap);
      throw error;
    }
  };

  return {
    tx,
    runTransaction,
    statements,
    logsFor: (productId: number) => logs.filter((l) => l.productId === productId),
    allLogs: () => logs.slice(),
    product: (id: number) => products.get(id)!,
    productLocation: (productId: number, locationId: number) =>
      productLocations.get(plKey(productId, locationId))!,
    orderItem: (id: string) => orderItems.get(id)!,
  };
}

type Store = ReturnType<typeof makeStore>;

function drive(store: Store) {
  (prisma.$transaction as unknown as jest.Mock).mockImplementation(async (cb: any) =>
    store.runTransaction(cb)
  );
}

// ---------------------------------------------------------------------------
// Order fixtures
// ---------------------------------------------------------------------------

function singleLine(over: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    orderId: ORDER_ID,
    quantity: 5,
    fulfilledQty: 0,
    name: 'Widget A',
    sku: 'WA-001',
    isMapped: true,
    bundleComponentSnapshot: null,
    productLink: {
      isBundle: false,
      internalProduct: { id: 10, name: 'Widget A' },
      bundleComponents: [],
    },
    ...over,
  };
}

function bundleLine(over: Record<string, unknown> = {}) {
  return {
    id: 'item-b',
    orderId: ORDER_ID,
    quantity: 1,
    fulfilledQty: 0,
    name: 'Recovery Bundle',
    sku: null,
    isMapped: true,
    bundleComponentSnapshot: [
      { internalProductId: 21, internalProductName: 'Alpha', quantity: 1, sortOrder: 0 },
      { internalProductId: 22, internalProductName: 'Beta', quantity: 2, sortOrder: 1 },
    ],
    productLink: {
      isBundle: true,
      internalProduct: null,
      bundleComponents: [],
    },
    ...over,
  };
}

function order(items: any[]) {
  return {
    id: ORDER_ID,
    externalId: 'ext-1',
    integrationId: 'int-1',
    fulfilledAt: null,
    fulfilledBy: null,
    integration: { id: 'int-1', platform: 'WOOCOMMERCE', fulfillmentPushEnabled: false },
    items,
  };
}

/** The late failure: the item's fulfilledQty increment, and nothing else. */
function lateFailureOn(itemId: string) {
  return ({ where, data }: { where: any; data: any }) => {
    if (where.id !== itemId || data.fulfilledQty === undefined) return;
    const error: any = new Error('fulfilledQty update failed');
    error.code = 'P2025';
    throw error;
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe('W2S-1 — a failed item commits nothing', () => {
  it('PIN W2S-1a: a LATE failure on an ordinary item leaves no stock change, no ledger row, no stamp', async () => {
    const store = makeStore({
      order: order([singleLine(), singleLine({ id: 'item-2', quantity: 3, productLink: {
        isBundle: false,
        internalProduct: { id: 20, name: 'Widget B' },
        bundleComponents: [],
      } })]),
      products: [
        { id: 10, name: 'Widget A', quantity: 100 },
        { id: 20, name: 'Widget B', quantity: 100 },
      ],
      productLocations: [
        { productId: 10, locationId: 1, quantity: 100, version: 1 },
        { productId: 20, locationId: 1, quantity: 100, version: 1 },
      ],
      onOrderItemUpdate: lateFailureOn('item-1'),
    });
    drive(store);

    const result = await fulfillExternalOrder(
      ORDER_ID,
      1,
      [
        { itemId: 'item-1', quantity: 5 },
        { itemId: 'item-2', quantity: 3 },
      ],
      42
    );

    // The item is reported failed — and NOTHING of it survived.
    expect(result.failed.map((f) => f.itemId)).toEqual(['item-1']);
    expect(store.productLocation(10, 1)).toMatchObject({ quantity: 100, version: 1 });
    expect(store.product(10).quantity).toBe(100); // the loc-1 mirror, likewise
    expect(store.logsFor(10)).toHaveLength(0); // no SALE row claiming this order
    expect(store.orderItem('item-1').fulfilledQty).toBe(0);
    expect(result.fulfilled.map((f) => f.itemId)).not.toContain('item-1');
    expect(result.inventoryLogIds).toHaveLength(1);

    // The established per-item partial semantics are UNCHANGED: the other item
    // in the same request committed exactly as before.
    expect(result.fulfilled.map((f) => f.itemId)).toEqual(['item-2']);
    expect(store.productLocation(20, 1)).toMatchObject({ quantity: 97, version: 2 });
    expect(store.logsFor(20)).toHaveLength(1);
    expect(store.logsFor(20)[0]).toMatchObject({ logType: 'SALE', orderRecordId: ORDER_ID });
    expect(store.orderItem('item-2').fulfilledQty).toBe(3);
  });

  it('PIN W2S-1b: a LATE failure on a BUNDLE item rolls back every component', async () => {
    const store = makeStore({
      order: order([
        bundleLine(),
        singleLine({ id: 'item-2', quantity: 3, productLink: {
          isBundle: false,
          internalProduct: { id: 20, name: 'Widget B' },
          bundleComponents: [],
        } }),
      ]),
      products: [
        { id: 21, name: 'Alpha', quantity: 100 },
        { id: 22, name: 'Beta', quantity: 100 },
        { id: 20, name: 'Widget B', quantity: 100 },
      ],
      productLocations: [
        { productId: 21, locationId: 1, quantity: 100, version: 1 },
        { productId: 22, locationId: 1, quantity: 100, version: 1 },
        { productId: 20, locationId: 1, quantity: 100, version: 1 },
      ],
      onOrderItemUpdate: lateFailureOn('item-b'),
    });
    drive(store);

    const result = await fulfillExternalOrder(
      ORDER_ID,
      1,
      [
        { itemId: 'item-b', quantity: 1 },
        { itemId: 'item-2', quantity: 3 },
      ],
      42
    );

    // The bundle's own savepoint was RELEASED before this failure — the item
    // savepoint is what has to catch it.
    expect(result.failed.map((f) => f.itemId)).toEqual(['item-b']);
    expect(store.productLocation(21, 1)).toMatchObject({ quantity: 100, version: 1 });
    expect(store.productLocation(22, 1)).toMatchObject({ quantity: 100, version: 1 });
    expect(store.product(21).quantity).toBe(100);
    expect(store.product(22).quantity).toBe(100);
    expect(store.logsFor(21)).toHaveLength(0);
    expect(store.logsFor(22)).toHaveLength(0);
    expect(store.orderItem('item-b').fulfilledQty).toBe(0);
    // A component id here would push WC stock for a deduction that never happened.
    expect(result.affectedComponentIds).toEqual([]);

    // Sibling unaffected.
    expect(result.fulfilled.map((f) => f.itemId)).toEqual(['item-2']);
    expect(store.productLocation(20, 1)).toMatchObject({ quantity: 97, version: 2 });
  });

  it('PIN W2S-1c: the success path is unchanged — savepoint opened, RELEASEd, never rolled back', async () => {
    const store = makeStore({
      order: order([singleLine()]),
      products: [{ id: 10, name: 'Widget A', quantity: 100 }],
      productLocations: [{ productId: 10, locationId: 1, quantity: 100, version: 1 }],
    });
    drive(store);

    const result = await fulfillExternalOrder(
      ORDER_ID,
      1,
      [{ itemId: 'item-1', quantity: 5 }],
      42,
      undefined,
      undefined,
      'batch-1'
    );

    expect(result.failed).toHaveLength(0);
    expect(result.fulfilled).toHaveLength(1);
    expect(store.productLocation(10, 1)).toMatchObject({ quantity: 95, version: 2 });
    expect(store.product(10).quantity).toBe(95);
    expect(store.logsFor(10)).toEqual([
      {
        productId: 10,
        locationId: 1,
        delta: -5,
        logType: 'SALE',
        batchId: 'batch-1',
        orderRecordId: ORDER_ID,
      },
    ]);
    expect(store.orderItem('item-1').fulfilledQty).toBe(5);

    expect(store.statements.some((s) => /^SAVEPOINT /.test(s))).toBe(true);
    expect(store.statements.some((s) => /^RELEASE SAVEPOINT /.test(s))).toBe(true);
    expect(store.statements.some((s) => /^ROLLBACK TO SAVEPOINT /.test(s))).toBe(false);
  });

  it('PIN W2S-1d: an item that writes nothing issues no savepoint statement at all', async () => {
    const store = makeStore({
      order: order([singleLine({ isMapped: false, productLink: null })]),
      products: [{ id: 10, name: 'Widget A', quantity: 100 }],
      productLocations: [{ productId: 10, locationId: 1, quantity: 100, version: 1 }],
    });
    drive(store);

    const result = await fulfillExternalOrder(ORDER_ID, 1, [{ itemId: 'item-1', quantity: 5 }], 42);

    expect(result.skipped[0]).toMatchObject({ itemId: 'item-1', reason: 'unmapped' });
    // The savepoint is taken at the first WRITE, so the decline paths cost
    // nothing — the shape the pre-existing bundle pins already assume.
    expect(store.statements).toEqual([]);
  });

  it('PIN W2S-1e: a PRE-write failure still fails only its own item', async () => {
    // The product row is gone: ProductNotFoundError throws before any write.
    const store = makeStore({
      order: order([
        singleLine(),
        singleLine({ id: 'item-2', quantity: 3, productLink: {
          isBundle: false,
          internalProduct: { id: 20, name: 'Widget B' },
          bundleComponents: [],
        } }),
      ]),
      products: [{ id: 20, name: 'Widget B', quantity: 100 }],
      productLocations: [
        { productId: 10, locationId: 1, quantity: 100, version: 1 },
        { productId: 20, locationId: 1, quantity: 100, version: 1 },
      ],
    });
    drive(store);

    const result = await fulfillExternalOrder(
      ORDER_ID,
      1,
      [
        { itemId: 'item-1', quantity: 5 },
        { itemId: 'item-2', quantity: 3 },
      ],
      42
    );

    expect(result.failed.map((f) => f.itemId)).toEqual(['item-1']);
    expect(store.productLocation(10, 1)).toMatchObject({ quantity: 100, version: 1 });
    expect(result.fulfilled.map((f) => f.itemId)).toEqual(['item-2']);
    // No rollback statement was needed: nothing had been written for item-1.
    expect(store.statements.some((s) => /^ROLLBACK TO SAVEPOINT /.test(s))).toBe(false);
  });
});
