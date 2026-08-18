/**
 * @jest-environment node
 *
 * Unit tests for `applyStockDelta` — the extracted hot-path write block shared
 * by every stock route (and, later, pre-staging graduation/decline).
 *
 * This repo does NOT use a real test DB. Prisma is mocked with jest-mock-extended
 * (see __tests__/unit/fulfillment-concurrency.test.ts for the canonical pattern).
 * `applyStockDelta` takes a `tx` (TransactionClient), so we drive it with a
 * mockDeep<Prisma.TransactionClient>() and assert the exact Prisma call sequence:
 *
 *   1. createInventoryLog(..., tx)  -> tx.inventory_logs.create  (delta passed through)
 *   2. tx.product_locations.upsert  (update.quantity.increment === delta, version.increment === 1)
 *   3. if locationId === 1          -> tx.product.update (quantity.increment === delta)
 *
 * createInventoryLog is the REAL implementation here (only `tx` is mocked), so the
 * inventory_logs.create assertion validates the actual log write the hot path issues.
 */

import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended';
import { Prisma, inventory_logs_logType } from '@prisma/client';

// `@/lib/prisma` is the singleton client. applyStockDelta never touches it
// (it operates on the passed-in tx), but lib/inventory imports it at module load,
// so provide a harmless mock to keep the import graph clean.
jest.mock('@/lib/prisma', () => {
  const { mockDeep: md } = require('jest-mock-extended');
  return { __esModule: true, default: md() };
});

import { applyStockDelta } from '@/lib/inventory';

let mockTx: DeepMockProxy<Prisma.TransactionClient>;

beforeEach(() => {
  mockTx = mockDeep<Prisma.TransactionClient>();
  mockReset(mockTx);
  // createInventoryLog returns the created row; upsert return is used for newVersion.
  mockTx.inventory_logs.create.mockResolvedValue({ id: 100 } as any);
  mockTx.product_locations.upsert.mockResolvedValue({ version: 7 } as any);
  mockTx.product.update.mockResolvedValue({} as any);
});

describe('applyStockDelta', () => {
  it('locationId === 1: writes log + upsert (qty/version increment) + product mirror', async () => {
    const result = await applyStockDelta(mockTx, {
      userId: 1,
      productId: 7,
      locationId: 1,
      delta: 5,
    });

    // 1. inventory_logs.create — the log carries the delta and the productId/locationId
    expect(mockTx.inventory_logs.create).toHaveBeenCalledTimes(1);
    const logArg = mockTx.inventory_logs.create.mock.calls[0][0] as any;
    expect(logArg.data.delta).toBe(5);
    expect(logArg.data.productId).toBe(7);
    expect(logArg.data.locationId).toBe(1);
    expect(logArg.data.userId).toBe(1);
    // default logType when not provided
    expect(logArg.data.logType).toBe(inventory_logs_logType.ADJUSTMENT);

    // 2. product_locations.upsert — increment quantity by delta, version by 1
    expect(mockTx.product_locations.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = mockTx.product_locations.upsert.mock.calls[0][0] as any;
    expect(upsertArg.where.productId_locationId).toEqual({
      productId: 7,
      locationId: 1,
    });
    expect(upsertArg.update.quantity.increment).toBe(5);
    expect(upsertArg.update.version.increment).toBe(1);
    expect(upsertArg.create).toEqual({
      productId: 7,
      locationId: 1,
      quantity: 5,
      version: 1,
    });

    // 3. product.update — loc-1 legacy mirror, increment by delta
    expect(mockTx.product.update).toHaveBeenCalledTimes(1);
    const prodArg = mockTx.product.update.mock.calls[0][0] as any;
    expect(prodArg.where).toEqual({ id: 7 });
    expect(prodArg.data.quantity.increment).toBe(5);

    // return shape preserved for createInventoryAdjustment's contract
    expect(result.log).toEqual({ id: 100 });
    expect(result.newVersion).toBe(7);
  });

  it('locationId !== 1: does NOT touch the legacy Product.quantity mirror', async () => {
    await applyStockDelta(mockTx, {
      userId: 1,
      productId: 7,
      locationId: 2,
      delta: 5,
    });

    // log + upsert still happen
    expect(mockTx.inventory_logs.create).toHaveBeenCalledTimes(1);
    expect(mockTx.product_locations.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = mockTx.product_locations.upsert.mock.calls[0][0] as any;
    expect(upsertArg.update.quantity.increment).toBe(5);
    expect(upsertArg.update.version.increment).toBe(1);

    // loc-1-only reconcile must NOT fire for locationId 2
    expect(mockTx.product.update).not.toHaveBeenCalled();
  });

  it('passes the Receiving/Labeling refs straight through to the log row', async () => {
    // C2a.5: stagingItemId / receiptCostCents / bookingKey are PURE passthroughs.
    // applyStockDelta adds no semantics of its own — the booking primitive
    // decides the values, this hot path only stores them. bookingKey is what
    // makes a retried request book once (UNIQUE with stagingItemId), so a hop
    // that quietly dropped it would turn a retry into a double booking.
    await applyStockDelta(mockTx, {
      userId: 4,
      productId: 11,
      locationId: 2,
      delta: 6,
      logType: inventory_logs_logType.STOCK_IN,
      stagingItemId: 88,
      receiptCostCents: 3334,
      bookingKey: '3f1d5b0e-9d1c-4a6b-8f2e-7c1a0b5d9e42',
    });

    const logArg = mockTx.inventory_logs.create.mock.calls[0][0] as any;
    expect(logArg.data.stagingItemId).toBe(88);
    expect(logArg.data.receiptCostCents).toBe(3334);
    expect(logArg.data.bookingKey).toBe('3f1d5b0e-9d1c-4a6b-8f2e-7c1a0b5d9e42');
  });

  it('defaults the three new refs to NULL for every existing caller', async () => {
    // Existing callers are UNCHANGED by this milestone: omitting the fields must
    // write explicit NULLs, never undefined (which Prisma would treat as "leave
    // the column out" and which a later reader cannot distinguish from a miss).
    await applyStockDelta(mockTx, {
      userId: 1,
      productId: 7,
      locationId: 1,
      delta: 5,
    });

    const logArg = mockTx.inventory_logs.create.mock.calls[0][0] as any;
    expect(logArg.data.stagingItemId).toBeNull();
    expect(logArg.data.receiptCostCents).toBeNull();
    expect(logArg.data.bookingKey).toBeNull();
  });

  it('a receiptCostCents of NULL is preserved (an unpriced batch is not a free one)', async () => {
    // Truthful data: a line with no total cannot say what a batch cost, and 0
    // would read as "this batch was free".
    await applyStockDelta(mockTx, {
      userId: 4,
      productId: 11,
      locationId: 2,
      delta: 6,
      stagingItemId: 88,
      receiptCostCents: null,
      bookingKey: 'b0b0b0b0-0000-4000-8000-000000000001',
    });

    const logArg = mockTx.inventory_logs.create.mock.calls[0][0] as any;
    expect(logArg.data.stagingItemId).toBe(88);
    expect(logArg.data.receiptCostCents).toBeNull();
  });

  it('passes through an explicit logType and negative deltas unchanged', async () => {
    await applyStockDelta(mockTx, {
      userId: 9,
      productId: 3,
      locationId: 1,
      delta: -4,
      logType: inventory_logs_logType.TRANSFER,
    });

    const logArg = mockTx.inventory_logs.create.mock.calls[0][0] as any;
    expect(logArg.data.logType).toBe(inventory_logs_logType.TRANSFER);
    expect(logArg.data.delta).toBe(-4);

    const upsertArg = mockTx.product_locations.upsert.mock.calls[0][0] as any;
    expect(upsertArg.update.quantity.increment).toBe(-4);
    // create branch mirrors the (negative) delta verbatim, as in the original block
    expect(upsertArg.create.quantity).toBe(-4);

    const prodArg = mockTx.product.update.mock.calls[0][0] as any;
    expect(prodArg.data.quantity.increment).toBe(-4);
  });
});
