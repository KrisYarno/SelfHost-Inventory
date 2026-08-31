/**
 * @jest-environment node
 *
 * Unit test for transferId stamping in `createInventoryTransfer`.
 *
 * This repo does NOT use a real test DB. Prisma is mocked with jest-mock-extended
 * (see __tests__/unit/lib/inventory.applyStockDelta.test.ts for the harness this
 * mirrors). createInventoryTransfer runs inside prisma.$transaction, so the
 * singleton's $transaction is wired to invoke its callback with a
 * mockDeep<Prisma.TransactionClient>(); we then assert on the two
 * tx.inventory_logs.create calls the transfer issues.
 */

import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended';
import { Prisma } from '@prisma/client';

jest.mock('@/lib/prisma', () => {
  const { mockDeep: md } = require('jest-mock-extended');
  return { __esModule: true, default: md() };
});

import prisma from '@/lib/prisma';
import { createInventoryTransfer, OptimisticLockError } from '@/lib/inventory';
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
 * What the prelock's returning SELECT hands back. These rows are the fixture
 * the guards read now — the retired `findUnique`s used to be.
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

  // $transaction drives the real callback with the mocked tx
  (mockPrisma.$transaction as jest.Mock).mockImplementation(
    async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => fn(mockTx)
  );

  // Source/destination rows exist with plenty of stock; validation passes. They
  // arrive through the PRELOCK now (pack CB1a-i.3 retired the paired
  // findUniques) — same fixture, new door.
  prelocked([
    { productId: 7, locationId: 2, quantity: 100, version: 1 },
    { productId: 7, locationId: 3, quantity: 100, version: 1 },
  ]);
  mockTx.inventory_logs.create.mockResolvedValue({ id: 100 } as any);
  mockTx.product_locations.upsert.mockResolvedValue({ version: 2 } as any);
  mockTx.product.update.mockResolvedValue({} as any);
});

test('createInventoryTransfer stamps the SAME transferId on both log rows', async () => {
  await createInventoryTransfer({
    userId: 1,
    productId: 7,
    fromLocationId: 2,
    toLocationId: 3,
    quantity: 5,
  });

  const creates = mockTx.inventory_logs.create.mock.calls.map(
    (call) => (call[0] as any).data
  );
  expect(creates).toHaveLength(2);
  expect(creates[0].transferId).toBeDefined();
  expect(creates[0].transferId).toMatch(/^[0-9a-f-]{36}$/);
  expect(creates[0].transferId).toBe(creates[1].transferId);
});

test('createInventoryTransfer stamps the caller batchId on BOTH log rows (P-C1 join)', async () => {
  await createInventoryTransfer({
    userId: 1,
    productId: 7,
    fromLocationId: 2,
    toLocationId: 3,
    quantity: 5,
    batchId: 'BATCH-XYZ',
  });

  const creates = mockTx.inventory_logs.create.mock.calls.map(
    (call) => (call[0] as any).data
  );
  expect(creates).toHaveLength(2);
  expect(creates[0].batchId).toBe('BATCH-XYZ');
  expect(creates[1].batchId).toBe('BATCH-XYZ');
});

// ---------------------------------------------------------------------------
// THE LOCK DISCIPLINE (Part 2, pack CB1a-i.3). A transfer touches TWO
// product_locations rows, which is the shape a lock order exists for: two
// transfers over the same pair in opposite directions must still take the rows
// in the same order, so both ends ride in ONE prelock, canonically sorted.
// ---------------------------------------------------------------------------

test('takes BOTH ends in ONE prelock, in canonical key order (not the asked order)', async () => {
  // Asked from 5 → to 2; canonical order is (7,2) then (7,5).
  prelocked([
    { productId: 7, locationId: 2, quantity: 100, version: 1 },
    { productId: 7, locationId: 5, quantity: 100, version: 1 },
  ]);

  await createInventoryTransfer({
    userId: 1,
    productId: 7,
    fromLocationId: 5,
    toLocationId: 2,
    quantity: 5,
  });

  // Exactly two raw statements: the materialize, then the returning locking read.
  expect(rawCalls.map((c) => c.kind)).toEqual(['execute', 'query']);
  expect(rawArg(rawFns.$executeRaw).values).toEqual([7, 2, 7, 5]);
  expect(rawArg(rawFns.$queryRaw).values).toEqual([7, 2, 7, 5]);
});

test('the prelock precedes every delegate write', async () => {
  await createInventoryTransfer({
    userId: 1,
    productId: 7,
    fromLocationId: 2,
    toLocationId: 3,
    quantity: 5,
  });

  // `invocationCallOrder` is global across jest mocks, which is what lets a raw
  // statement be ordered against a delegate call.
  const materialize = rawFns.$executeRaw.mock.invocationCallOrder[0];
  const lockingRead = rawFns.$queryRaw.mock.invocationCallOrder[0];
  const firstLog = mockTx.inventory_logs.create.mock.invocationCallOrder[0];
  const firstUpsert = mockTx.product_locations.upsert.mock.invocationCallOrder[0];

  expect(materialize).toBeLessThan(lockingRead);
  expect(lockingRead).toBeLessThan(firstLog);
  expect(lockingRead).toBeLessThan(firstUpsert);
});

test('a NEVER-STOCKED destination + a stale expectedToVersion now conflicts (B1 activation)', async () => {
  // Today's code skipped the version check when the destination row did not
  // exist, so a stale submission won silently. After the materialize the key
  // reads { 0, 0 } and the check ALWAYS runs.
  prelocked([
    { productId: 7, locationId: 2, quantity: 100, version: 1 },
    { productId: 7, locationId: 3, quantity: 0, version: 0 },
  ]);

  await expect(
    createInventoryTransfer({
      userId: 1,
      productId: 7,
      fromLocationId: 2,
      toLocationId: 3,
      quantity: 5,
      expectedToVersion: 1,
    })
  ).rejects.toBeInstanceOf(OptimisticLockError);

  expect(mockTx.inventory_logs.create).not.toHaveBeenCalled();
  expect(mockTx.product_locations.upsert).not.toHaveBeenCalled();
});

test('a stale expectedFromVersion conflicts on the prelocked source version', async () => {
  prelocked([
    { productId: 7, locationId: 2, quantity: 100, version: 4 },
    { productId: 7, locationId: 3, quantity: 100, version: 1 },
  ]);

  await expect(
    createInventoryTransfer({
      userId: 1,
      productId: 7,
      fromLocationId: 2,
      toLocationId: 3,
      quantity: 5,
      expectedFromVersion: 3,
    })
  ).rejects.toMatchObject({ name: 'OptimisticLockError', currentVersion: 4, expectedVersion: 3 });

  expect(mockTx.inventory_logs.create).not.toHaveBeenCalled();
});

test('availability reads the PRELOCKED source quantity', async () => {
  prelocked([
    { productId: 7, locationId: 2, quantity: 3, version: 1 },
    { productId: 7, locationId: 3, quantity: 100, version: 1 },
  ]);
  mockTx.product.findUnique.mockResolvedValue({ name: 'Widget' } as any);

  await expect(
    createInventoryTransfer({
      userId: 1,
      productId: 7,
      fromLocationId: 2,
      toLocationId: 3,
      quantity: 5,
    })
  ).rejects.toBeInstanceOf(InsufficientStockError);

  // The failure-path product-name read stays (a `products` consistent read —
  // the named residual outside the canonical order).
  expect(mockTx.product.findUnique).toHaveBeenCalledTimes(1);
  expect(mockTx.inventory_logs.create).not.toHaveBeenCalled();
});
