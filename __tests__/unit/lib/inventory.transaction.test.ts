/**
 * @jest-environment node
 *
 * Unit tests for `createInventoryTransaction` — the multi-item deduct path
 * (deduct-simple -> workbench complete-order). This wave routed its per-item
 * write through the shared `applyStockDelta` core (log + product_locations
 * upsert + loc-1 Product.quantity mirror), eliminating a hand-inlined copy.
 *
 * These tests pin the OBSERVABLE Prisma call sequence the unified write path
 * issues (the same level the applyStockDelta suite asserts at), plus the
 * caller-owned concurrency guards that stay OUTSIDE applyStockDelta:
 *   - read-compare optimistic version check (-> OptimisticLockError)
 *   - stock-floor validation on negative deltas (-> InsufficientStockError)
 *
 * This repo does NOT use a real test DB. Prisma is mocked with jest-mock-extended;
 * createInventoryTransaction runs inside prisma.$transaction, so the singleton's
 * $transaction is wired to invoke its callback with a mockDeep tx (same harness as
 * inventory.transfer-id.test.ts).
 */

import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended';
import { Prisma, inventory_logs_logType } from '@prisma/client';

jest.mock('@/lib/prisma', () => {
  const { mockDeep: md } = require('jest-mock-extended');
  return { __esModule: true, default: md() };
});

import prisma from '@/lib/prisma';
import { createInventoryTransaction, OptimisticLockError } from '@/lib/inventory';
import { InsufficientStockError } from '@/lib/error-handling';

const mockPrisma = prisma as unknown as DeepMockProxy<typeof prisma>;

// ---------------------------------------------------------------------------
// THE RECORDING RAW TRIO (pack CB0.3, the per-suite paragraph).
//
// Own `@/lib/prisma` factory + a `mockTx` rebuilt per test, so the trio is
// installed on the FRESH object AFTER the reset, in the same beforeEach
// (REV-15 OC-4). Two layers: the OUTER fn always records, then delegates to an
// INNER behaviour fn (`rawBehavior`) — which is what a test configures, so an
// override cannot switch the recording off.
// ---------------------------------------------------------------------------
type RawCall = { kind: 'query' | 'execute' | 'executeUnsafe'; sql: string; at: number };

/** Every raw statement the test under way has spent, in call order. */
const rawCalls: RawCall[] = [];
/** The INNER behaviour fns, by method name — what a test configures. */
const rawBehavior: Record<string, jest.Mock> = {};
/** The OUTER recording fns — for `invocationCallOrder` against the delegates. */
const rawFns: Record<string, jest.Mock> = {};
let rawSeq = 0;

function sqlTextOf(arg: unknown): string {
  return arg && typeof arg === 'object' && typeof (arg as { sql?: unknown }).sql === 'string'
    ? (arg as { sql: string }).sql
    : String(arg);
}

function installRecordingRaw(target: Record<string, unknown>): void {
  const install = (kind: RawCall['kind'], method: string, make: () => unknown) => {
    const behavior = jest.fn((..._args: unknown[]) => Promise.resolve(make()));
    const recording = jest.fn((...args: unknown[]) => {
      rawCalls.push({ kind, sql: sqlTextOf(args[0]), at: rawSeq++ });
      return behavior(...args);
    });
    rawBehavior[method] = behavior;
    rawFns[method] = recording;
    target[method] = recording;
  };
  install('query', '$queryRaw', () => []);
  install('execute', '$executeRaw', () => 0);
  install('executeUnsafe', '$executeRawUnsafe', () => 0);
}

/** The `Prisma.sql` object a raw call was handed. */
function rawArg(fn: jest.Mock, call = 0): { sql: string; values: unknown[] } {
  return fn.mock.calls[call][0] as unknown as { sql: string; values: unknown[] };
}

/**
 * What the prelock's returning SELECT hands back — the fixture every per-item
 * guard reads now that the per-item `findUnique` is retired.
 */
function prelocked(
  rows: Array<{ productId: number; locationId: number; quantity: number; version: number }>
): void {
  rawBehavior.$queryRaw.mockResolvedValue(rows);
}

let mockTx: DeepMockProxy<Prisma.TransactionClient>;

beforeEach(() => {
  mockTx = mockDeep<Prisma.TransactionClient>();
  mockReset(mockTx);
  mockReset(mockPrisma);
  rawCalls.length = 0;
  installRecordingRaw(mockTx as unknown as Record<string, unknown>);

  // $transaction drives the real callback with the mocked tx (single attempt).
  (mockPrisma.$transaction as jest.Mock).mockImplementation(
    async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => fn(mockTx)
  );

  // The version guard AND the stock floor both read the PRELOCK's returned rows
  // now (pack CB1a-i.4 retired the per-item findUnique + validateStockAvailability):
  // plenty of stock, version 1, on every key these tests touch.
  prelocked([
    { productId: 7, locationId: 1, quantity: 100, version: 1 },
    { productId: 9, locationId: 2, quantity: 100, version: 1 },
  ]);
  // createInventoryLog returns the created row (with relations preserved for the
  // deduct-simple audit which reads log.products?.name).
  mockTx.inventory_logs.create.mockResolvedValue({
    id: 100,
    productId: 7,
    delta: -5,
    products: { name: 'Widget' },
  } as any);
  mockTx.product_locations.upsert.mockResolvedValue({ version: 8 } as any);
  mockTx.product.update.mockResolvedValue({} as any);
  mockTx.product.findUnique.mockResolvedValue({ name: 'Widget' } as any);
});

describe('createInventoryTransaction — unified applyStockDelta write path', () => {
  it('locationId === 1: writes SALE log (DEDUCTION type) + upsert (qty/version increment) + loc-1 mirror', async () => {
    const result = await createInventoryTransaction('DEDUCTION', 42, [
      { productId: 7, locationId: 1, quantityChange: -5 },
    ]);

    // 1. inventory_logs.create — negative delta passed through. Phase C (D6/R-D18):
    // the "DEDUCTION" type (manual-order fulfillment) now maps to logType SALE.
    expect(mockTx.inventory_logs.create).toHaveBeenCalledTimes(1);
    const logArg = mockTx.inventory_logs.create.mock.calls[0][0] as any;
    expect(logArg.data.delta).toBe(-5);
    expect(logArg.data.productId).toBe(7);
    expect(logArg.data.locationId).toBe(1);
    expect(logArg.data.userId).toBe(42);
    expect(logArg.data.logType).toBe(inventory_logs_logType.SALE);
    expect(logArg.data.transferId).toBeNull();

    // 2. product_locations.upsert — increment quantity by delta, version by 1
    expect(mockTx.product_locations.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = mockTx.product_locations.upsert.mock.calls[0][0] as any;
    expect(upsertArg.where.productId_locationId).toEqual({ productId: 7, locationId: 1 });
    expect(upsertArg.update.quantity.increment).toBe(-5);
    expect(upsertArg.update.version.increment).toBe(1);
    expect(upsertArg.create).toEqual({ productId: 7, locationId: 1, quantity: -5, version: 1 });

    // 3. product.update — loc-1 legacy mirror, increment by delta
    expect(mockTx.product.update).toHaveBeenCalledTimes(1);
    const prodArg = mockTx.product.update.mock.calls[0][0] as any;
    expect(prodArg.where).toEqual({ id: 7 });
    expect(prodArg.data.quantity.increment).toBe(-5);

    // Return contract: synthetic transaction, full log rows, versions map keyed pid-lid.
    expect(result.transaction).toMatchObject({ type: 'DEDUCTION', status: 'COMPLETED', userId: 42 });
    expect(result.logs).toHaveLength(1);
    expect((result.logs[0] as any).products?.name).toBe('Widget'); // relations preserved for audit
    expect(result.versions).toEqual({ '7-1': 8 });
  });

  it('locationId !== 1: does NOT touch the legacy Product.quantity mirror', async () => {
    prelocked([{ productId: 7, locationId: 2, quantity: 100, version: 1 }]);

    await createInventoryTransaction('DEDUCTION', 42, [
      { productId: 7, locationId: 2, quantityChange: -5 },
    ]);

    expect(mockTx.inventory_logs.create).toHaveBeenCalledTimes(1);
    expect(mockTx.product_locations.upsert).toHaveBeenCalledTimes(1);
    // loc-1-only mirror must NOT fire for locationId 2
    expect(mockTx.product.update).not.toHaveBeenCalled();
  });

  it('processes multiple items in one transaction, keying versions by productId-locationId', async () => {
    mockTx.product_locations.upsert
      .mockResolvedValueOnce({ version: 8 } as any)
      .mockResolvedValueOnce({ version: 3 } as any);

    const result = await createInventoryTransaction('DEDUCTION', 42, [
      { productId: 7, locationId: 1, quantityChange: -5 },
      { productId: 9, locationId: 2, quantityChange: -2 },
    ]);

    expect(mockTx.inventory_logs.create).toHaveBeenCalledTimes(2);
    expect(mockTx.product_locations.upsert).toHaveBeenCalledTimes(2);
    // only the location-1 item mirrors into Product.quantity
    expect(mockTx.product.update).toHaveBeenCalledTimes(1);
    expect(result.logs).toHaveLength(2);
    expect(result.versions).toEqual({ '7-1': 8, '9-2': 3 });
  });

  it('read-compare version guard: mismatched expectedVersion throws OptimisticLockError before any write', async () => {
    prelocked([{ productId: 7, locationId: 1, quantity: 100, version: 5 }]);

    await expect(
      createInventoryTransaction('DEDUCTION', 42, [
        { productId: 7, locationId: 1, quantityChange: -5, expectedVersion: 4 },
      ])
    ).rejects.toBeInstanceOf(OptimisticLockError);

    // guard fires before the write core — nothing written
    expect(mockTx.inventory_logs.create).not.toHaveBeenCalled();
    expect(mockTx.product_locations.upsert).not.toHaveBeenCalled();
    expect(mockTx.product.update).not.toHaveBeenCalled();
  });

  it('matching expectedVersion passes the guard and writes normally', async () => {
    prelocked([{ productId: 7, locationId: 1, quantity: 100, version: 4 }]);

    await createInventoryTransaction('DEDUCTION', 42, [
      { productId: 7, locationId: 1, quantityChange: -5, expectedVersion: 4 },
    ]);

    expect(mockTx.product_locations.upsert).toHaveBeenCalledTimes(1);
  });

  it('negative delta beyond available stock throws InsufficientStockError before any write', async () => {
    prelocked([{ productId: 7, locationId: 1, quantity: 3, version: 1 }]);

    await expect(
      createInventoryTransaction('DEDUCTION', 42, [
        { productId: 7, locationId: 1, quantityChange: -5 },
      ])
    ).rejects.toBeInstanceOf(InsufficientStockError);

    expect(mockTx.inventory_logs.create).not.toHaveBeenCalled();
    expect(mockTx.product_locations.upsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// THE LOCK DISCIPLINE (Part 2, pack CB1a-i.4). One order lock, then ONE prelock
// over every item's key before the loop — never one per item, or two requests
// naming the same two rows in opposite orders would take them in opposite
// orders. The per-item guards then read that snapshot as a WITHIN-TX TALLY, so
// a request naming one key twice keeps exactly the semantics the retired
// own-write-visible read gave it.
// ---------------------------------------------------------------------------
describe('createInventoryTransaction — the lock order (B1a-i.4)', () => {
  /** A locking read of the caller's own, exactly as deduct-simple's will be. */
  function orderLockHook() {
    return jest.fn(async (tx: Prisma.TransactionClient) => {
      await (tx as unknown as { $queryRaw: (q: unknown) => Promise<unknown> }).$queryRaw(
        Prisma.sql`SELECT id, orderNumber FROM external_orders WHERE id IN (${'ORD-1'}) ORDER BY id FOR UPDATE`
      );
    });
  }

  it('runs opts.lockFirst FIRST — before the prelock, before every delegate', async () => {
    const lockFirst = orderLockHook();

    await createInventoryTransaction(
      'DEDUCTION',
      42,
      [{ productId: 7, locationId: 1, quantityChange: -5 }],
      undefined,
      undefined,
      { batchId: 'batch-1', orderRecordId: 'ORD-1', lockFirst }
    );

    expect(lockFirst).toHaveBeenCalledTimes(1);
    expect(lockFirst.mock.calls[0][0]).toBe(mockTx);
    expect(rawCalls.map((c) => c.kind)).toEqual(['query', 'execute', 'query']);
    expect(rawCalls[0].sql).toContain('external_orders');
    expect(rawCalls[1].sql).toContain('INSERT INTO product_locations');
    // The whole lock block precedes every delegate write.
    expect(rawFns.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      mockTx.inventory_logs.create.mock.invocationCallOrder[0]
    );
    expect(rawFns.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      mockTx.product_locations.upsert.mock.invocationCallOrder[0]
    );
  });

  it('takes ONE prelock over the deduped, canonically sorted keys of ALL items', async () => {
    prelocked([
      { productId: 7, locationId: 1, quantity: 100, version: 1 },
      { productId: 9, locationId: 2, quantity: 100, version: 1 },
    ]);

    await createInventoryTransaction('DEDUCTION', 42, [
      { productId: 9, locationId: 2, quantityChange: -1 },
      { productId: 7, locationId: 1, quantityChange: -1 },
      { productId: 9, locationId: 2, quantityChange: -1 },
    ]);

    // Two raw statements for three items — one prelock, not one per item.
    expect(rawCalls.map((c) => c.kind)).toEqual(['execute', 'query']);
    expect(rawArg(rawFns.$executeRaw).values).toEqual([7, 1, 9, 2]);
    expect(rawArg(rawFns.$queryRaw).values).toEqual([7, 1, 9, 2]);
    // …and it happened before the first item's write, not inside the loop.
    expect(rawFns.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockTx.inventory_logs.create.mock.invocationCallOrder[0]
    );
    expect(mockTx.product_locations.findUnique).not.toHaveBeenCalled();
  });

  it('the within-tx tally: a key named twice sees the first item\'s effect', async () => {
    // 5 on hand, two deductions of 3. The first passes; the second must read
    // 2 — exactly what the retired own-write-visible read returned — and refuse.
    prelocked([{ productId: 7, locationId: 1, quantity: 5, version: 1 }]);
    mockTx.product.findUnique.mockResolvedValue({ name: 'Widget' } as any);

    await expect(
      createInventoryTransaction('DEDUCTION', 42, [
        { productId: 7, locationId: 1, quantityChange: -3 },
        { productId: 7, locationId: 1, quantityChange: -3 },
      ])
    ).rejects.toThrow('Insufficient stock for Widget. Requested: 2, Available: 3');

    // The first item DID write before the second refused (the transaction is
    // what rolls it back) — the loop's shape is unchanged.
    expect(mockTx.inventory_logs.create).toHaveBeenCalledTimes(1);
  });

  it('the within-tx tally advances the VERSION too', async () => {
    // Same key twice with the versions the caller would hold if it re-read
    // between the two items: 1, then 2.
    prelocked([{ productId: 7, locationId: 1, quantity: 100, version: 1 }]);

    const result = await createInventoryTransaction('DEDUCTION', 42, [
      { productId: 7, locationId: 1, quantityChange: -5, expectedVersion: 1 },
      { productId: 7, locationId: 1, quantityChange: -2, expectedVersion: 2 },
    ]);

    expect(mockTx.inventory_logs.create).toHaveBeenCalledTimes(2);
    // logs[0] is still the FIRST item's row — the item loop's order is untouched.
    expect((result.logs[0] as any).id).toBe(100);
    expect(result.logs).toHaveLength(2);
    // A second item that sends the PRE-write version is now the conflict.
    await expect(
      createInventoryTransaction('DEDUCTION', 42, [
        { productId: 7, locationId: 1, quantityChange: -5, expectedVersion: 1 },
        { productId: 7, locationId: 1, quantityChange: -2, expectedVersion: 1 },
      ])
    ).rejects.toMatchObject({ name: 'OptimisticLockError', currentVersion: 2, expectedVersion: 1 });
  });

  it('B1 ACTIVATION: a never-stocked key + a stale expectedVersion now conflicts', async () => {
    prelocked([{ productId: 7, locationId: 1, quantity: 0, version: 0 }]);

    await expect(
      createInventoryTransaction('DEDUCTION', 42, [
        { productId: 7, locationId: 1, quantityChange: 5, expectedVersion: 1 },
      ])
    ).rejects.toMatchObject({ name: 'OptimisticLockError', currentVersion: 0, expectedVersion: 1 });

    expect(mockTx.inventory_logs.create).not.toHaveBeenCalled();
  });

  it('materialize-first: a never-stocked key refuses a deduction against { 0, 0 }', async () => {
    prelocked([{ productId: 7, locationId: 1, quantity: 0, version: 0 }]);
    mockTx.product.findUnique.mockResolvedValue({ name: 'Widget' } as any);

    await expect(
      createInventoryTransaction('DEDUCTION', 42, [
        { productId: 7, locationId: 1, quantityChange: -5 },
      ])
    ).rejects.toThrow('Insufficient stock for Widget. Requested: 0, Available: 5');
  });
});
