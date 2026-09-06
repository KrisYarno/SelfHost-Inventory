/**
 * @jest-environment node
 *
 * P2-B1.5 / DR-1 (pack CB1.5a-i) — THE SAVEPOINT-FREE TWO-PASS FULFIL.
 *
 * MySQL's prepared-statement protocol refuses `SAVEPOINT` / `ROLLBACK TO` /
 * `RELEASE` (ER 1295) and Prisma has no COM_QUERY escape, so the W2S-1 per-item
 * savepoint design threw at every real item's FIRST write: every fulfil item
 * landed in `failed[]` carrying the 1295 text. Nobody saw it because prod has
 * zero fulfilment attempts and both consumers report any 200 as success.
 *
 * The redesign separates deciding from writing, the way unfulfill already does:
 * PASS 1 decides and writes nothing to `product_locations` (its one write is the
 * bundle snapshot freeze); ONE batched `products` read proves every survivor's
 * ids and supplies the names; THE PRELOCK takes every survivor key — bundle
 * COMPONENTS included — in the canonical order; PASS 2a guards every survivor
 * against a within-tx tally seeded from the prelock (a refusal spends no stock /
 * ledger / `fulfilledQty` statement and quotes the LOCKED number); PASS 2b writes
 * the winners unguarded, and any throw after statement 1 aborts the whole
 * request. W2S-1's "a failed item commits nothing" becomes the strictly stronger
 * "a failed WRITE commits nothing".
 *
 * The stand-in store keeps its state model and its `runTransaction` (snapshot at
 * entry, restore on throw) and DROPS the savepoint stack: `$executeRawUnsafe`
 * now THROWS the engine's own 1295 answer on any statement, so a fulfil that
 * still issues one fails exactly the way prod does.
 */

import fs from 'fs';
import path from 'path';
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
import {
  fulfillExternalOrder,
  planPass2,
  type Survivor,
  type Winner,
} from '@/lib/fulfillment';
import { MAX_PRELOCK_KEYS, prelockKey, type PrelockedRow } from '@/lib/inventory/prelock';
import { AppError, ProductNotFoundError } from '@/lib/error-handling';

const ORDER_ID = 'ord-1';
const FULFILLMENT_SOURCE = path.join(process.cwd(), 'lib', 'fulfillment.ts');

// ---------------------------------------------------------------------------
// THE RECORDING RAW TRIO (pack CB0.3, the per-suite paragraph).
//
// This suite declares its OWN `@/lib/prisma` factory and hands the fulfilment
// path a stand-in transaction, so the global harness's trio never reaches it.
// Two layers, as everywhere else in B1: the OUTER fn always records and then
// delegates to an INNER behaviour fn — here the store's own implementation, so
// the state semantics these pins exist for are kept verbatim while every
// statement still lands in `rawCalls`.
// ---------------------------------------------------------------------------
type RawCall = { kind: 'query' | 'execute' | 'executeUnsafe'; sql: string; at: number };

/** Every raw statement the test under way has spent, in call order. */
const rawCalls: RawCall[] = [];
/** The INNER behaviour fns, by method name. */
const rawBehavior: Record<string, jest.Mock> = {};
/** The OUTER recording fns — for `invocationCallOrder` against the delegates. */
const rawFns: Record<string, jest.Mock> = {};
let rawSeq = 0;

function sqlTextOf(arg: unknown): string {
  return arg && typeof arg === 'object' && typeof (arg as { sql?: unknown }).sql === 'string'
    ? (arg as { sql: string }).sql
    : String(arg);
}

function installRecordingRaw(
  impls: Record<string, (...args: any[]) => Promise<unknown>>
): Record<string, jest.Mock> {
  const out: Record<string, jest.Mock> = {};
  const install = (kind: RawCall['kind'], method: string) => {
    const behavior = jest.fn(impls[method]);
    const recording = jest.fn((...args: any[]) => {
      rawCalls.push({ kind, sql: sqlTextOf(args[0]), at: rawSeq++ });
      return behavior(...args);
    });
    rawBehavior[method] = behavior;
    rawFns[method] = recording;
    out[method] = recording;
  };
  install('query', '$queryRaw');
  install('execute', '$executeRaw');
  install('executeUnsafe', '$executeRawUnsafe');
  return out;
}

/** The prelock's returning SELECT (lib/inventory/prelock.ts), by its text. */
function isPrelockSelect(sql: string): boolean {
  return sql.includes('FROM product_locations') && sql.includes('(productId, locationId) IN');
}

/** The order lock's SELECT (lib/inventory/order-lock.ts), by its text. */
function isOrderLockSelect(sql: string): boolean {
  return sql.includes('FROM external_orders') && sql.includes('FOR UPDATE');
}

// ---------------------------------------------------------------------------
// The stand-in transaction: real state, injectable faults, NO savepoints.
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
  /**
   * The `products` rows this store knows. `deletedAt` is honoured by the batched
   * read exactly as the engine honours it (OC-5): a soft-deleted row is simply
   * absent from the answer, because unfulfill refuses to restore one.
   */
  products: Array<{ id: number; name: string; quantity: number; deletedAt?: Date | null }>;
  productLocations: PlRow[];
  /** The location ids `tx.location.findUnique` will answer for (OC-4). */
  locations?: number[];
  /**
   * Fault injection, called with the args BEFORE `externalOrderItem.update`
   * applies them. Throwing here models a statement-level failure of a winner's
   * LAST write — the fulfilledQty increment, which happens after that winner's
   * stock decrement and its stamped ledger row. Under the two-pass
   * design that failure is no longer survivable: it aborts the request.
   */
  onOrderItemUpdate?: (args: { where: any; data: any }) => void;
  /**
   * TP-6: the store LIES. Return a number to override what the atomic UPDATE
   * reports (0 = "the row moved under the tally", which cannot happen on a real
   * engine because the row is X-held from the prelock to commit); throw to model
   * a statement-level failure inside pass 2b.
   */
  onStockUpdate?: (args: {
    productId: number;
    locationId: number;
    units: number;
  }) => number | void;
}) {
  const products = new Map<
    number,
    { id: number; name: string; quantity: number; deletedAt?: Date | null }
  >();
  seed.products.forEach((p) => products.set(p.id, { ...p }));
  const locations = new Set<number>(seed.locations ?? [1]);
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
    products: Map<number, { id: number; name: string; quantity: number; deletedAt?: Date | null }>;
    productLocations: Map<string, PlRow>;
    orderItems: Map<string, ItemRow>;
    logs: LogRow[];
  };

  // (Map#forEach rather than spread/for-of: this repo's tsc target predates
  // downlevel Map iteration — same note as the T8R-1 harness.)
  function snapshot(): Snap {
    const p = new Map<
      number,
      { id: number; name: string; quantity: number; deletedAt?: Date | null }
    >();
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

  const rawImpls: Record<string, (...args: any[]) => Promise<any>> = {
    // THE ENGINE'S OWN ANSWER (DR-1). MySQL refuses savepoint statements through
    // the prepared-statement protocol, so ANY statement that arrives here is a
    // fulfil that has not been rewritten — and it fails the way prod does.
    $executeRawUnsafe: async (statement: string) => {
      statements.push(statement);
      throw new Error('SAVEPOINT is not allowed in stored procedures (ER 1295)');
    },

    $executeRaw: async (query: Prisma.Sql) => {
      const text = query.sql;
      const values = query.values as number[];
      if (/INSERT INTO product_locations/.test(text)) {
        // The MATERIALIZE half of the canonical prelock. ODKU `version =
        // version` leaves an existing row exactly as it is (updatedAt included);
        // a missing key is created at the live column defaults, which is what
        // makes `{ 0, 0 }` a value a guard can read instead of an absence.
        // VALUES ride as (productId, locationId, 0, 0, NOW()) per row.
        for (let i = 0; i < values.length; i += 2) {
          const key = plKey(values[i], values[i + 1]);
          if (!productLocations.has(key)) {
            productLocations.set(key, {
              productId: values[i],
              locationId: values[i + 1],
              quantity: 0,
              version: 0,
            });
          }
        }
        return values.length / 2;
      }
      if (/UPDATE product_locations/.test(text)) {
        const [deductQty, productId, locationId, guard] = values;
        const forced = seed.onStockUpdate?.({ productId, locationId, units: deductQty });
        if (typeof forced === 'number') return forced;
        const row = productLocations.get(plKey(productId, locationId));
        // The `quantity >=` clause survives as a BACKSTOP: the guard is the
        // tally, and a row that fails here has moved under an X lock.
        if (!row || row.quantity < guard) return 0;
        row.quantity -= deductQty;
        row.version += 1;
        return 1;
      }
      // NO `UPDATE products` branch: the loc-1 mirror is retired (P2-B2.5), so
      // that statement reaching this store at all is the regression — and the
      // throw below is what says so. `not.toMatch(/UPDATE products\b/)` pins
      // sit beside the callers that used to drive it.
      throw new Error(`unexpected sql: ${text}`);
    },

    $queryRaw: async (query: Prisma.Sql) => {
      const text = query.sql;
      const values = query.values as unknown[];
      if (isOrderLockSelect(text)) {
        // The order lock hook's own statement (pack CB1a-ii.1) — statement 1.
        return [{ id: ORDER_ID, orderNumber: '12345' }];
      }
      if (isPrelockSelect(text)) {
        // The RETURNING LOCKING READ half, same set, same order — the values
        // every pass-2a guard compares against.
        const rows: PlRow[] = [];
        for (let i = 0; i < values.length; i += 2) {
          const row = productLocations.get(
            plKey(values[i] as number, values[i + 1] as number)
          );
          if (row) rows.push({ ...row });
        }
        return rows;
      }
      throw new Error(`unexpected sql: ${text}`);
    },
  };

  const tx: any = {
    ...installRecordingRaw(rawImpls),

    externalOrder: {
      findUnique: jest.fn(async () => seed.order),
      update: jest.fn(async () => ({})),
    },
    externalOrderItem: {
      update: jest.fn(async ({ where, data }: any) => {
        seed.onOrderItemUpdate?.({ where, data });
        const row = orderItems.get(where.id);
        if (!row) throw new Error(`no order item ${where.id}`);
        if (data.fulfilledQty?.increment) row.fulfilledQty += data.fulfilledQty.increment;
        if (data.bundleComponentSnapshot !== undefined) {
          row.bundleComponentSnapshot = data.bundleComponentSnapshot;
        }
        return { ...row };
      }),
      findMany: jest.fn(async () => {
        const out: Array<{ quantity: number; fulfilledQty: number }> = [];
        (seed.order.items as any[]).forEach((i) =>
          out.push({ quantity: i.quantity, fulfilledQty: orderItems.get(i.id)!.fulfilledQty })
        );
        return out;
      }),
    },
    product: {
      // RETIRED with B1.5: the per-item name read. Kept on the stand-in so the
      // pins can say "never called" about something that exists.
      findUnique: jest.fn(async () => null),
      // THE ONE `products` read (pack CB1.5a-i.2): it proves every survivor's
      // ids AND supplies the names the result entries carry. An id this fixture
      // does not know is simply absent from the answer, and its item fails
      // ITEM-LOCALLY.
      findMany: jest.fn(async ({ where }: any) => {
        const ids: number[] = where?.id?.in ?? [];
        const softDeleteFiltered = where?.deletedAt === null;
        return ids
          .filter((id) => {
            const row = products.get(id);
            if (!row) return false;
            // The `deletedAt: null` clause, honoured (OC-5).
            return !(softDeleteFiltered && row.deletedAt);
          })
          .map((id) => ({ id, name: products.get(id)!.name }));
      }),
    },
    // The location the prelock's INSERT will name in `fk_pl_location` (OC-4).
    location: {
      findUnique: jest.fn(async ({ where }: any) =>
        locations.has(where.id) ? { id: where.id } : null
      ),
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
  const runTransaction = jest.fn(async (cb: (client: any) => Promise<any>) => {
    const snap = snapshot();
    try {
      return await cb(tx);
    } catch (error) {
      restore(snap);
      throw error;
    }
  });

  return {
    tx,
    runTransaction,
    statements,
    logsFor: (productId: number) => logs.filter((l) => l.productId === productId),
    allLogs: () => logs.slice(),
    product: (id: number) => products.get(id)!,
    productLocation: (productId: number, locationId: number) =>
      productLocations.get(plKey(productId, locationId)),
    orderItem: (id: string) => orderItems.get(id)!,
  };
}

type Store = ReturnType<typeof makeStore>;

function drive(store: Store) {
  (prisma.$transaction as unknown as jest.Mock).mockImplementation(async (cb: any) =>
    store.runTransaction(cb)
  );
}

/** The one INSERT the canonical prelock issues, with its VALUES. */
function prelockInsert(): { sql: string; values: number[] } | undefined {
  const call = rawFns.$executeRaw.mock.calls.find((c: any[]) =>
    /INSERT INTO product_locations/.test(sqlTextOf(c[0]))
  );
  return call ? { sql: sqlTextOf(call[0]), values: (call[0] as any).values } : undefined;
}

/** The index in `rawCalls` of the first statement matching `re`. */
function firstRawIndex(re: RegExp): number {
  return rawCalls.findIndex((c) => re.test(c.sql));
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

/** A bundle line with NO snapshot: `resolveBundleComponents` falls back to live. */
function liveBundleLine(
  components: Array<{ internalProductId: number; quantity: number }>,
  over: Record<string, unknown> = {}
) {
  return bundleLine({
    bundleComponentSnapshot: null,
    productLink: {
      isBundle: true,
      internalProduct: null,
      bundleComponents: components.map((c, i) => ({
        id: `bc${i}`,
        internalProductId: c.internalProductId,
        quantity: c.quantity,
        sortOrder: i,
      })),
    },
    ...over,
  });
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

beforeEach(() => {
  jest.clearAllMocks();
  rawCalls.length = 0;
});

// ---------------------------------------------------------------------------
// TP-1 — THE DR-1 PIN: a real mixed request fulfils on an engine that refuses
// savepoint statements.
// ---------------------------------------------------------------------------

describe('TP-1 — the savepoint-free path fulfils', () => {
  function mixedStore() {
    return makeStore({
      order: order([
        singleLine(),
        // A bundle whose SECOND component is the single's product (the shared key).
        bundleLine({
          bundleComponentSnapshot: [
            { internalProductId: 21, internalProductName: 'Alpha', quantity: 1, sortOrder: 0 },
            { internalProductId: 10, internalProductName: 'Widget A', quantity: 1, sortOrder: 1 },
          ],
        }),
        singleLine({ id: 'item-unmapped', isMapped: false, productLink: null }),
        singleLine({ id: 'item-done', quantity: 2, fulfilledQty: 2 }),
      ]),
      products: [
        { id: 10, name: 'Widget A', quantity: 100 },
        { id: 21, name: 'Alpha', quantity: 100 },
      ],
      productLocations: [
        { productId: 10, locationId: 1, quantity: 100, version: 1 },
        { productId: 21, locationId: 1, quantity: 100, version: 1 },
      ],
    });
  }

  const mixedRequest = [
    { itemId: 'item-1', quantity: 5 },
    { itemId: 'item-b', quantity: 1 },
    { itemId: 'item-unmapped', quantity: 1, skipUnmapped: true },
    { itemId: 'item-done', quantity: 2 },
  ];

  it('TP-1a: a mixed request commits both fulfillable lines and fails NOTHING', async () => {
    const store = mixedStore();
    drive(store);

    const result = await fulfillExternalOrder(ORDER_ID, 1, mixedRequest, 42, undefined, undefined, 'batch-1');

    expect(result.failed).toEqual([]);
    expect(result.fulfilled).toHaveLength(2);
    expect(result.fulfilled.map((f) => f.itemId)).toEqual(['item-1', 'item-b']);
    expect(result.skipped.map((s) => s.reason)).toEqual(['user_skipped', 'already_fulfilled']);

    // The STORE holds the movement: decrements, SALE rows, fulfilledQty.
    expect(store.productLocation(10, 1)).toMatchObject({ quantity: 94, version: 3 });
    expect(store.productLocation(21, 1)).toMatchObject({ quantity: 99, version: 2 });
    // ...and NOTHING was written to `products`: the loc-1 mirror is retired
    // (P2-B2.5). Asserted on the statements, not on the fake store's row, so it
    // reads as an absence rather than as an unchanged number.
    rawCalls.forEach((call) => expect(call.sql).not.toMatch(/UPDATE products\b/));
    expect(store.allLogs()).toEqual([
      { productId: 10, locationId: 1, delta: -5, logType: 'SALE', batchId: 'batch-1', orderRecordId: ORDER_ID },
      { productId: 21, locationId: 1, delta: -1, logType: 'SALE', batchId: 'batch-1', orderRecordId: ORDER_ID },
      { productId: 10, locationId: 1, delta: -1, logType: 'SALE', batchId: 'batch-1', orderRecordId: ORDER_ID },
    ]);
    expect(store.orderItem('item-1').fulfilledQty).toBe(5);
    expect(store.orderItem('item-b').fulfilledQty).toBe(1);

    // The engine's savepoint refusal never fired, because nothing asked for one.
    expect(store.statements).toEqual([]);
  });

  it('TP-1b: lib/fulfillment.ts issues no unsafe raw statement and names no savepoint', () => {
    const source = fs.readFileSync(FULFILLMENT_SOURCE, 'utf8');
    expect(source).not.toContain('$executeRawUnsafe');
    expect(source).not.toContain('SAVEPOINT');
  });

  it('TP-1c: the product NAME comes from the batched read, not a per-item findUnique', async () => {
    const store = mixedStore();
    drive(store);

    const result = await fulfillExternalOrder(ORDER_ID, 1, mixedRequest, 42);

    expect(result.fulfilled[0].productName).toBe('Widget A');
    // The bundle entry keeps naming the ORDER LINE, as it always has.
    expect(result.fulfilled[1].productName).toBe('Recovery Bundle');
    expect(store.tx.product.findMany).toHaveBeenCalledTimes(1);
    expect(store.tx.product.findUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TP-2 — pass 1 spends NOTHING on product_locations.
// ---------------------------------------------------------------------------

describe('TP-2 — pass 1 decides without touching stock', () => {
  it('TP-2: an all-refused request issues zero raw statements and ONE product read', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = makeStore({
      order: order([
        singleLine({ id: 'item-done', quantity: 2, fulfilledQty: 2 }),
        singleLine({ id: 'item-unmapped', isMapped: false, productLink: null }),
        singleLine({ id: 'item-skip', isMapped: false, productLink: null }),
        singleLine({ id: 'item-ghost' }),
      ]),
      products: [{ id: 10, name: 'Widget A', quantity: 100 }],
      productLocations: [{ productId: 10, locationId: 1, quantity: 100, version: 1 }],
    });
    drive(store);

    const result = await fulfillExternalOrder(
      ORDER_ID,
      1,
      [
        { itemId: 'item-absent', quantity: 1 },
        { itemId: 'item-done', quantity: 2 },
        { itemId: 'item-unmapped', quantity: 1 },
        { itemId: 'item-skip', quantity: 1, skipUnmapped: true },
        // A manual override naming a product that does not exist.
        { itemId: 'item-ghost', quantity: 1, productId: 999 },
      ],
      42
    );

    expect(result.fulfilled).toEqual([]);
    expect(rawCalls).toEqual([]);
    expect(store.tx.product.findMany).toHaveBeenCalledTimes(1);
    expect(store.tx.product.findUnique).not.toHaveBeenCalled();
    expect(result.failed.map((f) => f.itemId).sort()).toEqual(['item-absent', 'item-ghost']);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      'already_fulfilled',
      'unmapped',
      'user_skipped',
    ]);
    errSpy.mockRestore();
  });

  it('TP-2b: an absent override id fails ITEM-LOCALLY and its sibling commits', async () => {
    const store = makeStore({
      order: order([singleLine(), singleLine({ id: 'item-2', quantity: 1 })]),
      products: [{ id: 10, name: 'Widget A', quantity: 100 }],
      productLocations: [{ productId: 10, locationId: 1, quantity: 100, version: 1 }],
    });
    drive(store);

    const result = await fulfillExternalOrder(
      ORDER_ID,
      1,
      [
        { itemId: 'item-1', quantity: 5 },
        { itemId: 'item-2', quantity: 1, productId: 999 },
      ],
      42
    );

    expect(result.fulfilled.map((f) => f.itemId)).toEqual(['item-1']);
    expect(result.failed).toEqual([
      { itemId: 'item-2', error: new ProductNotFoundError(999).message },
    ]);
    // 999 never reached the prelock's VALUES, so the INSERT's foreign key never
    // had the chance to kill the whole transaction (pack REV-22 F2).
    expect(prelockInsert()!.values).toEqual([10, 1]);
    expect(store.productLocation(999, 1)).toBeUndefined();
  });

  it('TP-2c: a bundle naming an absent component fails the WHOLE item, siblings commit', async () => {
    const store = makeStore({
      order: order([
        singleLine(),
        bundleLine({
          bundleComponentSnapshot: [
            { internalProductId: 21, internalProductName: 'Alpha', quantity: 1, sortOrder: 0 },
            { internalProductId: 998, internalProductName: 'Ghost', quantity: 1, sortOrder: 1 },
          ],
        }),
      ]),
      products: [
        { id: 10, name: 'Widget A', quantity: 100 },
        { id: 21, name: 'Alpha', quantity: 100 },
      ],
      productLocations: [
        { productId: 10, locationId: 1, quantity: 100, version: 1 },
        { productId: 21, locationId: 1, quantity: 100, version: 1 },
      ],
    });
    drive(store);

    const result = await fulfillExternalOrder(
      ORDER_ID,
      1,
      [
        { itemId: 'item-1', quantity: 5 },
        { itemId: 'item-b', quantity: 1 },
      ],
      42
    );

    expect(result.failed).toEqual([
      { itemId: 'item-b', error: new ProductNotFoundError(998).message },
    ]);
    expect(result.fulfilled.map((f) => f.itemId)).toEqual(['item-1']);
    // The bundle contributed NO key — not even its resolvable component.
    expect(prelockInsert()!.values).toEqual([10, 1]);
    expect(store.logsFor(21)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TP-2d — the LOCATION is proved the way the products are (OC-4). The prelock's
// INSERT fires `fk_pl_location` too, so an unknown id would die as MySQL 1452
// and take the whole transaction — pass 1's freezes included — to a bare 500.
// ---------------------------------------------------------------------------

describe('TP-2d — the location guard', () => {
  function twoLineStore() {
    return makeStore({
      order: order([
        singleLine(),
        // A LIVE bundle: pass 1 freezes its snapshot, so the rollback is visible.
        liveBundleLine([{ internalProductId: 21, quantity: 1 }]),
      ]),
      products: [
        { id: 10, name: 'Widget A', quantity: 100 },
        { id: 21, name: 'Alpha', quantity: 100 },
      ],
      productLocations: [
        { productId: 10, locationId: 1, quantity: 100, version: 1 },
        { productId: 21, locationId: 1, quantity: 100, version: 1 },
      ],
      // The store knows location 1 only; the request below names 99.
      locations: [1],
    });
  }

  it('TP-2d: an unknown location refuses the WHOLE request before the prelock', async () => {
    const store = twoLineStore();
    drive(store);

    const error = await fulfillExternalOrder(
      ORDER_ID,
      99,
      [
        { itemId: 'item-1', quantity: 5 },
        { itemId: 'item-b', quantity: 1 },
      ],
      42
    ).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('LOCATION_NOT_FOUND');
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe('Location 99 not found');

    // The whole request, not one item: no survivor reached the prelock, so the
    // foreign key never had the chance to abort the transaction itself.
    expect(rawCalls.filter((c) => /product_locations/.test(c.sql))).toHaveLength(0);
    // ...and pass 1's snapshot freeze went with the aborted transaction.
    expect(store.orderItem('item-b').bundleComponentSnapshot).toBeNull();
  });

  it('TP-2d: zero survivors spend NO location statement', async () => {
    const store = makeStore({
      order: order([singleLine({ id: 'item-done', quantity: 2, fulfilledQty: 2 })]),
      products: [{ id: 10, name: 'Widget A', quantity: 100 }],
      productLocations: [{ productId: 10, locationId: 1, quantity: 100, version: 1 }],
    });
    drive(store);

    const result = await fulfillExternalOrder(ORDER_ID, 1, [{ itemId: 'item-done', quantity: 2 }], 42);

    expect(result.skipped.map((s) => s.reason)).toEqual(['already_fulfilled']);
    // The same rule the product read and the prelock keep: an all-refused
    // request spends nothing.
    expect(store.tx.location.findUnique).not.toHaveBeenCalled();
    expect(store.tx.product.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TP-2e — fulfil and unfulfill agree about SOFT-DELETED products (OC-5).
// Unfulfill refuses to restore one ("not found or deleted — stock not
// restored"), so a fulfil that deducted it would have no undo path at all.
// ---------------------------------------------------------------------------

describe('TP-2e — the soft-delete filter', () => {
  it('TP-2e: a soft-deleted product fails ITEM-LOCALLY and its sibling commits', async () => {
    const store = makeStore({
      order: order([singleLine(), singleLine({ id: 'item-2', quantity: 1 })]),
      products: [
        { id: 10, name: 'Widget A', quantity: 100 },
        { id: 11, name: 'Retired', quantity: 100, deletedAt: new Date('2026-08-01T00:00:00Z') },
      ],
      productLocations: [
        { productId: 10, locationId: 1, quantity: 100, version: 1 },
        { productId: 11, locationId: 1, quantity: 100, version: 1 },
      ],
    });
    drive(store);

    const result = await fulfillExternalOrder(
      ORDER_ID,
      1,
      [
        { itemId: 'item-1', quantity: 5 },
        // The override names the soft-deleted product.
        { itemId: 'item-2', quantity: 1, productId: 11 },
      ],
      42
    );

    // The EXISTING absent-id path, reused verbatim — no new vocabulary.
    expect(result.failed).toEqual([
      { itemId: 'item-2', error: new ProductNotFoundError(11).message },
    ]);
    expect(result.fulfilled.map((f) => f.itemId)).toEqual(['item-1']);
    // 11 never reached the prelock's VALUES, and never lost a unit.
    expect(prelockInsert()!.values).toEqual([10, 1]);
    expect(store.logsFor(11)).toHaveLength(0);
    expect(store.productLocation(11, 1)).toMatchObject({ quantity: 100 });
  });
});

// ---------------------------------------------------------------------------
// TP-3 — the prelock covers bundle COMPONENT keys (the B1 residual retires).
// ---------------------------------------------------------------------------

describe('TP-3 — the prelock', () => {
  it('TP-3: bundle component keys ride the prelock, deduped with the single keys', async () => {
    const store = makeStore({
      order: order([
        singleLine(),
        bundleLine({
          bundleComponentSnapshot: [
            { internalProductId: 10, internalProductName: 'Widget A', quantity: 1, sortOrder: 0 },
            { internalProductId: 11, internalProductName: 'Beta', quantity: 1, sortOrder: 1 },
          ],
        }),
      ]),
      products: [
        { id: 10, name: 'Widget A', quantity: 100 },
        { id: 11, name: 'Beta', quantity: 100 },
      ],
      productLocations: [
        { productId: 10, locationId: 1, quantity: 100, version: 1 },
        { productId: 11, locationId: 1, quantity: 100, version: 1 },
      ],
    });
    drive(store);

    await fulfillExternalOrder(
      ORDER_ID,
      1,
      [
        { itemId: 'item-1', quantity: 5 },
        { itemId: 'item-b', quantity: 1 },
      ],
      42
    );

    // ONE materialize, carrying exactly (10,1) and (11,1) in canonical order.
    expect(rawCalls.filter((c) => /INSERT INTO product_locations/.test(c.sql))).toHaveLength(1);
    expect(prelockInsert()!.values).toEqual([10, 1, 11, 1]);

    // …and it sits AFTER the order read and the product read, BEFORE the writes.
    const insertAt = firstRawIndex(/INSERT INTO product_locations/);
    const selectAt = rawCalls.findIndex((c) => isPrelockSelect(c.sql));
    const updateAt = firstRawIndex(/UPDATE product_locations/);
    expect(insertAt).toBe(0);
    expect(selectAt).toBe(1);
    expect(rawCalls[selectAt].sql).toContain('FOR UPDATE');
    expect(updateAt).toBeGreaterThan(selectAt);
    expect(rawFns.$executeRaw.mock.invocationCallOrder[0]).toBeGreaterThan(
      store.tx.externalOrder.findUnique.mock.invocationCallOrder[0]
    );
    expect(rawFns.$executeRaw.mock.invocationCallOrder[0]).toBeGreaterThan(
      store.tx.product.findMany.mock.invocationCallOrder[0]
    );
  });
});

// ---------------------------------------------------------------------------
// TP-4 — THE TALLY (QB-9 closed on both paths).
// ---------------------------------------------------------------------------

describe('TP-4 — the within-tx tally', () => {
  it('TP-4: a bundle refused after a sibling spent the shared key quotes the LOCKED number', async () => {
    const store = makeStore({
      order: order([
        singleLine({ quantity: 3 }),
        bundleLine({
          bundleComponentSnapshot: [
            { internalProductId: 10, internalProductName: 'Widget A', quantity: 2, sortOrder: 0 },
          ],
        }),
      ]),
      products: [{ id: 10, name: 'Widget A', quantity: 4 }],
      productLocations: [{ productId: 10, locationId: 1, quantity: 4, version: 1 }],
    });
    drive(store);

    const result = await fulfillExternalOrder(
      ORDER_ID,
      1,
      [
        { itemId: 'item-1', quantity: 3 },
        { itemId: 'item-b', quantity: 1 },
      ],
      42
    );

    expect(result.fulfilled.map((f) => f.itemId)).toEqual(['item-1']);
    expect(result.skipped).toEqual([
      {
        itemId: 'item-b',
        reason: 'insufficient_stock',
        details:
          'Insufficient stock for bundle component (productId: 10). Available: 1, Requested: 2',
      },
    ]);

    // ZERO product_locations statements were spent on the refusal: ONE UPDATE
    // (the single's) and no locking re-read at all.
    expect(rawCalls.filter((c) => /UPDATE product_locations/.test(c.sql))).toHaveLength(1);
    rawCalls.forEach((call) => expect(call.sql).not.toMatch(/UPDATE products\b/));
    expect(rawCalls.filter((c) => /SELECT quantity FROM product_locations/.test(c.sql))).toHaveLength(0);
    expect(store.orderItem('item-b').fulfilledQty).toBe(0);
  });

  it('TP-4: two singles on the same key — the second is guarded against the first', async () => {
    const store = makeStore({
      order: order([singleLine({ quantity: 2 }), singleLine({ id: 'item-2', quantity: 3 })]),
      products: [{ id: 10, name: 'Widget A', quantity: 4 }],
      productLocations: [{ productId: 10, locationId: 1, quantity: 4, version: 1 }],
    });
    drive(store);

    const result = await fulfillExternalOrder(
      ORDER_ID,
      1,
      [
        { itemId: 'item-1', quantity: 2 },
        { itemId: 'item-2', quantity: 3 },
      ],
      42
    );

    expect(result.fulfilled.map((f) => f.itemId)).toEqual(['item-1']);
    expect(result.skipped[0].details).toBe(
      'Insufficient stock for Widget A. Available: 2, Requested: 3'
    );
    // One key named twice is prelocked ONCE.
    expect(prelockInsert()!.values).toEqual([10, 1]);
  });
});

// ---------------------------------------------------------------------------
// TP-4b — the two-loop is STRUCTURAL: planPass2 is pinned DIRECTLY, as the pure
// function it is (PKd-2 / FVc-1 — a statement-order pin cannot see the shape,
// because guards spend no statements).
// ---------------------------------------------------------------------------

/**
 * A map that answers `get` and `forEach` and THROWS on anything else — so a
 * planner that reached for a delegate, an iterator or a raw method would be
 * caught here rather than in a statement count that cannot see it.
 */
function poisoned<K, V>(entries: Array<[K, V]>): ReadonlyMap<K, V> {
  const real = new Map<K, V>();
  entries.forEach(([k, v]) => real.set(k, v));
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'get' || prop === 'forEach') {
        return (target as any)[prop].bind(target);
      }
      throw new Error(`planPass2 reached for Map#${String(prop)}`);
    },
  }) as unknown as ReadonlyMap<K, V>;
}

describe('TP-4b — planPass2, the exported pure planner', () => {
  const LOC = 5;
  const row = (quantity: number, version = 1): PrelockedRow => ({ quantity, version });

  it('returns winners with names and advances the tally between survivors', () => {
    const survivors: Survivor[] = [
      { kind: 'single', itemId: 'a', locationId: LOC, productId: 10, quantity: 2 },
      { kind: 'single', itemId: 'b', locationId: LOC, productId: 10, quantity: 3 },
    ];
    const plan = planPass2(
      survivors,
      poisoned<string, PrelockedRow>([[prelockKey(10, LOC), row(4)]]),
      poisoned<number, string>([[10, 'Widget A']])
    );

    const winners: Winner[] = plan.winners;
    expect(winners).toEqual([
      { kind: 'single', itemId: 'a', locationId: LOC, productId: 10, quantity: 2, productName: 'Widget A' },
    ]);
    expect(plan.skipped).toEqual([
      {
        itemId: 'b',
        reason: 'insufficient_stock',
        details: 'Insufficient stock for Widget A. Available: 2, Requested: 3',
      },
    ]);
  });

  it('SUMS a bundle that names one product in two components', () => {
    const twice: Survivor[] = [
      {
        kind: 'bundle',
        itemId: 'b',
        locationId: LOC,
        orderItemName: 'Recovery Bundle',
        quantity: 1,
        components: [
          { productId: 10, deductQty: 1 },
          { productId: 10, deductQty: 1 },
        ],
      },
    ];

    const passes = planPass2(
      twice,
      poisoned<string, PrelockedRow>([[prelockKey(10, LOC), row(2)]]),
      poisoned<number, string>([[10, 'Widget A']])
    );
    expect(passes.skipped).toEqual([]);
    expect(passes.winners).toHaveLength(1);
    expect(passes.winners[0].productName).toBe('Recovery Bundle');

    const refuses = planPass2(
      twice,
      poisoned<string, PrelockedRow>([[prelockKey(10, LOC), row(1)]]),
      poisoned<number, string>([[10, 'Widget A']])
    );
    expect(refuses.winners).toEqual([]);
    expect(refuses.skipped).toEqual([
      {
        itemId: 'b',
        reason: 'insufficient_stock',
        details:
          'Insufficient stock for bundle component (productId: 10). Available: 1, Requested: 2',
      },
    ]);
  });

  it('refuses on the FIRST short key and spends nothing on the survivors that follow', () => {
    const survivors: Survivor[] = [
      {
        kind: 'bundle',
        itemId: 'b',
        locationId: LOC,
        orderItemName: 'Recovery Bundle',
        quantity: 1,
        components: [
          { productId: 10, deductQty: 1 },
          { productId: 11, deductQty: 9 },
          { productId: 12, deductQty: 9 },
        ],
      },
      { kind: 'single', itemId: 'a', locationId: LOC, productId: 10, quantity: 1 },
    ];
    const plan = planPass2(
      survivors,
      poisoned<string, PrelockedRow>([
        [prelockKey(10, LOC), row(1)],
        [prelockKey(11, LOC), row(0)],
        [prelockKey(12, LOC), row(0)],
      ]),
      poisoned<number, string>([
        [10, 'Widget A'],
        [11, 'Beta'],
        [12, 'Gamma'],
      ])
    );

    expect(plan.skipped).toEqual([
      {
        itemId: 'b',
        reason: 'insufficient_stock',
        details:
          'Insufficient stock for bundle component (productId: 11). Available: 0, Requested: 9',
      },
    ]);
    // The refused bundle spent NOTHING of the tally: the single still passes on
    // the key the bundle's first component named.
    expect(plan.winners.map((w) => w.itemId)).toEqual(['a']);
  });

  it('TP-4b (source): planPass2 has exactly ONE call site in lib/fulfillment.ts', () => {
    const source = fs.readFileSync(FULFILLMENT_SOURCE, 'utf8');
    // OCCURRENCES, not lines (G2s-6): a line filter reads two calls on one line
    // as one. Two occurrences = the declaration + the one call, the TP-10 idiom.
    expect(source.split('planPass2(').length - 1).toBe(2);
    // ...and nothing BINDS the planner to a second name, which a source count
    // alone cannot see. The one real call site is itself a destructuring
    // assignment, so what is refused is `= planPass2` NOT followed by a call.
    expect(/=\s*planPass2(?!\()/.test(source)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TP-5 — a bundle short on a LATER component is refused BEFORE any write.
// ---------------------------------------------------------------------------

describe('TP-5 — a short bundle writes nothing', () => {
  it('TP-5: the refusal comes before the first component write; siblings commit', async () => {
    const store = makeStore({
      order: order([
        bundleLine({
          bundleComponentSnapshot: [
            { internalProductId: 21, internalProductName: 'Alpha', quantity: 1, sortOrder: 0 },
            { internalProductId: 22, internalProductName: 'Beta', quantity: 5, sortOrder: 1 },
          ],
        }),
        singleLine({ id: 'item-2', quantity: 1 }),
      ]),
      products: [
        { id: 10, name: 'Widget A', quantity: 100 },
        { id: 21, name: 'Alpha', quantity: 100 },
        { id: 22, name: 'Beta', quantity: 1 },
      ],
      productLocations: [
        { productId: 10, locationId: 1, quantity: 100, version: 1 },
        { productId: 21, locationId: 1, quantity: 100, version: 1 },
        { productId: 22, locationId: 1, quantity: 1, version: 1 },
      ],
    });
    drive(store);

    const result = await fulfillExternalOrder(
      ORDER_ID,
      1,
      [
        { itemId: 'item-b', quantity: 1 },
        { itemId: 'item-2', quantity: 1 },
      ],
      42
    );

    expect(result.skipped).toEqual([
      {
        itemId: 'item-b',
        reason: 'insufficient_stock',
        details:
          'Insufficient stock for bundle component (productId: 22). Available: 1, Requested: 5',
      },
    ]);
    // NOTHING of the bundle was written — there is nothing to roll back.
    expect(store.productLocation(21, 1)).toMatchObject({ quantity: 100, version: 1 });
    expect(store.logsFor(21)).toHaveLength(0);
    expect(store.logsFor(22)).toHaveLength(0);
    expect(result.affectedComponentIds).toEqual([]);

    // The sibling committed.
    expect(result.fulfilled.map((f) => f.itemId)).toEqual(['item-2']);
    expect(store.productLocation(10, 1)).toMatchObject({ quantity: 99, version: 2 });
  });
});

// ---------------------------------------------------------------------------
// TP-6 / TP-7 — fail-closed: a throw after statement 1 aborts the request.
// ---------------------------------------------------------------------------

describe('TP-6/TP-7 — the backstop and the late failure', () => {
  it('TP-6: a 0-row UPDATE under a passing tally aborts the WHOLE transaction', async () => {
    const store = makeStore({
      order: order([singleLine()]),
      products: [{ id: 10, name: 'Widget A', quantity: 100 }],
      productLocations: [{ productId: 10, locationId: 1, quantity: 100, version: 1 }],
      onStockUpdate: () => 0, // the store LIES: the row "moved" under the tally
    });
    drive(store);

    await expect(
      fulfillExternalOrder(ORDER_ID, 1, [{ itemId: 'item-1', quantity: 5 }], 42)
    ).rejects.toThrow('fulfil invariant: locked row 10:1 moved under the tally');

    expect(store.productLocation(10, 1)).toMatchObject({ quantity: 100, version: 1 });
    expect(store.orderItem('item-1').fulfilledQty).toBe(0);
    expect(store.allLogs()).toEqual([]);
  });

  it('TP-7: a LATE write failure aborts the request — item 1 goes with it', async () => {
    const store = makeStore({
      order: order([
        singleLine(),
        singleLine({
          id: 'item-2',
          quantity: 3,
          productLink: {
            isBundle: false,
            internalProduct: { id: 20, name: 'Widget B' },
            bundleComponents: [],
          },
        }),
      ]),
      products: [
        { id: 10, name: 'Widget A', quantity: 100 },
        { id: 20, name: 'Widget B', quantity: 100 },
      ],
      productLocations: [
        { productId: 10, locationId: 1, quantity: 100, version: 1 },
        { productId: 20, locationId: 1, quantity: 100, version: 1 },
      ],
      onOrderItemUpdate: ({ where, data }) => {
        if (where.id === 'item-2' && data.fulfilledQty !== undefined) {
          throw new Error('fulfilledQty update failed');
        }
      },
    });
    drive(store);

    await expect(
      fulfillExternalOrder(
        ORDER_ID,
        1,
        [
          { itemId: 'item-1', quantity: 5 },
          { itemId: 'item-2', quantity: 3 },
        ],
        42
      )
    ).rejects.toThrow('fulfilledQty update failed');

    // The strictly stronger W2S-1: item 1's committed work is gone too.
    expect(store.productLocation(10, 1)).toMatchObject({ quantity: 100, version: 1 });
    expect(store.productLocation(20, 1)).toMatchObject({ quantity: 100, version: 1 });
    rawCalls.forEach((call) => expect(call.sql).not.toMatch(/UPDATE products\b/));
    expect(store.allLogs()).toEqual([]);
    expect(store.orderItem('item-1').fulfilledQty).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TP-8 — no classification in the lib: the ladder owns it.
// ---------------------------------------------------------------------------

describe('TP-8 — a transient propagates unchanged', () => {
  it('TP-8: a P2034 from the UPDATE leaves fulfillExternalOrder as the same instance', async () => {
    const p2034 = new Prisma.PrismaClientKnownRequestError(
      'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
      { code: 'P2034', clientVersion: 'test' } as never
    );
    const store = makeStore({
      order: order([singleLine()]),
      products: [{ id: 10, name: 'Widget A', quantity: 100 }],
      productLocations: [{ productId: 10, locationId: 1, quantity: 100, version: 1 }],
      onStockUpdate: () => {
        throw p2034;
      },
    });
    drive(store);

    await expect(
      fulfillExternalOrder(ORDER_ID, 1, [{ itemId: 'item-1', quantity: 5 }], 42)
    ).rejects.toBe(p2034);
  });
});

// ---------------------------------------------------------------------------
// TP-9 — FIX B, the bundle snapshot freeze.
// ---------------------------------------------------------------------------

describe('TP-9 — the snapshot freeze', () => {
  it('TP-9: a live-sourced bundle refused for stock KEEPS its freeze', async () => {
    const store = makeStore({
      order: order([liveBundleLine([{ internalProductId: 21, quantity: 5 }])]),
      products: [{ id: 21, name: 'Alpha', quantity: 1 }],
      productLocations: [{ productId: 21, locationId: 1, quantity: 1, version: 1 }],
    });
    drive(store);

    const result = await fulfillExternalOrder(ORDER_ID, 1, [{ itemId: 'item-b', quantity: 1 }], 42);

    expect(result.skipped[0].reason).toBe('insufficient_stock');
    expect(store.orderItem('item-b').bundleComponentSnapshot).toEqual([
      expect.objectContaining({ internalProductId: 21, quantity: 5 }),
    ]);
  });

  it('TP-9: a request that ABORTS leaves no freeze behind', async () => {
    const store = makeStore({
      order: order([
        liveBundleLine([{ internalProductId: 21, quantity: 1 }]),
        singleLine({ id: 'item-2', quantity: 1 }),
      ]),
      products: [
        { id: 10, name: 'Widget A', quantity: 100 },
        { id: 21, name: 'Alpha', quantity: 100 },
      ],
      productLocations: [
        { productId: 10, locationId: 1, quantity: 100, version: 1 },
        { productId: 21, locationId: 1, quantity: 100, version: 1 },
      ],
      onStockUpdate: () => {
        throw new Error('engine gave up');
      },
    });
    drive(store);

    await expect(
      fulfillExternalOrder(
        ORDER_ID,
        1,
        [
          { itemId: 'item-b', quantity: 1 },
          { itemId: 'item-2', quantity: 1 },
        ],
        42
      )
    ).rejects.toThrow('engine gave up');

    expect(store.orderItem('item-b').bundleComponentSnapshot).toBeNull();
  });

  it('TP-9: a bundle that already HAS a snapshot is not re-written', async () => {
    const store = makeStore({
      order: order([bundleLine()]),
      products: [
        { id: 21, name: 'Alpha', quantity: 100 },
        { id: 22, name: 'Beta', quantity: 100 },
      ],
      productLocations: [
        { productId: 21, locationId: 1, quantity: 100, version: 1 },
        { productId: 22, locationId: 1, quantity: 100, version: 1 },
      ],
    });
    drive(store);

    await fulfillExternalOrder(ORDER_ID, 1, [{ itemId: 'item-b', quantity: 1 }], 42);

    const snapshotWrites = store.tx.externalOrderItem.update.mock.calls.filter(
      (c: any[]) => c[0]?.data?.bundleComponentSnapshot !== undefined
    );
    expect(snapshotWrites).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TP-10 — `concurrent_modification` survives only as a type member.
// ---------------------------------------------------------------------------

describe('TP-10 — the retired refusal reason', () => {
  it('TP-10: the literal occurs exactly ONCE in lib/fulfillment.ts', () => {
    const source = fs.readFileSync(FULFILLMENT_SOURCE, 'utf8');
    expect(source.split("'concurrent_modification'")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// TP-11 — TOO_MANY_KEYS: fulfil's own sentence, and an atomic abort.
// ---------------------------------------------------------------------------

describe('TP-11 — the prelock cap', () => {
  it('TP-11: past MAX_PRELOCK_KEYS the request is a 400 and nothing survives', async () => {
    // 67 live-sourced bundle lines × 3 distinct components each = 201 keys.
    const lines: any[] = [];
    const products: Array<{ id: number; name: string; quantity: number }> = [];
    let nextProductId = 100;
    for (let i = 0; i < 67; i += 1) {
      const components = [0, 1, 2].map(() => {
        const id = nextProductId++;
        products.push({ id, name: `Component ${id}`, quantity: 100 });
        return { internalProductId: id, quantity: 1 };
      });
      lines.push(liveBundleLine(components, { id: `item-b${i}` }));
    }
    expect(products).toHaveLength(MAX_PRELOCK_KEYS + 1);

    const store = makeStore({ order: order(lines), products, productLocations: [] });
    drive(store);

    const error = await fulfillExternalOrder(
      ORDER_ID,
      1,
      lines.map((line) => ({ itemId: line.id, quantity: 1 })),
      42
    ).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('TOO_MANY_KEYS');
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe(
      'this order needs more than 200 stock rows in one request and cannot be fulfilled in one pass'
    );

    // Nothing committed — the freezes pass 1 wrote are rolled back with it.
    expect(rawCalls.filter((c) => /product_locations/.test(c.sql))).toHaveLength(0);
    expect(store.orderItem('item-b0').bundleComponentSnapshot).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TP-12 — the order lock hook (moved here from the bundle suite).
// ---------------------------------------------------------------------------

describe('TP-12 — opts.lockFirst', () => {
  function lockHook() {
    return jest.fn(async (tx: any) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id, orderNumber FROM external_orders WHERE id IN (${ORDER_ID}) ORDER BY id FOR UPDATE`
      );
    });
  }

  function stocked() {
    return makeStore({
      order: order([singleLine()]),
      products: [{ id: 10, name: 'Widget A', quantity: 100 }],
      productLocations: [{ productId: 10, locationId: 1, quantity: 100, version: 1 }],
    });
  }

  it('TP-12: the hook is statement 1 — before the order read', async () => {
    const store = stocked();
    drive(store);
    const lockFirst = lockHook();

    await fulfillExternalOrder(
      ORDER_ID,
      1,
      [{ itemId: 'item-1', quantity: 5 }],
      42,
      undefined,
      undefined,
      null,
      { lockFirst }
    );

    expect(lockFirst).toHaveBeenCalledTimes(1);
    expect(rawCalls[0].kind).toBe('query');
    expect(rawCalls[0].sql).toContain('FROM external_orders');
    expect(rawCalls[0].sql).toContain('FOR UPDATE');
    expect(rawFns.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      store.tx.externalOrder.findUnique.mock.invocationCallOrder[0]
    );
  });

  it('TP-12: WITHOUT a hook the only $queryRaw is the prelock SELECT', async () => {
    const store = stocked();
    drive(store);

    await fulfillExternalOrder(ORDER_ID, 1, [{ itemId: 'item-1', quantity: 5 }], 42);

    const queries = rawCalls.filter((c) => c.kind === 'query');
    expect(queries).toHaveLength(1);
    expect(isPrelockSelect(queries[0].sql)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TP-13 — the result shape IS the wire.
// ---------------------------------------------------------------------------

describe('TP-13 — the result', () => {
  it('TP-13: fulfilled entries, log ids, component ids and totals, as literals', async () => {
    const store = makeStore({
      order: order([
        singleLine({ quantity: 2 }),
        bundleLine({
          bundleComponentSnapshot: [
            { internalProductId: 21, internalProductName: 'Alpha', quantity: 1, sortOrder: 0 },
            { internalProductId: 21, internalProductName: 'Alpha', quantity: 1, sortOrder: 1 },
          ],
        }),
      ]),
      products: [
        { id: 10, name: 'Widget A', quantity: 100 },
        { id: 21, name: 'Alpha', quantity: 100 },
      ],
      productLocations: [
        { productId: 10, locationId: 1, quantity: 100, version: 1 },
        { productId: 21, locationId: 1, quantity: 100, version: 1 },
      ],
    });
    drive(store);

    const result = await fulfillExternalOrder(
      ORDER_ID,
      1,
      [
        { itemId: 'item-1', quantity: 2 },
        { itemId: 'item-b', quantity: 1 },
      ],
      42
    );

    expect(result.fulfilled).toEqual([
      {
        itemId: 'item-1',
        productId: 10,
        productName: 'Widget A',
        quantity: 2,
        inventoryLogId: 1,
      },
      {
        itemId: 'item-b',
        productId: -1,
        productName: 'Recovery Bundle',
        quantity: 1,
        inventoryLogId: -1,
        isBundle: true,
        componentIds: [21, 21],
      },
    ]);
    expect(result.inventoryLogIds).toEqual([1]);
    expect(result.affectedComponentIds).toEqual([21]);
    expect(result.totalQuantity).toBe(3);
    expect(result.totalFulfilled).toBe(3);
    expect(result.externalId).toBe('ext-1');
    expect(result.integrationId).toBe('int-1');
    expect(result.integrationPlatform).toBe('WOOCOMMERCE');
    expect(store.productLocation(21, 1)).toMatchObject({ quantity: 98, version: 3 });
  });
});

// ---------------------------------------------------------------------------
// TP-14 — DUPLICATE_ITEM, before the transaction opens.
// ---------------------------------------------------------------------------

describe('TP-14 — one line, once', () => {
  it('TP-14: the same itemId twice is a 400 that spends ZERO statements', async () => {
    const store = makeStore({
      order: order([singleLine({ quantity: 2 })]),
      products: [{ id: 10, name: 'Widget A', quantity: 100 }],
      productLocations: [{ productId: 10, locationId: 1, quantity: 100, version: 1 }],
    });
    drive(store);

    const error = await fulfillExternalOrder(
      ORDER_ID,
      1,
      [
        { itemId: 'item-1', quantity: 2 },
        { itemId: 'item-1', quantity: 2 },
      ],
      42
    ).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('DUPLICATE_ITEM');
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe('the same order line appears more than once in the request');

    // The transaction never opened, so the over-fulfil hole cannot open either.
    expect(store.runTransaction).not.toHaveBeenCalled();
    expect(prisma.$transaction as unknown as jest.Mock).not.toHaveBeenCalled();
    expect(store.orderItem('item-1').fulfilledQty).toBe(0);
  });
});
