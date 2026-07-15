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

const mockPrisma = prisma as unknown as DeepMockProxy<typeof prisma>;

let mockTx: DeepMockProxy<Prisma.TransactionClient>;

beforeEach(() => {
  mockTx = mockDeep<Prisma.TransactionClient>();
  mockReset(mockTx);
  mockReset(mockPrisma);

  (mockPrisma.$transaction as jest.Mock).mockImplementation(
    async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => fn(mockTx)
  );

  mockTx.inventory_logs.create.mockResolvedValue({ id: 100 } as any);
  mockTx.product_locations.upsert.mockResolvedValue({ version: 7 } as any);
  mockTx.product.update.mockResolvedValue({} as any);
  mockTx.product_locations.findUnique.mockResolvedValue({
    id: 1,
    productId: 7,
    locationId: 2,
    quantity: 100,
    version: 1,
  } as any);
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

  it('0 -> null (0-and-null both mean unknown, matching cost)', () => {
    expect(centsFromRetailPrice(0)).toBeNull();
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
