/**
 * @jest-environment node
 *
 * Phase C (P-C1 / P-C4 / ER-C2) TRUNK unit tests for lib/inventory.ts:
 *   - createInventoryLog persists reasonCode/unitCostCents/batchId when given,
 *     and writes null for each when omitted (nullable passthrough).
 *   - applyStockDelta threads all three into createInventoryLog untouched.
 *   - createInventoryAdjustment's NEW options bag (P-C4): the record callback
 *     still fires in-tx AFTER the stock write with the SAME tx (mock identity),
 *     and the retry path preserves the same batchId across OptimisticLockError
 *     retries.
 *   - centsFromCostPrice (ER-C2) 5-case table incl. -5 -> null and
 *     30000000 -> null + console.error (INT-cents overflow, never lie).
 *
 * This repo does NOT use a real test DB. Prisma is mocked with jest-mock-extended,
 * same harness as inventory.applyStockDelta.test.ts / inventory.transaction.test.ts.
 */

import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended';
import { Prisma, inventory_logs_logType } from '@prisma/client';

jest.mock('@/lib/prisma', () => {
  const { mockDeep: md } = require('jest-mock-extended');
  return { __esModule: true, default: md() };
});

import prisma from '@/lib/prisma';
import {
  createInventoryLog,
  applyStockDelta,
  createInventoryAdjustment,
  centsFromCostPrice,
  centsFromRetailPrice,
  OptimisticLockError,
} from '@/lib/inventory';
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

/**
 * What the prelock's returning SELECT hands back — the fixture the adjustment's
 * guards read now that the `findUnique` at the head of the transaction is gone.
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

  (mockPrisma.$transaction as jest.Mock).mockImplementation(
    async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => fn(mockTx)
  );

  mockTx.inventory_logs.create.mockResolvedValue({ id: 100 } as any);
  mockTx.product_locations.upsert.mockResolvedValue({ version: 7 } as any);
  mockTx.product.update.mockResolvedValue({} as any);
  // Plenty of stock at version 1 — through the PRELOCK now (pack CB1a-i.2
  // retired the `findUnique` that used to open this transaction).
  prelocked([{ productId: 7, locationId: 2, quantity: 100, version: 1 }]);
});

describe('createInventoryLog — reasonCode/unitCostCents/batchId passthrough (P-C1)', () => {
  it('persists all three when provided', async () => {
    await createInventoryLog(
      {
        userId: 1,
        productId: 7,
        locationId: 2,
        delta: 5,
        reasonCode: 'CORRECTION',
        unitCostCents: 1234,
        batchId: 'batch-abc',
      },
      mockTx
    );

    const data = (mockTx.inventory_logs.create.mock.calls[0][0] as any).data;
    expect(data.reasonCode).toBe('CORRECTION');
    expect(data.unitCostCents).toBe(1234);
    expect(data.batchId).toBe('batch-abc');
  });

  it('writes null for each when omitted', async () => {
    await createInventoryLog(
      { userId: 1, productId: 7, locationId: 2, delta: 5 },
      mockTx
    );

    const data = (mockTx.inventory_logs.create.mock.calls[0][0] as any).data;
    expect(data.reasonCode).toBeNull();
    expect(data.unitCostCents).toBeNull();
    expect(data.batchId).toBeNull();
  });
});

describe('applyStockDelta — threads the trio into createInventoryLog (P-C1)', () => {
  it('passes reasonCode/unitCostCents/batchId through untouched', async () => {
    await applyStockDelta(mockTx, {
      userId: 9,
      productId: 3,
      locationId: 2,
      delta: -4,
      logType: inventory_logs_logType.CORRECTION,
      reasonCode: 'CORRECTION',
      unitCostCents: 999,
      batchId: 'batch-xyz',
    });

    const data = (mockTx.inventory_logs.create.mock.calls[0][0] as any).data;
    expect(data.logType).toBe(inventory_logs_logType.CORRECTION);
    expect(data.reasonCode).toBe('CORRECTION');
    expect(data.unitCostCents).toBe(999);
    expect(data.batchId).toBe('batch-xyz');
    expect(data.delta).toBe(-4);
  });
});

describe('createInventoryAdjustment — options bag (P-C4)', () => {
  it('record callback fires in-tx AFTER the stock write, with the SAME tx', async () => {
    const record = jest.fn(async (_tx: unknown) => undefined);

    await createInventoryAdjustment(1, 7, 2, 5, {
      logType: inventory_logs_logType.ADJUSTMENT,
      batchId: 'batch-1',
      record,
    });

    // same tx (mock identity)
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toBe(mockTx);
    // AFTER the stock write: the log create was invoked before the recorder
    const logOrder = mockTx.inventory_logs.create.mock.invocationCallOrder[0];
    const recordOrder = record.mock.invocationCallOrder[0];
    expect(logOrder).toBeLessThan(recordOrder);
    // the ledger row carried the batchId from opts
    const data = (mockTx.inventory_logs.create.mock.calls[0][0] as any).data;
    expect(data.batchId).toBe('batch-1');
  });

  it('retry path preserves the same batchId across OptimisticLockError retries', async () => {
    let calls = 0;
    const record = jest.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new OptimisticLockError('conflict', 2, 1);
      }
    });

    await createInventoryAdjustment(1, 7, 2, 5, {
      logType: inventory_logs_logType.ADJUSTMENT,
      batchId: 'batch-retry',
      record,
    });

    // retried once -> two write attempts, both carrying the SAME batchId
    expect(record).toHaveBeenCalledTimes(2);
    expect(mockTx.inventory_logs.create).toHaveBeenCalledTimes(2);
    const first = (mockTx.inventory_logs.create.mock.calls[0][0] as any).data;
    const second = (mockTx.inventory_logs.create.mock.calls[1][0] as any).data;
    expect(first.batchId).toBe('batch-retry');
    expect(second.batchId).toBe('batch-retry');
  });
});

// ---------------------------------------------------------------------------
// THE LOCK DISCIPLINE (Part 2, pack CB1a-i.2). The order is the contract: the
// caller's order lock is the transaction's first act, the canonical prelock
// follows it and precedes the first consistent read of product_locations, and
// both guards read what the prelock returned.
// ---------------------------------------------------------------------------
describe('createInventoryAdjustment — the lock order (B1a-i.2)', () => {
  /** A locking read of the caller's own, exactly as a route's `lockFirst` is. */
  function orderLockHook() {
    return jest.fn(async (tx: Prisma.TransactionClient) => {
      await (tx as unknown as { $queryRaw: (q: unknown) => Promise<unknown> }).$queryRaw(
        Prisma.sql`SELECT id, orderNumber FROM external_orders WHERE id IN (${'ORD-1'}) ORDER BY id FOR UPDATE`
      );
    });
  }

  it('runs opts.lockFirst FIRST — before the prelock, before every delegate', async () => {
    const lockFirst = orderLockHook();

    await createInventoryAdjustment(1, 7, 2, 5, { batchId: 'batch-1', lockFirst });

    expect(lockFirst).toHaveBeenCalledTimes(1);
    expect(lockFirst.mock.calls[0][0]).toBe(mockTx);
    // The hook's locking read, then the prelock's materialize + returning read.
    expect(rawCalls.map((c) => c.kind)).toEqual(['query', 'execute', 'query']);
    expect(rawCalls[0].sql).toContain('external_orders');
    expect(rawCalls[1].sql).toContain('INSERT INTO product_locations');
    expect(rawCalls[2].sql).toContain('FOR UPDATE');
    // …and the whole lock block precedes every delegate write.
    expect(rawFns.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      mockTx.inventory_logs.create.mock.invocationCallOrder[0]
    );
    expect(rawFns.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      mockTx.product_locations.upsert.mock.invocationCallOrder[0]
    );
  });

  it('re-runs opts.lockFirst on every retry attempt', async () => {
    // The hook is a locking read, idempotent by contract — and it MUST re-run,
    // because a retry re-enters the transaction callback with a fresh tx that
    // holds nothing.
    const lockFirst = orderLockHook();
    let calls = 0;
    const record = jest.fn(async () => {
      calls += 1;
      if (calls === 1) throw new OptimisticLockError('conflict', 2, 1);
    });

    await createInventoryAdjustment(1, 7, 2, 5, { lockFirst, record });

    expect(lockFirst).toHaveBeenCalledTimes(2);
    expect(mockTx.inventory_logs.create).toHaveBeenCalledTimes(2);
  });

  it('spends exactly the prelock pair when no hook is supplied', async () => {
    await createInventoryAdjustment(1, 7, 2, 5);

    expect(rawCalls.map((c) => c.kind)).toEqual(['execute', 'query']);
    expect(mockTx.product_locations.findUnique).not.toHaveBeenCalled();
  });

  it('materialize-first: a never-stocked key reads { 0, 0 } and refuses the deduction', async () => {
    // The SELECT answers with the row the materialize just created. A negative
    // delta must refuse against that 0 — never against an absence the old
    // `findUnique` would have returned as null.
    prelocked([{ productId: 7, locationId: 2, quantity: 0, version: 0 }]);
    mockTx.product.findUnique.mockResolvedValue({ name: 'Widget' } as any);

    await expect(createInventoryAdjustment(1, 7, 2, -5)).rejects.toBeInstanceOf(
      InsufficientStockError
    );
    // The prelocked quantity rides into the message. (The two numbers are
    // labelled the way this constructor has always labelled them — positions
    // preserved verbatim from the retired call site.)
    await expect(createInventoryAdjustment(1, 7, 2, -5)).rejects.toThrow(
      'Insufficient stock for Widget. Requested: 0, Available: 5'
    );
    expect(mockTx.inventory_logs.create).not.toHaveBeenCalled();
  });

  it('B1 ACTIVATION: a never-stocked key + a stale expectedVersion now conflicts', async () => {
    // Today the version check was skipped whenever no row existed, so this
    // submission won silently. It is a 409 now.
    prelocked([{ productId: 7, locationId: 2, quantity: 0, version: 0 }]);

    await expect(
      createInventoryAdjustment(1, 7, 2, 5, { expectedVersion: 1 })
    ).rejects.toMatchObject({ name: 'OptimisticLockError', currentVersion: 0, expectedVersion: 1 });

    expect(mockTx.inventory_logs.create).not.toHaveBeenCalled();
    expect(mockTx.product_locations.upsert).not.toHaveBeenCalled();
  });

  it('a matching expectedVersion on a stocked key still writes', async () => {
    prelocked([{ productId: 7, locationId: 2, quantity: 100, version: 4 }]);

    await createInventoryAdjustment(1, 7, 2, 5, { expectedVersion: 4 });

    expect(mockTx.product_locations.upsert).toHaveBeenCalledTimes(1);
  });

  it('spends the covered writers\' transaction budget (REV-22 F3)', async () => {
    // Prisma's interactive defaults (maxWait 2 s / timeout 5 s) are reachable
    // now that these transactions queue on each other's prelocked rows; the
    // budget is explicit, and the same one every covered writer spends.
    await createInventoryAdjustment(1, 7, 2, 5);

    expect((mockPrisma.$transaction as jest.Mock).mock.calls[0][1]).toEqual({
      maxWait: 5000,
      timeout: 30000,
    });
  });
});

describe('centsFromCostPrice — ER-C2 money conversion (never lie)', () => {
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('Decimal("12.34") -> 1234', () => {
    expect(centsFromCostPrice(new Prisma.Decimal('12.34'))).toBe(1234);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('number 12.34 -> 1234', () => {
    expect(centsFromCostPrice(12.34)).toBe(1234);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('0 -> null (unset cost)', () => {
    expect(centsFromCostPrice(0)).toBeNull();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('-5 -> null (never negative)', () => {
    expect(centsFromCostPrice(-5)).toBeNull();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('30000000 -> null + console.error (INT-cents overflow)', () => {
    expect(centsFromCostPrice(30000000)).toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(1);
  });
});

describe('centsFromRetailPrice — W0-RETAIL money conversion (never lie)', () => {
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('null -> null (retail unknown)', () => {
    expect(centsFromRetailPrice(null)).toBeNull();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('Decimal("24.99") -> 2499', () => {
    expect(centsFromRetailPrice(new Prisma.Decimal('24.99'))).toBe(2499);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('number 24.99 -> 2499', () => {
    expect(centsFromRetailPrice(24.99)).toBe(2499);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('numeric string "24.99" -> 2499', () => {
    expect(centsFromRetailPrice('24.99')).toBe(2499);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('0 -> 0 (a stored 0 retail is a deliberately-typed free price, NOT unknown)', () => {
    // Retail semantics DIVERGE from cost here (W0-RETAIL): the migration backfilled
    // every legacy ambiguous 0 to NULL, so a surviving stored 0 is an intentional
    // "genuinely free" price and must round-trip to 0 cents, never collapse to null.
    expect(centsFromRetailPrice(0)).toBe(0);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('Decimal("0") -> 0 (free is a known price, not unknown)', () => {
    expect(centsFromRetailPrice(new Prisma.Decimal('0'))).toBe(0);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('numeric string "0" -> 0', () => {
    expect(centsFromRetailPrice('0')).toBe(0);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('-5 -> null (never negative)', () => {
    expect(centsFromRetailPrice(-5)).toBeNull();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('30000000 -> null + console.error (INT-cents overflow)', () => {
    expect(centsFromRetailPrice(30000000)).toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(1);
  });
});
