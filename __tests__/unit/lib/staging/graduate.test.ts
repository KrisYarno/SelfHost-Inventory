/**
 * @jest-environment node
 *
 * Unit tests for `graduateStagingItem` (lib/staging/graduate.ts).
 *
 * This repo does NOT use a real test DB. Prisma is mocked with jest-mock-extended
 * (canonical pattern: __tests__/unit/fulfillment-concurrency.test.ts). We:
 *   - mock `@/lib/prisma` default export and drive `$transaction` by invoking its
 *     callback with a mockDeep<Prisma.TransactionClient>() `tx`;
 *   - mock `@/lib/inventory` so `applyStockDelta` is a spy (assert it's called with
 *     the right delta) and `withDeadlockRetry` just runs its fn once.
 *
 * Assertions target the mocked tx calls:
 *   - the atomic claim: tx.stagingItem.updateMany WHERE { id, status: 'RECEIVED' };
 *   - new-product branch -> tx.product.create with approvalStatus + createdBy;
 *   - existing branch -> tx.product.findFirst, no status change;
 *   - stock-in -> applyStockDelta(tx, { delta: countedQuantity });
 *   - finalize -> tx.stagingItem.update with resolvedProductId + countedQuantity;
 *   - claim count===0 -> throws AppError 409.
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
  // run the fn once; the deadlock-retry behavior itself is covered in lib/inventory tests
  withDeadlockRetry: (fn: () => Promise<any>) => fn(),
  // Phase C (Task 4): graduate.ts now freezes STOCK_IN unitCostCents via the real
  // ER-C2 helper — provide it unmocked so the conversion runs.
  centsFromCostPrice: jest.requireActual('@/lib/inventory').centsFromCostPrice,
}));

import prisma from '@/lib/prisma';
import { graduateStagingItem } from '@/lib/staging/graduate';
import { AppError } from '@/lib/error-handling';

const getMockPrisma = () => prisma as unknown as DeepMockProxy<typeof prisma>;

let mockTx: DeepMockProxy<Prisma.TransactionClient>;

function setupTransaction() {
  mockTx = mockDeep<Prisma.TransactionClient>();
  getMockPrisma().$transaction.mockImplementation(async (cb: any) => cb(mockTx));
  // default: claim succeeds
  mockTx.stagingItem.updateMany.mockResolvedValue({ count: 1 } as any);
  mockTx.stagingItem.update.mockResolvedValue({} as any);
  mockApplyStockDelta.mockResolvedValue({ log: { id: 1 }, newVersion: 1 });
}

const newFields = {
  baseName: 'Test Peptide',
  variant: '10mg',
  unit: 'mg',
  numericValue: 10,
  lowStockThreshold: 5,
  costPrice: 1.5,
  retailPrice: 3,
  locationId: 1,
};

beforeEach(() => {
  mockReset(getMockPrisma());
  mockApplyStockDelta.mockReset();
  setupTransaction();
});

describe('graduateStagingItem — concurrency claim', () => {
  it('throws a 409 AppError when the claim affects 0 rows (already graduated/discarded)', async () => {
    mockTx.stagingItem.updateMany.mockResolvedValue({ count: 0 } as any);

    await expect(
      graduateStagingItem(
        99,
        { mode: 'existing', productId: 1, countedQuantity: 5, locationId: 1 },
        { id: 42, isAdmin: false }
      )
    ).rejects.toMatchObject({ statusCode: 409 });

    // verify it's specifically an AppError
    await expect(
      graduateStagingItem(
        99,
        { mode: 'existing', productId: 1, countedQuantity: 5, locationId: 1 },
        { id: 42, isAdmin: false }
      )
    ).rejects.toBeInstanceOf(AppError);

    // no product resolution / stock-in once the claim fails
    expect(mockTx.product.findFirst).not.toHaveBeenCalled();
    expect(mockApplyStockDelta).not.toHaveBeenCalled();
  });

  it('claims with WHERE { id, status: RECEIVED } and stamps graduatedBy/At', async () => {
    mockTx.product.findFirst.mockResolvedValue({
      id: 7,
      approvalStatus: 'APPROVED',
      deletedAt: null,
    } as any);

    await graduateStagingItem(
      55,
      { mode: 'existing', productId: 7, countedQuantity: 5, locationId: 1 },
      { id: 42, isAdmin: false }
    );

    expect(mockTx.stagingItem.updateMany).toHaveBeenCalledTimes(1);
    const claimArg = mockTx.stagingItem.updateMany.mock.calls[0][0] as any;
    expect(claimArg.where).toEqual({ id: 55, status: 'RECEIVED' });
    expect(claimArg.data.status).toBe('GRADUATED');
    expect(claimArg.data.graduatedBy).toBe(42);
    expect(claimArg.data.graduatedAt).toBeInstanceOf(Date);
  });
});

describe('graduateStagingItem — existing product (restock)', () => {
  it('restocks an existing product, leaves approvalStatus unchanged, applies +qty, finalizes', async () => {
    mockTx.product.findFirst.mockResolvedValue({
      id: 7,
      approvalStatus: 'PENDING_REVIEW',
      deletedAt: null,
    } as any);

    const result = await graduateStagingItem(
      55,
      { mode: 'existing', productId: 7, countedQuantity: 12, locationId: 3 },
      { id: 42, isAdmin: false }
    );

    // resolved by findFirst with deletedAt: null
    const findArg = mockTx.product.findFirst.mock.calls[0][0] as any;
    expect(findArg.where).toEqual({ id: 7, deletedAt: null });
    // never creates a product on the existing path
    expect(mockTx.product.create).not.toHaveBeenCalled();

    // stock-in delta === countedQuantity, at the requested location
    expect(mockApplyStockDelta).toHaveBeenCalledTimes(1);
    const [txArg, deltaArgs] = mockApplyStockDelta.mock.calls[0];
    expect(txArg).toBe(mockTx);
    expect(deltaArgs).toMatchObject({
      userId: 42,
      productId: 7,
      locationId: 3,
      delta: 12,
    });

    // finalize sets resolvedProductId + countedQuantity
    const finalArg = mockTx.stagingItem.update.mock.calls[0][0] as any;
    expect(finalArg.where).toEqual({ id: 55 });
    expect(finalArg.data).toEqual({ resolvedProductId: 7, countedQuantity: 12 });

    // restocking does NOT flip status
    expect(result).toEqual({
      productId: 7,
      approvalStatus: 'PENDING_REVIEW',
      locationId: 3,
      countedQuantity: 12,
    });
  });

  it('throws a 400 AppError when the existing target is missing/soft-deleted', async () => {
    mockTx.product.findFirst.mockResolvedValue(null);

    await expect(
      graduateStagingItem(
        55,
        { mode: 'existing', productId: 7, countedQuantity: 5, locationId: 1 },
        { id: 42, isAdmin: false }
      )
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(mockApplyStockDelta).not.toHaveBeenCalled();
  });
});

describe('graduateStagingItem — new product (provisional)', () => {
  it('non-admin creates a PENDING_REVIEW product with createdBy, then stocks in', async () => {
    mockTx.product.create.mockResolvedValue({
      id: 101,
      approvalStatus: 'PENDING_REVIEW',
    } as any);

    const result = await graduateStagingItem(
      55,
      { mode: 'new', productFields: newFields, countedQuantity: 8, locationId: 1 },
      { id: 42, isAdmin: false }
    );

    expect(mockTx.product.create).toHaveBeenCalledTimes(1);
    const data = (mockTx.product.create.mock.calls[0][0] as any).data;
    expect(data.approvalStatus).toBe('PENDING_REVIEW');
    expect(data.createdBy).toBe(42);
    // mirrors POST /api/products field mapping
    expect(data.name).toBe('Test Peptide 10mg');
    expect(data.baseName).toBe('Test Peptide');
    expect(data.variant).toBe('10mg');
    expect(data.unit).toBe('mg');
    expect(data.numericValue).toBe(10);
    expect(data.quantity).toBe(0);
    expect(data.location).toBe(1);
    expect(data.lowStockThreshold).toBe(5);
    expect(data.costPrice).toBe(1.5);
    expect(data.retailPrice).toBe(3);

    expect(mockApplyStockDelta).toHaveBeenCalledTimes(1);
    expect(mockApplyStockDelta.mock.calls[0][1]).toMatchObject({
      productId: 101,
      delta: 8,
      locationId: 1,
    });

    expect(result).toEqual({
      productId: 101,
      approvalStatus: 'PENDING_REVIEW',
      locationId: 1,
      countedQuantity: 8,
    });
  });

  it('admin creates an APPROVED product', async () => {
    mockTx.product.create.mockResolvedValue({
      id: 102,
      approvalStatus: 'APPROVED',
    } as any);

    const result = await graduateStagingItem(
      55,
      { mode: 'new', productFields: newFields, countedQuantity: 4, locationId: 1 },
      { id: 1, isAdmin: true }
    );

    const data = (mockTx.product.create.mock.calls[0][0] as any).data;
    expect(data.approvalStatus).toBe('APPROVED');
    expect(data.createdBy).toBe(1);
    expect(result.approvalStatus).toBe('APPROVED');
  });

  it('defaults lowStockThreshold to 10 and prices to 0 when omitted', async () => {
    mockTx.product.create.mockResolvedValue({
      id: 103,
      approvalStatus: 'PENDING_REVIEW',
    } as any);

    await graduateStagingItem(
      55,
      {
        mode: 'new',
        productFields: { baseName: 'Bare', variant: 'x', locationId: 1 } as any,
        countedQuantity: 1,
        locationId: 1,
      },
      { id: 42, isAdmin: false }
    );

    const data = (mockTx.product.create.mock.calls[0][0] as any).data;
    expect(data.lowStockThreshold).toBe(10);
    expect(data.costPrice).toBe(0);
    expect(data.retailPrice).toBe(0);
    expect(data.unit).toBeNull();
    expect(data.numericValue).toBeNull();
  });
});
