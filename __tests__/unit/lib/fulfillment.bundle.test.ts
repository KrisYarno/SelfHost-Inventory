/**
 * @jest-environment node
 *
 * Tests for bundle-item expansion in `fulfillExternalOrder` (D7).
 *
 * Bundle items: isBundle=true on the productLink. Instead of a single
 * product deduction, the fulfillment path iterates over the
 * bundleComponentSnapshot (or falls back to live bundleComponents for
 * legacy rows) and deducts each component separately using raw SQL.
 */

// --- Mocks must be hoisted before imports ---
// Note: jest.mock factories are hoisted by babel-jest; variables defined
// outside the factory are NOT accessible inside. Use require() inside the
// factory and expose the mock via globalThis for access in tests.

jest.mock('@/lib/prisma', () => {
  const txMock: any = {
    externalOrder: { findUnique: jest.fn(), update: jest.fn() },
    externalOrderItem: { update: jest.fn(), findMany: jest.fn() },
    product: { findUnique: jest.fn() },
    product_locations: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    inventory_logs: { create: jest.fn() },
    $executeRaw: jest.fn(),
  };
  (globalThis as any).__txMockBundle = txMock;
  return {
    __esModule: true,
    default: {
      $transaction: jest.fn(async (fn: any) => fn(txMock)),
    },
  };
});

let _inventoryLogImpl: (...args: any[]) => Promise<any>;
jest.mock('@/lib/inventory', () => ({
  createInventoryLog: jest.fn((...args: any[]) => _inventoryLogImpl(...args)),
}));

// --- Imports after mocks ---
import { fulfillExternalOrder } from '@/lib/fulfillment';
import { createInventoryLog } from '@/lib/inventory';

function getTx(): any {
  return (globalThis as any).__txMockBundle;
}

// --- Helpers ---

function buildBundleOrder(opts: {
  snapshot: unknown[] | null;
  liveComponents?: Array<{ internalProductId: number; quantity: number; sortOrder?: number }>;
  itemQuantity: number;
}) {
  const liveComponents = opts.liveComponents ?? [];
  return {
    id: 'ord1',
    externalId: 'ext-ord1',
    integrationId: 'int1',
    companyId: 'co1',
    fulfilledAt: null,
    fulfilledBy: null,
    integration: {
      id: 'int1',
      platform: 'WOOCOMMERCE',
      fulfillmentPushEnabled: false,
    },
    items: [
      {
        id: 'oi1',
        orderId: 'ord1',
        externalProductId: '100',
        externalVariantId: null,
        name: 'Recovery Bundle',
        sku: null,
        quantity: opts.itemQuantity,
        fulfilledQty: 0,
        isMapped: true,
        productLinkId: 'bl1',
        bundleComponentSnapshot: opts.snapshot,
        productLink: {
          id: 'bl1',
          isBundle: true,
          internalProductId: null,
          internalProduct: null,
          bundleComponents: liveComponents.map((c, i) => ({
            id: `bc${i}`,
            productLinkId: 'bl1',
            internalProductId: c.internalProductId,
            quantity: c.quantity,
            sortOrder: c.sortOrder ?? i,
          })),
        },
      },
    ],
  };
}

function setupSuccessfulMocks(orderQty: number) {
  const tx = getTx();
  // $executeRaw returns 1 (row updated) for all calls
  tx.$executeRaw.mockResolvedValue(1);
  tx.externalOrderItem.update.mockResolvedValue({});
  tx.externalOrderItem.findMany.mockResolvedValue([
    { quantity: orderQty, fulfilledQty: orderQty },
  ]);
  tx.externalOrder.update.mockResolvedValue({});
}

beforeEach(() => {
  jest.clearAllMocks();
  _inventoryLogImpl = () => Promise.resolve({ id: 100 });
  // Restore update mock after clearAllMocks
  const tx = getTx();
  tx.externalOrder.update.mockResolvedValue({});
});

// --- Tests ---

describe('fulfillExternalOrder — bundle expansion', () => {
  it('expands a bundle line item into per-component deductions', async () => {
    const tx = getTx();
    const order = buildBundleOrder({
      snapshot: [
        { internalProductId: 1, internalProductName: 'BPC-157', quantity: 1, sortOrder: 0 },
        { internalProductId: 2, internalProductName: 'TB-500', quantity: 1, sortOrder: 1 },
        { internalProductId: 3, internalProductName: 'Bac Water', quantity: 2, sortOrder: 2 },
      ],
      itemQuantity: 1,
    });
    tx.externalOrder.findUnique.mockResolvedValue(order);
    setupSuccessfulMocks(1);

    await fulfillExternalOrder('ord1', 1, [{ itemId: 'oi1', quantity: 1 }], 42);

    // 3 components, each gets a $executeRaw deduction + legacy mirror at locationId=1
    // 3 product_locations + 3 products.quantity mirror = 6 total
    expect(tx.$executeRaw).toHaveBeenCalledTimes(6);
    // createInventoryLog called once per component
    expect(createInventoryLog).toHaveBeenCalledTimes(3);
  });

  it('multiplies component deductions by order item quantity', async () => {
    const tx = getTx();
    const order = buildBundleOrder({
      snapshot: [
        { internalProductId: 1, internalProductName: 'BPC-157', quantity: 1, sortOrder: 0 },
      ],
      itemQuantity: 3,
    });
    tx.externalOrder.findUnique.mockResolvedValue(order);
    setupSuccessfulMocks(3);

    await fulfillExternalOrder('ord1', 1, [{ itemId: 'oi1', quantity: 3 }], 42);

    // delta should be -(component.quantity * fulfillmentItem.quantity) = -(1 * 3) = -3
    const logCall = (createInventoryLog as jest.Mock).mock.calls[0][0];
    expect(logCall.delta).toBe(-3);
    expect(logCall.productId).toBe(1);
  });

  it('reads from bundleComponentSnapshot, not live bundleComponents (D7)', async () => {
    const tx = getTx();
    const order = buildBundleOrder({
      snapshot: [
        { internalProductId: 1, internalProductName: 'Old A', quantity: 1, sortOrder: 0 },
      ],
      liveComponents: [
        { internalProductId: 99, quantity: 5, sortOrder: 0 }, // Live state is different
      ],
      itemQuantity: 1,
    });
    tx.externalOrder.findUnique.mockResolvedValue(order);
    setupSuccessfulMocks(1);

    await fulfillExternalOrder('ord1', 1, [{ itemId: 'oi1', quantity: 1 }], 42);

    // Only 1 inventory log — for product 1 (snapshot), NOT product 99 (live)
    expect(createInventoryLog).toHaveBeenCalledTimes(1);
    const logCall = (createInventoryLog as jest.Mock).mock.calls[0][0];
    expect(logCall.productId).toBe(1);

    const allProductIds = (createInventoryLog as jest.Mock).mock.calls.map(
      (c: any[]) => c[0].productId
    );
    expect(allProductIds).not.toContain(99);
  });

  it('falls back to live components when snapshot is null (legacy rows)', async () => {
    const tx = getTx();
    const order = buildBundleOrder({
      snapshot: null,
      liveComponents: [
        { internalProductId: 7, quantity: 2, sortOrder: 0 },
      ],
      itemQuantity: 1,
    });
    tx.externalOrder.findUnique.mockResolvedValue(order);
    setupSuccessfulMocks(1);

    await fulfillExternalOrder('ord1', 1, [{ itemId: 'oi1', quantity: 1 }], 42);

    // Should have deducted from product 7 (from live components)
    expect(createInventoryLog).toHaveBeenCalledTimes(1);
    const logCall = (createInventoryLog as jest.Mock).mock.calls[0][0];
    expect(logCall.productId).toBe(7);
    // delta: -(2 component qty * 1 item qty) = -2
    expect(logCall.delta).toBe(-2);
  });
});
