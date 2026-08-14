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
      findMany: jest.fn(),
    },
    inventory_logs: { create: jest.fn() },
    $executeRaw: jest.fn(),
    $executeRawUnsafe: jest.fn(),
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
  // SAVEPOINT / ROLLBACK / RELEASE — Prisma returns 0 for DDL, harmless for tests
  tx.$executeRawUnsafe.mockResolvedValue(0);
  tx.externalOrderItem.update.mockResolvedValue({});
  tx.externalOrderItem.findMany.mockResolvedValue([
    { quantity: orderQty, fulfilledQty: orderQty },
  ]);
  tx.externalOrder.update.mockResolvedValue({});
  // Pre-flight stock check: return ample stock for every component by default
  tx.product_locations.findUnique.mockResolvedValue({ quantity: 9999 });
  // FIX D: batched pre-flight uses findMany — default to "no row" (treated as 0)
  // and tests can override per case. For default "ample" mock, return a very-high
  // quantity by intercepting the where.productId.in list.
  tx.product_locations.findMany.mockImplementation((args: any) => {
    const ids: number[] = args?.where?.productId?.in ?? [];
    return Promise.resolve(ids.map((id) => ({ productId: id, quantity: 9999 })));
  });
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

    const result = await fulfillExternalOrder('ord1', 1, [{ itemId: 'oi1', quantity: 1 }], 42);

    // 3 components, each gets a $executeRaw deduction + legacy mirror at locationId=1
    // 3 product_locations + 3 products.quantity mirror = 6 total
    expect(tx.$executeRaw).toHaveBeenCalledTimes(6);
    // createInventoryLog called once per component
    expect(createInventoryLog).toHaveBeenCalledTimes(3);

    // Bundle result has affectedComponentIds populated with all 3 deducted products
    expect(result.affectedComponentIds).toEqual(expect.arrayContaining([1, 2, 3]));
    // No negative IDs leak into affectedComponentIds
    expect(result.affectedComponentIds!.every((id) => id > 0)).toBe(true);

    // Fix C: fulfilled entry carries per-item componentIds for clean route response
    expect(result.fulfilled).toHaveLength(1);
    expect(result.fulfilled[0].isBundle).toBe(true);
    expect(result.fulfilled[0].componentIds).toEqual([1, 2, 3]);
  });

  // FIX C (P0 #6): empty-components bundle should land in failed, not skipped.
  it('puts empty-components bundle in result.failed (not skipped)', async () => {
    const tx = getTx();
    // snapshot=null AND liveComponents=[] → no components at all
    const order = buildBundleOrder({
      snapshot: null,
      liveComponents: [],
      itemQuantity: 1,
    });
    tx.externalOrder.findUnique.mockResolvedValue(order);
    setupSuccessfulMocks(1);

    const result = await fulfillExternalOrder('ord1', 1, [{ itemId: 'oi1', quantity: 1 }], 42);

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].itemId).toBe('oi1');
    expect(result.failed[0].error).toMatch(/no components/i);
    expect(result.skipped).toHaveLength(0);
    expect(result.fulfilled).toHaveLength(0);
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

  it('skips bundle items with malformed snapshot instead of deducting NaN (P1)', async () => {
    // Snapshot is present but has bogus shape — Zod should reject it.
    // Expect: result.skipped contains the item, zero $executeRaw deduction calls.
    const tx = getTx();
    const order = buildBundleOrder({
      snapshot: [{ bogus: 'data' }] as any,
      itemQuantity: 1,
    });
    tx.externalOrder.findUnique.mockResolvedValue(order);

    tx.$executeRaw.mockResolvedValue(1);
    tx.$executeRawUnsafe.mockResolvedValue(0);
    tx.externalOrderItem.update.mockResolvedValue({});
    tx.externalOrderItem.findMany.mockResolvedValue([{ quantity: 1, fulfilledQty: 0 }]);
    tx.externalOrder.update.mockResolvedValue({});
    tx.product_locations.findUnique.mockResolvedValue({ quantity: 9999 });
    tx.product_locations.findMany.mockResolvedValue([]);

    const result = await fulfillExternalOrder('ord1', 1, [{ itemId: 'oi1', quantity: 1 }], 42);

    // Must be in skipped, not fulfilled
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].itemId).toBe('oi1');
    expect(result.skipped[0].details).toMatch(/malformed/i);
    expect(result.fulfilled).toHaveLength(0);

    // No deduction SQL must have been executed
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    // No SAVEPOINT was needed (we never entered the deduction block)
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    // No inventory logs must have been created
    expect(createInventoryLog).not.toHaveBeenCalled();
  });

  it('rolls back partial deductions when a later component is short (P0)', async () => {
    // 3-component bundle. Components 1 and 2 have ample stock; component 3 has 0.
    // The pre-flight check must catch this and skip the item BEFORE making any
    // deduction — so $executeRaw (deduct) and createInventoryLog are never called,
    // and the result reflects the failure.
    const tx = getTx();
    const order = buildBundleOrder({
      snapshot: [
        { internalProductId: 10, internalProductName: 'Alpha', quantity: 1, sortOrder: 0 },
        { internalProductId: 11, internalProductName: 'Beta',  quantity: 1, sortOrder: 1 },
        { internalProductId: 12, internalProductName: 'Gamma', quantity: 1, sortOrder: 2 },
      ],
      itemQuantity: 1,
    });
    tx.externalOrder.findUnique.mockResolvedValue(order);

    // Base fulfillment mocks (status update at end)
    tx.$executeRaw.mockResolvedValue(1);
    tx.$executeRawUnsafe.mockResolvedValue(0);
    tx.externalOrderItem.update.mockResolvedValue({});
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 1, fulfilledQty: 0 },
    ]);
    tx.externalOrder.update.mockResolvedValue({});

    // FIX D: batched findMany returns one row per component — last one is SHORT
    tx.product_locations.findMany.mockResolvedValue([
      { productId: 10, quantity: 10 },
      { productId: 11, quantity: 10 },
      { productId: 12, quantity: 0 },
    ]);

    const result = await fulfillExternalOrder('ord1', 1, [{ itemId: 'oi1', quantity: 1 }], 42);

    // Item must appear in skipped (insufficient_stock) and NOT in fulfilled
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].itemId).toBe('oi1');
    expect(result.skipped[0].reason).toBe('insufficient_stock');
    expect(result.fulfilled).toHaveLength(0);

    // No deduction SQL must have been executed (pre-flight aborted before any UPDATE)
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    // No SAVEPOINT was needed (pre-flight short-circuits before the savepoint block)
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();

    // No inventory logs must have been created
    expect(createInventoryLog).not.toHaveBeenCalled();

    // fulfilledQty must NOT have been incremented on the order item
    expect(tx.externalOrderItem.update).not.toHaveBeenCalled();
  });

  // FIX A (P0): concurrent-deduct race detection via savepoint
  it('treats $executeRaw=0 mid-bundle as concurrent_modification and rolls back the item', async () => {
    // 3-component bundle. Pre-flight passes (ample stock for all 3).
    // First two component deductions succeed ($executeRaw returns 1 each).
    // Third deduction returns 0 — simulating a concurrent fulfill that beat us
    // to the atomic UPDATE between pre-flight and our own UPDATE.
    // Expect: SAVEPOINT was opened, then ROLLBACK TO SAVEPOINT was issued,
    // item is in skipped with reason='concurrent_modification',
    // and fulfilledQty was NOT incremented.
    const tx = getTx();
    const order = buildBundleOrder({
      snapshot: [
        { internalProductId: 10, internalProductName: 'Alpha', quantity: 1, sortOrder: 0 },
        { internalProductId: 11, internalProductName: 'Beta',  quantity: 1, sortOrder: 1 },
        { internalProductId: 12, internalProductName: 'Gamma', quantity: 1, sortOrder: 2 },
      ],
      itemQuantity: 1,
    });
    tx.externalOrder.findUnique.mockResolvedValue(order);

    // FIX D: pre-flight passes for all 3 via batched findMany
    tx.product_locations.findMany.mockResolvedValue([
      { productId: 10, quantity: 9999 },
      { productId: 11, quantity: 9999 },
      { productId: 12, quantity: 9999 },
    ]);

    // Deduction sequence: 1, 1, 0  (third one — concurrent race lost)
    // Note: when locationId === 1 the loop also does a products.quantity mirror
    // UPDATE per component, so the actual $executeRaw call interleaving for
    // 3 components is: [deduct1, mirror1, deduct2, mirror2, deduct3] — break
    // happens before mirror3 fires.
    tx.$executeRaw
      .mockResolvedValueOnce(1)  // component 10 deduct — success
      .mockResolvedValueOnce(1)  // component 10 legacy mirror — success
      .mockResolvedValueOnce(1)  // component 11 deduct — success
      .mockResolvedValueOnce(1)  // component 11 legacy mirror — success
      .mockResolvedValueOnce(0); // component 12 deduct — RACE LOST

    tx.$executeRawUnsafe.mockResolvedValue(0);
    tx.externalOrderItem.update.mockResolvedValue({});
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 1, fulfilledQty: 0 },
    ]);
    tx.externalOrder.update.mockResolvedValue({});

    const result = await fulfillExternalOrder('ord1', 1, [{ itemId: 'oi1', quantity: 1 }], 42);

    // Item is in skipped with the right reason
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].itemId).toBe('oi1');
    expect(result.skipped[0].reason).toBe('concurrent_modification');
    expect(result.skipped[0].details).toMatch(/concurrent/i);
    expect(result.fulfilled).toHaveLength(0);

    // The BUNDLE savepoint was opened AND rolled back (RELEASE never fires on
    // the loser path). W2S-1 added an ITEM savepoint around the whole item; on
    // this SKIP path it releases normally — the bundle rollback has already
    // undone the components, and a skipped item is not a failed one — so the
    // assertions name the savepoint they are about.
    const unsafeCalls = (tx.$executeRawUnsafe as jest.Mock).mock.calls.map(
      (c: any[]) => c[0] as string
    );
    expect(unsafeCalls.some((s) => /^SAVEPOINT bundle_/.test(s))).toBe(true);
    expect(unsafeCalls.some((s) => /^ROLLBACK TO SAVEPOINT bundle_/.test(s))).toBe(true);
    expect(unsafeCalls.some((s) => /^RELEASE SAVEPOINT bundle_/.test(s))).toBe(false);
    expect(unsafeCalls.some((s) => /^RELEASE SAVEPOINT item_/.test(s))).toBe(true);
    expect(unsafeCalls.some((s) => /^ROLLBACK TO SAVEPOINT item_/.test(s))).toBe(false);

    // fulfilledQty must NOT have been incremented
    expect(tx.externalOrderItem.update).not.toHaveBeenCalled();

    // affectedComponentIds must NOT contain the bundle's components
    expect(result.affectedComponentIds ?? []).toEqual([]);
  });

  it('releases the savepoint on the happy path (no rollback)', async () => {
    const tx = getTx();
    const order = buildBundleOrder({
      snapshot: [
        { internalProductId: 1, internalProductName: 'A', quantity: 1, sortOrder: 0 },
        { internalProductId: 2, internalProductName: 'B', quantity: 1, sortOrder: 1 },
      ],
      itemQuantity: 1,
    });
    tx.externalOrder.findUnique.mockResolvedValue(order);
    setupSuccessfulMocks(1);

    await fulfillExternalOrder('ord1', 1, [{ itemId: 'oi1', quantity: 1 }], 42);

    const unsafeCalls = (tx.$executeRawUnsafe as jest.Mock).mock.calls.map(
      (c: any[]) => c[0] as string
    );
    expect(unsafeCalls.some((s) => /^SAVEPOINT /.test(s))).toBe(true);
    expect(unsafeCalls.some((s) => /^RELEASE SAVEPOINT /.test(s))).toBe(true);
    expect(unsafeCalls.some((s) => /^ROLLBACK TO SAVEPOINT /.test(s))).toBe(false);
  });

  // FIX B (P0): snapshot frozen at first-fulfill for legacy items
  it('freezes snapshot at fulfill for legacy items (snapshot=null + live fallback)', async () => {
    const tx = getTx();
    const order = buildBundleOrder({
      snapshot: null,
      liveComponents: [
        { internalProductId: 7, quantity: 2, sortOrder: 0 },
        { internalProductId: 8, quantity: 1, sortOrder: 1 },
      ],
      itemQuantity: 1,
    });
    tx.externalOrder.findUnique.mockResolvedValue(order);
    setupSuccessfulMocks(1);

    await fulfillExternalOrder('ord1', 1, [{ itemId: 'oi1', quantity: 1 }], 42);

    // tx.externalOrderItem.update must have been called TWICE:
    //   1. bundleComponentSnapshot write (the Fix B freeze)
    //   2. fulfilledQty increment (the normal end-of-bundle update)
    const updateCalls = (tx.externalOrderItem.update as jest.Mock).mock.calls;
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);

    // First call writes the snapshot derived from live components.
    const snapshotCall = updateCalls.find(
      (c: any[]) => c[0]?.data?.bundleComponentSnapshot !== undefined
    );
    expect(snapshotCall).toBeDefined();
    const writtenSnapshot = snapshotCall[0].data.bundleComponentSnapshot;
    expect(Array.isArray(writtenSnapshot)).toBe(true);
    expect(writtenSnapshot).toEqual([
      expect.objectContaining({ internalProductId: 7, quantity: 2 }),
      expect.objectContaining({ internalProductId: 8, quantity: 1 }),
    ]);
  });

  // Phase C (P-C2): bundle-component deductions are SALEs; the route's event
  // batchId is threaded through fulfillExternalOrder onto every ledger row so it
  // joins the fulfillment audit event.
  it('deducts each bundle component as SALE stamped with the threaded batchId', async () => {
    const tx = getTx();
    const order = buildBundleOrder({
      snapshot: [
        { internalProductId: 1, internalProductName: 'A', quantity: 1, sortOrder: 0 },
        { internalProductId: 2, internalProductName: 'B', quantity: 2, sortOrder: 1 },
      ],
      itemQuantity: 1,
    });
    tx.externalOrder.findUnique.mockResolvedValue(order);
    setupSuccessfulMocks(1);

    // signature: (orderId, locationId, items, userId, _notes?, record?, batchId?)
    await fulfillExternalOrder(
      'ord1',
      1,
      [{ itemId: 'oi1', quantity: 1 }],
      42,
      undefined,
      undefined,
      'batch-c-bundle'
    );

    const calls = (createInventoryLog as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [data] of calls) {
      expect(data.logType).toBe('SALE');
      expect(data.batchId).toBe('batch-c-bundle');
    }
  });

  it('does NOT re-write the snapshot when one already exists (idempotency)', async () => {
    const tx = getTx();
    const order = buildBundleOrder({
      snapshot: [
        { internalProductId: 1, internalProductName: 'A', quantity: 1, sortOrder: 0 },
      ],
      itemQuantity: 1,
    });
    tx.externalOrder.findUnique.mockResolvedValue(order);
    setupSuccessfulMocks(1);

    await fulfillExternalOrder('ord1', 1, [{ itemId: 'oi1', quantity: 1 }], 42);

    // tx.externalOrderItem.update should NOT have been called with a snapshot write
    const snapshotWriteCalls = (tx.externalOrderItem.update as jest.Mock).mock.calls.filter(
      (c: any[]) => c[0]?.data?.bundleComponentSnapshot !== undefined
    );
    expect(snapshotWriteCalls).toHaveLength(0);
  });
});
