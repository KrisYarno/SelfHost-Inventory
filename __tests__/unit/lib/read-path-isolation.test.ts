/**
 * @jest-environment node
 *
 * Read-path isolation unit tests (Pre-Staging Inventory, Task 11).
 *
 * A PENDING_REVIEW ("provisional") product is real stock that physically
 * exists, so it stays VISIBLE in browse/search/detail, but it must be EXCLUDED
 * from every operational / outward / decision read path until an admin approves
 * it. These tests pin that contract at the lib layer (the shared helpers that
 * back the reports/cron/sync surfaces), plus one SHOW-site guard proving the
 * provisional product is NOT filtered out of the main inventory list.
 *
 * Prisma (and stock-checker's email dep) are mocked with jest-mock-extended
 * — no real DB. We assert on the `where` clause passed to `prisma.*.findMany`.
 */

import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended';

jest.mock('@/lib/prisma', () => {
  const { mockDeep: md } = require('jest-mock-extended');
  return { __esModule: true, default: md() };
});

// stock-checker imports the email service at module load; stub it so
// the module under test can be imported without real transports.
jest.mock('@/lib/email', () => ({
  __esModule: true,
  emailService: { sendLowStockDigest: jest.fn(), sendMinimumsDigest: jest.fn() },
}));

import prisma from '@/lib/prisma';
import { stockChecker } from '@/lib/stock-checker';
import { computeBundleStockStatus } from '@/lib/stock-sync/compute-bundle-status';
import { getProductsWithQuantities } from '@/lib/products';
import { syncPricesForIntegration } from '@/lib/external-orders/price-sync';

const getMockPrisma = () => prisma as unknown as DeepMockProxy<typeof prisma>;

beforeEach(() => {
  mockReset(getMockPrisma());
});

// ===========================================================================
// EXCLUDE sites — the product `where` must carry approvalStatus: 'APPROVED'
// ===========================================================================

describe('EXCLUDE: low-stock / minimums shared helper (lib/stock-checker.ts)', () => {
  it('checkLowStock queries products with approvalStatus: APPROVED', async () => {
    getMockPrisma().product.findMany.mockResolvedValue([] as any);

    await stockChecker.checkLowStock();

    expect(getMockPrisma().product.findMany).toHaveBeenCalledTimes(1);
    const arg = getMockPrisma().product.findMany.mock.calls[0][0] as any;
    expect(arg.where).toMatchObject({
      deletedAt: null,
      approvalStatus: 'APPROVED',
    });
  });

  it('checkMinimums queries products with approvalStatus: APPROVED', async () => {
    getMockPrisma().product.findMany.mockResolvedValue([] as any);

    await stockChecker.checkMinimums();

    expect(getMockPrisma().product.findMany).toHaveBeenCalledTimes(1);
    const arg = getMockPrisma().product.findMany.mock.calls[0][0] as any;
    expect(arg.where).toMatchObject({
      deletedAt: null,
      approvalStatus: 'APPROVED',
    });
  });
});

describe('EXCLUDE: outward price sync (lib/external-orders/price-sync.ts)', () => {
  it('only selects APPROVED products as price-sync candidates', async () => {
    getMockPrisma().product.findMany.mockResolvedValue([] as any);

    await syncPricesForIntegration('int-1');

    expect(getMockPrisma().product.findMany).toHaveBeenCalledTimes(1);
    const arg = getMockPrisma().product.findMany.mock.calls[0][0] as any;
    expect(arg.where).toMatchObject({
      deletedAt: null,
      approvalStatus: 'APPROVED',
    });
  });
});

// ===========================================================================
// EXCLUDE: bundle stock status — a provisional component forces outofstock
// (mirrors the existing soft-deleted-orphan rule).
// ===========================================================================

describe('EXCLUDE: compute-bundle-status provisional component', () => {
  const approvedComp = (overrides: Record<string, unknown> = {}) => ({
    productLinkId: 'bl1',
    internalProductId: 1,
    quantity: 1,
    sortOrder: 0,
    internalProduct: {
      id: 1,
      name: 'Approved component',
      deletedAt: null,
      approvalStatus: 'APPROVED',
      product_locations: [{ locationId: 1, quantity: 10 }],
    },
    ...overrides,
  });

  it('returns outofstock (with orphan warning) when a component is PENDING_REVIEW, even with stock on hand', async () => {
    getMockPrisma().bundleComponent.findMany.mockResolvedValue([
      approvedComp(),
      {
        productLinkId: 'bl1',
        internalProductId: 99,
        quantity: 1,
        sortOrder: 1,
        // Plenty of stock, but unvetted → must be treated like an orphan.
        internalProduct: {
          id: 99,
          name: 'Provisional component',
          deletedAt: null,
          approvalStatus: 'PENDING_REVIEW',
          product_locations: [{ locationId: 1, quantity: 50 }],
        },
      },
    ] as any);

    const result = await computeBundleStockStatus('bl1', 1);

    expect(result.status).toBe('outofstock');
    expect(result.warning).toEqual({
      kind: 'orphan-component',
      internalProductId: 99,
    });
  });

  it('returns instock when every component is APPROVED and sufficiently stocked', async () => {
    getMockPrisma().bundleComponent.findMany.mockResolvedValue([
      approvedComp(),
    ] as any);

    const result = await computeBundleStockStatus('bl1', 1);

    expect(result).toEqual({ status: 'instock' });
  });
});

// ===========================================================================
// SHOW site — provisional products MUST stay visible: the main inventory list
// query's `where` must NOT contain approvalStatus.
// ===========================================================================

describe('SHOW: getProductsWithQuantities (lib/products.ts) does not filter provisional', () => {
  it('omits approvalStatus from both the count and the findMany where clause', async () => {
    getMockPrisma().product.count.mockResolvedValue(0 as any);
    getMockPrisma().product.findMany.mockResolvedValue([] as any);
    getMockPrisma().product_locations.findMany.mockResolvedValue([] as any);

    await getProductsWithQuantities({});

    const countArg = getMockPrisma().product.count.mock.calls[0][0] as any;
    const findArg = getMockPrisma().product.findMany.mock.calls[0][0] as any;

    expect(countArg.where).not.toHaveProperty('approvalStatus');
    expect(findArg.where).not.toHaveProperty('approvalStatus');
    // Still scoped to non-deleted rows — only the provisional filter is absent.
    expect(findArg.where).toMatchObject({ deletedAt: null });
  });
});
