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

let mockTx: DeepMockProxy<Prisma.TransactionClient>;

beforeEach(() => {
  mockTx = mockDeep<Prisma.TransactionClient>();
  mockReset(mockTx);
  mockReset(mockPrisma);

  // $transaction drives the real callback with the mocked tx (single attempt).
  (mockPrisma.$transaction as jest.Mock).mockImplementation(
    async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => fn(mockTx)
  );

  // Version-guard read AND validateStockAvailability's getCurrentQuantity both
  // hit product_locations.findUnique — plenty of stock, version 1.
  mockTx.product_locations.findUnique.mockResolvedValue({
    id: 1,
    productId: 7,
    locationId: 1,
    quantity: 100,
    version: 1,
  } as any);
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
    mockTx.product_locations.findUnique.mockResolvedValue({
      id: 2, productId: 7, locationId: 2, quantity: 100, version: 1,
    } as any);

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
    mockTx.product_locations.findUnique.mockResolvedValue({
      id: 1, productId: 7, locationId: 1, quantity: 100, version: 5,
    } as any);

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
    mockTx.product_locations.findUnique.mockResolvedValue({
      id: 1, productId: 7, locationId: 1, quantity: 100, version: 4,
    } as any);

    await createInventoryTransaction('DEDUCTION', 42, [
      { productId: 7, locationId: 1, quantityChange: -5, expectedVersion: 4 },
    ]);

    expect(mockTx.product_locations.upsert).toHaveBeenCalledTimes(1);
  });

  it('negative delta beyond available stock throws InsufficientStockError before any write', async () => {
    mockTx.product_locations.findUnique.mockResolvedValue({
      id: 1, productId: 7, locationId: 1, quantity: 3, version: 1,
    } as any);

    await expect(
      createInventoryTransaction('DEDUCTION', 42, [
        { productId: 7, locationId: 1, quantityChange: -5 },
      ])
    ).rejects.toBeInstanceOf(InsufficientStockError);

    expect(mockTx.inventory_logs.create).not.toHaveBeenCalled();
    expect(mockTx.product_locations.upsert).not.toHaveBeenCalled();
  });
});
