/**
 * @jest-environment node
 *
 * Unit tests for `declineProduct` (lib/products/decline.ts).
 *
 * Prisma is mocked with jest-mock-extended (no real test DB). We:
 *   - mock `@/lib/prisma` default export and drive `$transaction` by invoking its
 *     callback with a mockDeep<Prisma.TransactionClient>() `tx`;
 *   - mock `@/lib/inventory` so `applyStockDelta` is a spy and `withDeadlockRetry`
 *     just runs its fn once.
 *
 * The FOR UPDATE select is issued via `tx.$queryRaw`; we mock its return to drive
 * the multi-location reversal. Assertions: a negative applyStockDelta per location
 * with qty > 0, the soft-delete happens LAST (lock order: product_locations first),
 * and declining an already-soft-deleted product is an idempotent no-op.
 */

import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended';
import { Prisma } from '@prisma/client';

jest.mock('@/lib/prisma', () => {
  const { mockDeep: md } = require('jest-mock-extended');
  return { __esModule: true, default: md() };
});

const mockApplyStockDelta = jest.fn();
jest.mock('@/lib/inventory', () => ({
  __esModule: true,
  applyStockDelta: (...args: any[]) => mockApplyStockDelta(...args),
  withDeadlockRetry: (fn: () => Promise<any>) => fn(),
}));

import prisma from '@/lib/prisma';
import { declineProduct } from '@/lib/products/decline';

const getMockPrisma = () => prisma as unknown as DeepMockProxy<typeof prisma>;

let mockTx: DeepMockProxy<Prisma.TransactionClient>;

function setupTransaction() {
  mockTx = mockDeep<Prisma.TransactionClient>();
  getMockPrisma().$transaction.mockImplementation(async (cb: any) => cb(mockTx));
  mockTx.product.update.mockResolvedValue({} as any);
  mockApplyStockDelta.mockResolvedValue({ log: { id: 1 }, newVersion: 1 });
}

beforeEach(() => {
  mockReset(getMockPrisma());
  mockApplyStockDelta.mockReset();
  setupTransaction();
});

describe('declineProduct — multi-location reversal', () => {
  it('reverses each location with qty>0, then soft-deletes the product LAST', async () => {
    mockTx.product.findUnique.mockResolvedValue({
      id: 10,
      deletedAt: null,
      approvalStatus: 'PENDING_REVIEW',
    } as any);
    // FOR UPDATE returns two locations with stock
    mockTx.$queryRaw.mockResolvedValue([
      { id: 1, locationId: 1, quantity: 5 },
      { id: 2, locationId: 2, quantity: 3 },
    ] as any);

    const result = await declineProduct(10, { id: 99 });

    // one compensating, NEGATIVE applyStockDelta per location
    expect(mockApplyStockDelta).toHaveBeenCalledTimes(2);
    const calls = mockApplyStockDelta.mock.calls.map((c) => c[1]);
    expect(calls[0]).toMatchObject({ productId: 10, locationId: 1, delta: -5, userId: 99 });
    expect(calls[1]).toMatchObject({ productId: 10, locationId: 2, delta: -3, userId: 99 });

    // soft-delete sets the four stamps, leaves approvalStatus untouched
    expect(mockTx.product.update).toHaveBeenCalledTimes(1);
    const updArg = mockTx.product.update.mock.calls[0][0] as any;
    expect(updArg.where).toEqual({ id: 10 });
    expect(updArg.data.deletedAt).toBeInstanceOf(Date);
    expect(updArg.data.deletedBy).toBe(99);
    expect(updArg.data.reviewedBy).toBe(99);
    expect(updArg.data.reviewedAt).toBeInstanceOf(Date);
    expect(updArg.data.approvalStatus).toBeUndefined();

    // lock order: the FOR UPDATE select runs before the soft-delete
    expect(mockTx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockTx.product.update.mock.invocationCallOrder[0]
    );

    expect(result).toEqual({ reversed: true, alreadyDeclined: false });
  });

  it('skips locations whose quantity is already 0 (never goes negative)', async () => {
    mockTx.product.findUnique.mockResolvedValue({
      id: 10,
      deletedAt: null,
      approvalStatus: 'PENDING_REVIEW',
    } as any);
    mockTx.$queryRaw.mockResolvedValue([
      { id: 1, locationId: 1, quantity: 0 },
      { id: 2, locationId: 2, quantity: 4 },
    ] as any);

    await declineProduct(10, { id: 99 });

    // only the qty>0 location is reversed
    expect(mockApplyStockDelta).toHaveBeenCalledTimes(1);
    expect(mockApplyStockDelta.mock.calls[0][1]).toMatchObject({
      locationId: 2,
      delta: -4,
    });
    // still soft-deletes
    expect(mockTx.product.update).toHaveBeenCalledTimes(1);
  });

  it('soft-deletes with no reversal when there is no stock anywhere', async () => {
    mockTx.product.findUnique.mockResolvedValue({
      id: 10,
      deletedAt: null,
      approvalStatus: 'PENDING_REVIEW',
    } as any);
    mockTx.$queryRaw.mockResolvedValue([] as any);

    const result = await declineProduct(10, { id: 99 });

    expect(mockApplyStockDelta).not.toHaveBeenCalled();
    expect(mockTx.product.update).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ reversed: true, alreadyDeclined: false });
  });
});

describe('declineProduct — idempotency', () => {
  it('is a no-op when the product is already soft-deleted (no reversal, no second delete)', async () => {
    mockTx.product.findUnique.mockResolvedValue({
      id: 10,
      deletedAt: new Date(),
      approvalStatus: 'PENDING_REVIEW',
    } as any);

    const result = await declineProduct(10, { id: 99 });

    expect(mockTx.$queryRaw).not.toHaveBeenCalled();
    expect(mockApplyStockDelta).not.toHaveBeenCalled();
    expect(mockTx.product.update).not.toHaveBeenCalled();
    expect(result).toEqual({ reversed: false, alreadyDeclined: true });
  });

  it('is a no-op when the product does not exist', async () => {
    mockTx.product.findUnique.mockResolvedValue(null);

    const result = await declineProduct(404, { id: 99 });

    expect(mockTx.$queryRaw).not.toHaveBeenCalled();
    expect(mockApplyStockDelta).not.toHaveBeenCalled();
    expect(mockTx.product.update).not.toHaveBeenCalled();
    expect(result).toEqual({ reversed: false, alreadyDeclined: true });
  });
});

// ---------------------------------------------------------------------------
// Phase C (DECLINE SEAM FIX / P-C2): the reversal is now a CORRECTION carrying
// the shared batchId, and the caller's recordChange joins THIS retried tx via
// the optional `record` callback (hard-abort restored). These pin both.
// ---------------------------------------------------------------------------
describe('declineProduct — Phase C ledger semantics + record seam', () => {
  it('reverses stock as CORRECTION + reasonCode, stamped with the shared batchId', async () => {
    mockTx.product.findUnique.mockResolvedValue({ id: 10, deletedAt: null } as any);
    mockTx.$queryRaw.mockResolvedValue([
      { id: 1, locationId: 1, quantity: 5 },
    ] as any);

    await declineProduct(10, { id: 99 }, { batchId: 'batch-decline-1' });

    expect(mockApplyStockDelta).toHaveBeenCalledTimes(1);
    expect(mockApplyStockDelta.mock.calls[0][1]).toMatchObject({
      productId: 10,
      locationId: 1,
      delta: -5,
      userId: 99,
      logType: 'CORRECTION',
      reasonCode: 'CORRECTION',
      batchId: 'batch-decline-1',
    });
  });

  it('records the change on the SAME (retried) tx as the reversal, after it (mock identity)', async () => {
    mockTx.product.findUnique.mockResolvedValue({ id: 10, deletedAt: null } as any);
    mockTx.$queryRaw.mockResolvedValue([
      { id: 1, locationId: 1, quantity: 5 },
    ] as any);

    const record = jest.fn(async (_tx: any, _ctx: any) => {});
    const result = await declineProduct(10, { id: 99 }, { record, batchId: 'b1' });

    expect(record).toHaveBeenCalledTimes(1);
    // Same tx object drove both the stock write and the audit write.
    expect(record.mock.calls[0][0]).toBe(mockTx);
    expect(mockApplyStockDelta.mock.calls[0][0]).toBe(mockTx);
    // ctx carries the DeclineResult.
    expect(record.mock.calls[0][1]).toEqual({ reversed: true, alreadyDeclined: false });
    expect(result).toEqual({ reversed: true, alreadyDeclined: false });
    // The reversal + soft-delete happen BEFORE the record call.
    expect(mockApplyStockDelta.mock.invocationCallOrder[0]).toBeLessThan(
      record.mock.invocationCallOrder[0]
    );
    expect(mockTx.product.update.mock.invocationCallOrder[0]).toBeLessThan(
      record.mock.invocationCallOrder[0]
    );
  });

  it('still records (no-op ctx) on the already-declined path, no reversal', async () => {
    mockTx.product.findUnique.mockResolvedValue({ id: 10, deletedAt: new Date() } as any);

    const record = jest.fn(async (_tx: any, _ctx: any) => {});
    const result = await declineProduct(10, { id: 99 }, { record });

    expect(mockApplyStockDelta).not.toHaveBeenCalled();
    expect(mockTx.product.update).not.toHaveBeenCalled();
    // The audit event is still emitted, on the same tx, with the no-op ctx.
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toBe(mockTx);
    expect(record.mock.calls[0][1]).toEqual({ reversed: false, alreadyDeclined: true });
    expect(result).toEqual({ reversed: false, alreadyDeclined: true });
  });
});
