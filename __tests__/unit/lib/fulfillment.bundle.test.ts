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
  // THE RECORDING RAW TRIO (pack CB0.3, the per-suite paragraph). This factory
  // is hoisted above module scope, so the trio is built in here and handed out
  // on globalThis beside the tx mock. Two layers, as everywhere else in B1: the
  // OUTER fn always records and then delegates to an INNER behaviour fn, which
  // is what a test configures — so an override can never quietly switch the
  // recording off. The pre-existing $executeRaw/$executeRawUnsafe stubs are
  // WRAPPED, not replaced: their per-test behaviours move to the inner fn.
  const rawCalls: Array<{ kind: string; sql: string; at: number }> = [];
  const rawBehavior: Record<string, jest.Mock> = {};
  const rawFns: Record<string, jest.Mock> = {};
  let rawSeq = 0;
  const sqlTextOf = (arg: any): string =>
    arg && typeof arg === 'object' && typeof arg.sql === 'string' ? arg.sql : String(arg);
  const install = (target: any, kind: string, method: string, defaultValue: unknown) => {
    const behavior = jest.fn((..._args: any[]) => Promise.resolve(defaultValue));
    const recording = jest.fn((...args: any[]) => {
      rawCalls.push({ kind, sql: sqlTextOf(args[0]), at: rawSeq++ });
      return behavior(...args);
    });
    rawBehavior[method] = behavior;
    rawFns[method] = recording;
    target[method] = recording;
  };

  const txMock: any = {
    externalOrder: { findUnique: jest.fn(), update: jest.fn() },
    externalOrderItem: { update: jest.fn(), findMany: jest.fn() },
    product: { findUnique: jest.fn(), findMany: jest.fn() },
    product_locations: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    inventory_logs: { create: jest.fn() },
  };
  install(txMock, 'query', '$queryRaw', []);
  install(txMock, 'execute', '$executeRaw', 0);
  install(txMock, 'executeUnsafe', '$executeRawUnsafe', 0);

  (globalThis as any).__txMockBundle = txMock;
  (globalThis as any).__rawBundle = { rawCalls, rawBehavior, rawFns };
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
import { Prisma } from '@prisma/client';
import { fulfillExternalOrder } from '@/lib/fulfillment';
import { createInventoryLog } from '@/lib/inventory';

function getTx(): any {
  return (globalThis as any).__txMockBundle;
}

type RawCall = { kind: string; sql: string; at: number };

/** The suite-local recording trio: what ran, in order, and how to steer it. */
function getRaw(): {
  rawCalls: RawCall[];
  rawBehavior: Record<string, jest.Mock>;
  rawFns: Record<string, jest.Mock>;
} {
  return (globalThis as any).__rawBundle;
}

// --- Helpers ---

function sqlTextOf(arg: unknown): string {
  return arg && typeof arg === 'object' && typeof (arg as { sql?: unknown }).sql === 'string'
    ? (arg as { sql: string }).sql
    : String(arg);
}

/** The prelock's returning SELECT (lib/inventory/prelock.ts), by its text. */
function isPrelockSelect(sql: string): boolean {
  return sql.includes('FROM product_locations') && sql.includes('(productId, locationId) IN');
}

/**
 * What the prelock's returning SELECT hands back (pack CB1.5a-i): the rows the
 * pass-2a TALLY compares against. B1.5 puts bundle COMPONENT keys inside the
 * prelock, so the suite's `[]` default would read as never-stocked `{ 0, 0 }`
 * and refuse every bundle item. `quantities` names the short ones; everything
 * else answers ample.
 */
/**
 * The ONE `products` read B1.5 runs over every survivor id (pack CB1.5a-i.2):
 * every id this suite names is a real product, and its name comes back with it.
 */
function productsExist(): void {
  (getTx().product.findMany as jest.Mock).mockImplementation(async (args: any) =>
    ((args?.where?.id?.in ?? []) as number[]).map((id) => ({ id, name: `Product ${id}` }))
  );
}

function prelockedStock(quantities: Record<number, number> = {}, ample = 9999): void {
  getRaw().rawBehavior.$queryRaw.mockImplementation(async (...args: any[]) => {
    const sql = sqlTextOf(args[0]);
    if (!isPrelockSelect(sql)) return [];
    const values = ((args[0] as any)?.values ?? []) as number[];
    const rows: Array<{ productId: number; locationId: number; quantity: number; version: number }> = [];
    for (let i = 0; i < values.length; i += 2) {
      const productId = values[i];
      rows.push({
        productId,
        locationId: values[i + 1],
        quantity: quantities[productId] ?? ample,
        version: 1,
      });
    }
    return rows;
  });
}

/** Every `UPDATE product_locations` this test spent, in call order. */
function stockUpdates(): RawCall[] {
  return getRaw().rawCalls.filter((c) => /UPDATE product_locations/.test(c.sql));
}

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
  const { rawBehavior } = getRaw();
  // $executeRaw returns 1 (row updated) for all calls — kept verbatim, now as
  // the INNER behaviour (the outer fn is the recorder).
  rawBehavior.$executeRaw.mockResolvedValue(1);
  // B1.5: the path issues no unsafe statement at all any more; the stub stays so
  // the pins can say "never called" about something that exists.
  rawBehavior.$executeRawUnsafe.mockResolvedValue(0);
  // B1.5 (OCc-2): the ONE batched `products` read — it proves every component id
  // AND supplies the names, so it must answer { id, name }.
  productsExist();
  prelockedStock();
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
  getRaw().rawCalls.length = 0;
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
    // 3 product_locations + 3 products.quantity mirror = 6, plus the canonical
    // prelock's materialize INSERT ahead of them (B1.5: bundle component keys
    // are INSIDE the prelock now) = 7 total.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(7);
    expect(getRaw().rawCalls[0].sql).toContain('INSERT INTO product_locations');
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

    getRaw().rawBehavior.$executeRaw.mockResolvedValue(1);
    getRaw().rawBehavior.$executeRawUnsafe.mockResolvedValue(0);
    productsExist();
    prelockedStock();
    tx.externalOrderItem.update.mockResolvedValue({});
    tx.externalOrderItem.findMany.mockResolvedValue([{ quantity: 1, fulfilledQty: 0 }]);
    tx.externalOrder.update.mockResolvedValue({});

    const result = await fulfillExternalOrder('ord1', 1, [{ itemId: 'oi1', quantity: 1 }], 42);

    // Must be in skipped, not fulfilled
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].itemId).toBe('oi1');
    expect(result.skipped[0].details).toMatch(/malformed/i);
    expect(result.fulfilled).toHaveLength(0);

    // Nothing at all was spent: a pass-1 refusal contributes no survivor, so
    // there is no product read, no prelock and no deduction.
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(tx.product.findMany).not.toHaveBeenCalled();
    // No inventory logs must have been created
    expect(createInventoryLog).not.toHaveBeenCalled();
  });

  it('refuses a bundle short on its LAST component BEFORE any component write (B1.5)', async () => {
    // 3-component bundle. Components 1 and 2 have ample stock; component 3 has 0.
    // The pass-2a TALLY (seeded from the prelock's returned rows) catches it and
    // skips the item before pass 2b writes anything — so there is nothing to roll
    // back, which is what retired the savepoint this test used to be about.
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
    getRaw().rawBehavior.$executeRaw.mockResolvedValue(1);
    getRaw().rawBehavior.$executeRawUnsafe.mockResolvedValue(0);
    productsExist();
    tx.externalOrderItem.update.mockResolvedValue({});
    tx.externalOrderItem.findMany.mockResolvedValue([
      { quantity: 1, fulfilledQty: 0 },
    ]);
    tx.externalOrder.update.mockResolvedValue({});

    // The prelock returns one row per component — the LAST one is SHORT.
    prelockedStock({ 12: 0 });

    const result = await fulfillExternalOrder('ord1', 1, [{ itemId: 'oi1', quantity: 1 }], 42);

    // Item must appear in skipped (insufficient_stock) and NOT in fulfilled
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].itemId).toBe('oi1');
    expect(result.skipped[0].reason).toBe('insufficient_stock');
    // QB-9: the number is the LOCKED one, and it names the short component.
    expect(result.skipped[0].details).toBe(
      'Insufficient stock for bundle component (productId: 12). Available: 0, Requested: 1'
    );
    expect(result.fulfilled).toHaveLength(0);

    // NO deduction was executed: the only statements are the prelock's pair.
    expect(stockUpdates()).toHaveLength(0);
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();

    // No inventory logs must have been created
    expect(createInventoryLog).not.toHaveBeenCalled();

    // fulfilledQty must NOT have been incremented on the order item
    expect(tx.externalOrderItem.update).not.toHaveBeenCalled();
  });

  // B1.5 (pack CB1.5a-i): the concurrent-deduct race this block used to model is
  // GONE — every key a bundle writes is X-held from the prelock to commit, so a
  // 0-row UPDATE under a passing tally is not a race, it is an invariant
  // violation, and the honest answer is a whole-request abort.
  it('treats a 0-row UPDATE under a PASSING tally as the invariant violation it is', async () => {
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
    setupSuccessfulMocks(1);

    // The tally passes for all 3 (ample prelocked stock), but the engine reports
    // 0 rows for component 12's decrement.
    getRaw().rawBehavior.$executeRaw.mockImplementation(async (...args: any[]) => {
      const q = args[0] as any;
      const values = (q?.values ?? []) as number[];
      if (/UPDATE product_locations/.test(sqlTextOf(q)) && values[1] === 12) return 0;
      return 1;
    });

    await expect(
      fulfillExternalOrder('ord1', 1, [{ itemId: 'oi1', quantity: 1 }], 42)
    ).rejects.toThrow('fulfil invariant: locked row 12:1 moved under the tally');

    // The whole request aborts: fulfilledQty is never incremented, and no unsafe
    // statement was issued on the way (the savepoints are gone).
    expect(
      (tx.externalOrderItem.update as jest.Mock).mock.calls.filter(
        (c: any[]) => c[0]?.data?.fulfilledQty !== undefined
      )
    ).toHaveLength(0);
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('issues NO unsafe raw statement on the happy path (the savepoints retired)', async () => {
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

    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// B1.5 (pack CB1.5a-i.2) — what the BUNDLE path contributes to the prelock:
// every one of its COMPONENT keys. The order-lock hook's own pins live in
// fulfillment.two-pass.test.ts (TP-12); what stays here is the bundle-shaped
// half, which INVERTED with this wave.
// ---------------------------------------------------------------------------

describe('fulfillExternalOrder — the order lock hook (opts.lockFirst)', () => {
  /** A stand-in for `lockFirst(tx, { required: [orderId] })`: one locking read. */
  function orderLockHook() {
    return jest.fn(async (tx: any) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id, orderNumber FROM external_orders WHERE id IN (${'ord1'}) ORDER BY id FOR UPDATE`
      );
    });
  }

  it('runs the hook as the transaction FIRST act — before the order read', async () => {
    const tx = getTx();
    const order = buildBundleOrder({
      snapshot: [
        { internalProductId: 1, internalProductName: 'A', quantity: 1, sortOrder: 0 },
      ],
      itemQuantity: 1,
    });
    tx.externalOrder.findUnique.mockResolvedValue(order);
    setupSuccessfulMocks(1);

    const lockFirst = orderLockHook();
    await fulfillExternalOrder('ord1', 1, [{ itemId: 'oi1', quantity: 1 }], 42, undefined, undefined, null, {
      lockFirst,
    });

    expect(lockFirst).toHaveBeenCalledTimes(1);
    // The hook's statement is the FIRST raw statement of the transaction.
    const { rawCalls, rawFns } = getRaw();
    expect(rawCalls[0].kind).toBe('query');
    expect(rawCalls[0].sql).toContain('FROM external_orders');
    expect(rawCalls[0].sql).toContain('FOR UPDATE');
    // …and it precedes the order read, which is a delegate call.
    expect(rawFns.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.externalOrder.findUnique.mock.invocationCallOrder[0]
    );
  });

  it('WITHOUT a hook the only $queryRaw is the prelock SELECT', async () => {
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

    const queries = getRaw().rawCalls.filter((c) => c.kind === 'query');
    expect(queries).toHaveLength(1);
    expect(isPrelockSelect(queries[0].sql)).toBe(true);
  });

  it('a BUNDLE-only request PRELOCKS its component keys (the B1 residual retires)', async () => {
    const tx = getTx();
    const order = buildBundleOrder({
      snapshot: [
        { internalProductId: 1, internalProductName: 'A', quantity: 1, sortOrder: 0 },
      ],
      itemQuantity: 1,
    });
    tx.externalOrder.findUnique.mockResolvedValue(order);
    setupSuccessfulMocks(1);

    // A manual override on a bundle line does NOT make it a simple-path item:
    // the bundle branch still wins — and its COMPONENT is what gets locked.
    await fulfillExternalOrder('ord1', 1, [{ itemId: 'oi1', quantity: 1, productId: 77 }], 42);

    const { rawCalls } = getRaw();
    const insert = rawCalls.find((c) => /INSERT INTO product_locations/.test(c.sql));
    expect(insert).toBeDefined();
    const insertCall = getRaw().rawFns.$executeRaw.mock.calls.find((c: any[]) =>
      /INSERT INTO product_locations/.test(sqlTextOf(c[0]))
    );
    expect((insertCall![0] as any).values).toEqual([1, 1]);
    expect((insertCall![0] as any).values).not.toContain(77);
  });
});
