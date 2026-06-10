/**
 * @jest-environment node
 *
 * Unit tests for `getCurrentInventoryLevelsFast` — the single current-stock
 * read path (Task 14 consolidated current-levels onto /api/inventory/current-fast).
 *
 * Pins two contracts:
 *  1. Soft-deleted products (deletedAt != null) are EXCLUDED from current-stock
 *     views — both the product_locations join read and the zero-fill branch.
 *  2. SHOW contract: provisional (PENDING_REVIEW) products are INCLUDED —
 *     pending stock is real stock, so there must be NO approvalStatus filter.
 *     See __tests__/integration/read-path-isolation.test.ts.
 *
 * Prisma is mocked with jest-mock-extended (no real DB), same pattern as
 * __tests__/unit/lib/inventory.applyStockDelta.test.ts.
 */

import { mockDeep } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

// Override the plain-object mock from jest.setup.js with a deep mock so every
// model method is a jest.fn() we can assert call args on.
jest.mock('@/lib/prisma', () => {
  const { mockDeep: md } = require('jest-mock-extended');
  return { __esModule: true, default: md() };
});

import prisma from '@/lib/prisma';
import { getCurrentInventoryLevelsFast } from '@/lib/inventory-fast';

const prismaMock = prisma as unknown as ReturnType<typeof mockDeep<PrismaClient>>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getCurrentInventoryLevelsFast', () => {
  it('filters soft-deleted products but NOT approvalStatus (SHOW contract), no locationId', async () => {
    prismaMock.product_locations.findMany.mockResolvedValue([] as never);

    await getCurrentInventoryLevelsFast(undefined);

    expect(prismaMock.product_locations.findMany).toHaveBeenCalledTimes(1);
    const where = prismaMock.product_locations.findMany.mock.calls[0][0]?.where ?? {};
    expect(where.products).toMatchObject({ deletedAt: null });
    // SHOW contract: provisional products stay visible in current-stock views.
    expect(JSON.stringify(where)).not.toContain('approvalStatus');
  });

  it('zero-fill branch (locationId given) also excludes soft-deleted, no approvalStatus', async () => {
    prismaMock.product_locations.findMany.mockResolvedValue([] as never);
    prismaMock.product.findMany.mockResolvedValue([] as never);
    prismaMock.location.findUnique.mockResolvedValue(null as never);

    await getCurrentInventoryLevelsFast(1);

    // Join read keeps both the locationId scope and the soft-delete filter.
    const plWhere = prismaMock.product_locations.findMany.mock.calls[0][0]?.where ?? {};
    expect(plWhere).toMatchObject({ locationId: 1 });
    expect(plWhere.products).toMatchObject({ deletedAt: null });
    expect(JSON.stringify(plWhere)).not.toContain('approvalStatus');

    // Zero-fill product read excludes soft-deleted, no approvalStatus.
    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(1);
    const productWhere = prismaMock.product.findMany.mock.calls[0]?.[0]?.where ?? {};
    expect(productWhere).toMatchObject({ deletedAt: null });
    expect(JSON.stringify(productWhere)).not.toContain('approvalStatus');
  });
});
