// @jest-environment node
jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    bundleComponent: { findMany: jest.fn() },
  },
}));

import { computeBundleStockStatus } from '@/lib/stock-sync/compute-bundle-status';
import prisma from '@/lib/prisma';

const findMany = prisma.bundleComponent.findMany as jest.Mock;

function comp(opts: {
  internalProductId: number;
  quantity: number;
  onHand: number;
  locationId?: number;
  deletedAt?: Date | null;
}) {
  return {
    productLinkId: 'bl1',
    internalProductId: opts.internalProductId,
    quantity: opts.quantity,
    sortOrder: 0,
    internalProduct: {
      id: opts.internalProductId,
      name: `Product ${opts.internalProductId}`,
      deletedAt: opts.deletedAt ?? null,
      product_locations: [
        { locationId: opts.locationId ?? 1, quantity: opts.onHand },
      ],
    },
  };
}

describe('computeBundleStockStatus', () => {
  beforeEach(() => jest.resetAllMocks());

  it('returns instock when all components meet their required quantity at sync location', async () => {
    findMany.mockResolvedValue([
      comp({ internalProductId: 1, quantity: 1, onHand: 5 }),
      comp({ internalProductId: 2, quantity: 2, onHand: 4 }),
    ]);
    const result = await computeBundleStockStatus('bl1', 1);
    expect(result).toEqual({ status: 'instock' });
  });

  it('returns outofstock when any component is below its required quantity', async () => {
    findMany.mockResolvedValue([
      comp({ internalProductId: 1, quantity: 1, onHand: 5 }),
      comp({ internalProductId: 2, quantity: 3, onHand: 2 }),
    ]);
    expect(await computeBundleStockStatus('bl1', 1)).toEqual({ status: 'outofstock' });
  });

  it('returns outofstock when a component product is soft-deleted (D3) and emits warning', async () => {
    findMany.mockResolvedValue([
      comp({ internalProductId: 1, quantity: 1, onHand: 5 }),
      comp({ internalProductId: 99, quantity: 1, onHand: 10, deletedAt: new Date() }),
    ]);
    const result = await computeBundleStockStatus('bl1', 1);
    expect(result.status).toBe('outofstock');
    expect(result.warning).toEqual({ kind: 'orphan-component', internalProductId: 99 });
  });

  it('sums across all locations when syncLocationId is null', async () => {
    findMany.mockResolvedValue([
      {
        ...comp({ internalProductId: 1, quantity: 5, onHand: 3, locationId: 1 }),
        internalProduct: {
          id: 1,
          name: 'P1',
          deletedAt: null,
          product_locations: [
            { locationId: 1, quantity: 3 },
            { locationId: 2, quantity: 4 },
          ],
        },
      },
    ]);
    const result = await computeBundleStockStatus('bl1', null);
    expect(result.status).toBe('instock');
  });

  it('treats empty components array as outofstock defensively', async () => {
    findMany.mockResolvedValue([]);
    expect(await computeBundleStockStatus('bl1', 1)).toEqual({ status: 'outofstock' });
  });

  it('treats missing product_locations row as zero on hand', async () => {
    findMany.mockResolvedValue([
      {
        ...comp({ internalProductId: 1, quantity: 1, onHand: 0 }),
        internalProduct: {
          id: 1,
          name: 'P1',
          deletedAt: null,
          product_locations: [],
        },
      },
    ]);
    expect(await computeBundleStockStatus('bl1', 1)).toEqual({ status: 'outofstock' });
  });
});
