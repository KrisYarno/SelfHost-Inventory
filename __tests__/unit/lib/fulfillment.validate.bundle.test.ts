/**
 * @jest-environment node
 *
 * Tests for bundle-aware per-component shortage detection in
 * `validateOrderFulfillment` (Task 11).
 *
 * When an order item is a bundle (productLink.isBundle = true), the
 * function should iterate each component and report which ones are short
 * in the `bundleShortages` field of the item result.
 */

jest.mock('@/lib/prisma', () => {
  const mock: any = {
    externalOrder: { findUnique: jest.fn() },
    product_locations: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
  };
  (globalThis as any).__mockPrismaValidate = mock;
  return { __esModule: true, default: mock };
});

import { validateOrderFulfillment } from '@/lib/fulfillment';

function getMock(): any {
  return (globalThis as any).__mockPrismaValidate;
}

beforeEach(() => {
  jest.clearAllMocks();
});

/** Build a minimal order with one bundle item and a given snapshot. */
function buildBundleOrder(opts: {
  snapshot: unknown[] | null;
  liveComponents?: Array<{
    internalProductId: number;
    quantity: number;
    internalProduct?: { id: number; name: string };
  }>;
  itemQuantity?: number;
  fulfilledQty?: number;
}) {
  const itemQty = opts.itemQuantity ?? 2;
  const fulfilledQty = opts.fulfilledQty ?? 0;
  return {
    id: 'ord-val-1',
    items: [
      {
        id: 'oi-val-1',
        orderId: 'ord-val-1',
        name: 'Recovery Bundle',
        sku: null,
        quantity: itemQty,
        fulfilledQty,
        isMapped: true,
        productLinkId: 'pl1',
        bundleComponentSnapshot: opts.snapshot,
        productLink: {
          id: 'pl1',
          isBundle: true,
          internalProductId: null,
          internalProduct: null,
          bundleComponents: (opts.liveComponents ?? []).map((c, i) => ({
            id: `bc${i}`,
            productLinkId: 'pl1',
            internalProductId: c.internalProductId,
            quantity: c.quantity,
            sortOrder: i,
            internalProduct: c.internalProduct ?? null,
          })),
        },
      },
    ],
  };
}

describe('validateOrderFulfillment — bundle component shortages', () => {
  it('reports per-component shortages for bundle items when a location is given', async () => {
    const mock = getMock();
    // Order: bundle item qty=2, not yet fulfilled → remainingQty=2
    // Component A (id=10, qty=1 per bundle) → needs 2, has 5 → OK
    // Component B (id=20, qty=3 per bundle) → needs 6, has 4 → SHORT
    const order = buildBundleOrder({
      snapshot: [
        { internalProductId: 10, quantity: 1, internalProductName: 'BPC-157' },
        { internalProductId: 20, quantity: 3, internalProductName: 'TB-500' },
      ],
    });
    mock.externalOrder.findUnique.mockResolvedValue(order);

    // FIX D: batched findMany returns one row per component
    mock.product_locations.findMany.mockResolvedValue([
      { productId: 10, quantity: 5 },
      { productId: 20, quantity: 4 },
    ]);

    const result = await validateOrderFulfillment('ord-val-1', 1);

    expect(result.canFulfill).toBe(false);
    expect(result.requiresAttention).toBe(true);

    const item = result.items[0];
    expect(item.issues).toContain('insufficient_stock');
    expect(item.bundleShortages).toBeDefined();
    expect(item.bundleShortages).toHaveLength(1);
    expect(item.bundleShortages![0]).toEqual({
      internalProductId: 20,
      name: 'TB-500',
      required: 6,   // 3 per bundle × 2 remaining
      available: 4,
    });

    // FIX D: only ONE findMany call per item (was N findFirst calls)
    expect(mock.product_locations.findMany).toHaveBeenCalledTimes(1);
  });

  it('does NOT flag a shortage when all bundle components have sufficient stock', async () => {
    const mock = getMock();
    const order = buildBundleOrder({
      snapshot: [
        { internalProductId: 10, quantity: 1, internalProductName: 'BPC-157' },
        { internalProductId: 20, quantity: 2, internalProductName: 'TB-500' },
      ],
    });
    mock.externalOrder.findUnique.mockResolvedValue(order);

    // FIX D: batched findMany returns ample stock for both components
    mock.product_locations.findMany.mockResolvedValue([
      { productId: 10, quantity: 100 },
      { productId: 20, quantity: 100 },
    ]);

    const result = await validateOrderFulfillment('ord-val-1', 1);

    expect(result.canFulfill).toBe(true);
    const item = result.items[0];
    expect(item.issues).not.toContain('insufficient_stock');
    expect(item.bundleShortages).toBeUndefined();
  });

  it('falls back to live bundleComponents when snapshot is null', async () => {
    const mock = getMock();
    const order = buildBundleOrder({
      snapshot: null,
      liveComponents: [
        {
          internalProductId: 55,
          quantity: 2,
          internalProduct: { id: 55, name: 'Bac Water' },
        },
      ],
    });
    mock.externalOrder.findUnique.mockResolvedValue(order);

    // 55 is short: needs 4 (2 per bundle × 2 remaining), has 1
    mock.product_locations.findMany.mockResolvedValue([
      { productId: 55, quantity: 1 },
    ]);

    const result = await validateOrderFulfillment('ord-val-1', 1);

    const item = result.items[0];
    expect(item.issues).toContain('insufficient_stock');
    expect(item.bundleShortages).toHaveLength(1);
    expect(item.bundleShortages![0]).toMatchObject({
      internalProductId: 55,
      name: 'Bac Water',
      required: 4,
      available: 1,
    });
  });

  it('checks total stock across all locations when no locationId is given', async () => {
    const mock = getMock();
    const order = buildBundleOrder({
      snapshot: [
        { internalProductId: 30, quantity: 2, internalProductName: 'Peptide X' },
      ],
    });
    mock.externalOrder.findUnique.mockResolvedValue(order);

    // No locationId: uses findMany — total stock across locs = 2 (sum of two rows), needs 4
    // FIX D: batched findMany returns one row per (productId, locationId).
    mock.product_locations.findMany.mockResolvedValue([
      { productId: 30, quantity: 1 },
      { productId: 30, quantity: 1 },
    ]);

    const result = await validateOrderFulfillment('ord-val-1', undefined);

    const item = result.items[0];
    expect(item.issues).toContain('insufficient_stock');
    expect(item.bundleShortages).toHaveLength(1);
    expect(item.bundleShortages![0]).toMatchObject({
      internalProductId: 30,
      required: 4,
      available: 2,
    });
  });

  it('uses fallback name "Product <id>" when component name is missing in snapshot', async () => {
    const mock = getMock();
    const order = buildBundleOrder({
      snapshot: [
        { internalProductId: 77, quantity: 1 }, // no internalProductName
      ],
    });
    mock.externalOrder.findUnique.mockResolvedValue(order);
    // FIX D: batched findMany — empty result means stock=0 (uses ?? 0 default)
    mock.product_locations.findMany.mockResolvedValue([]);

    const result = await validateOrderFulfillment('ord-val-1', 1);
    const item = result.items[0];
    expect(item.bundleShortages![0].name).toBe('Product 77');
  });

  it('bundle with empty snapshot array reports canFulfill=false (mirrors fulfillment loop)', async () => {
    // snapshot=[] is rejected by Zod (min(1)) as malformed — treated as unfulfillable.
    // Either way (malformed or zero components), canFulfill must be false.
    const mock = getMock();
    const order = buildBundleOrder({ snapshot: [] });
    mock.externalOrder.findUnique.mockResolvedValue(order);

    const result = await validateOrderFulfillment('ord-val-1', 1);

    expect(result.canFulfill).toBe(false);
    expect(result.requiresAttention).toBe(true);
    const item = result.items[0];
    // Either malformed_snapshot or no-components issue must appear
    expect(item.issues.length).toBeGreaterThan(0);
  });

  it('bundle with null snapshot and empty live components reports canFulfill=false', async () => {
    // null snapshot → live bundleComponents fallback → empty array → zero components path
    const mock = getMock();
    const order = buildBundleOrder({ snapshot: null, liveComponents: [] });
    mock.externalOrder.findUnique.mockResolvedValue(order);

    const result = await validateOrderFulfillment('ord-val-1', 1);

    expect(result.canFulfill).toBe(false);
    const item = result.items[0];
    expect(item.issues.some((i) => /no components/i.test(i))).toBe(true);
  });
});
