/**
 * @jest-environment node
 */

/**
 * Tests for the stock sync engine (lib/external-orders/stock-sync.ts).
 *
 * Mocks Prisma + adapter to verify:
 *   - happy path, disabled integration, partial failure
 *   - empty ProductLinks, variant grouping
 *   - credential decryption failure
 *   - syncLocationId filtering
 *   - stock_status derivation (Amendment 11)
 *   - lastStockSyncError cleared on full success
 */

import type { PlatformAdapter, BatchStockUpdateResult } from '@/lib/platforms/core/types';

// ---------------------------------------------------------------------------
// Mocks — jest.mock factories run before module-level `let` bindings,
// so we use require() inside the factory and then re-import afterwards.
// ---------------------------------------------------------------------------

jest.mock('@/lib/prisma', () => {
  const { mockDeep } = require('jest-mock-extended');
  return { __esModule: true, default: mockDeep() };
});

const mockGetIntegrationClient = jest.fn();
jest.mock('@/lib/external-orders/shared', () => {
  const actual = jest.requireActual('@/lib/external-orders/shared');
  return {
    ...actual,
    getIntegrationClient: (...args: unknown[]) => mockGetIntegrationClient(...args),
  };
});

const mockComputeBundleStockStatus = jest.fn();
jest.mock('@/lib/stock-sync/compute-bundle-status', () => ({
  computeBundleStockStatus: (...args: unknown[]) =>
    mockComputeBundleStockStatus(...args),
}));

// Now import the module under test + the prisma mock
import { syncStockToExternal } from '@/lib/external-orders/stock-sync';
import mockPrismaDefault from '@/lib/prisma';
import { mockReset } from 'jest-mock-extended';

// Cast to get full mock typing
const mockPrisma = mockPrismaDefault as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockReset(mockPrisma);
  mockGetIntegrationClient.mockReset();
  mockComputeBundleStockStatus.mockReset();
});

/** Build a mock integration record */
function makeIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-1',
    platform: 'WOOCOMMERCE',
    storeUrl: 'https://store.test',
    isActive: true,
    stockSyncEnabled: true,
    fulfillmentPushEnabled: false,
    lastStockSyncAt: null,
    lastStockSyncError: null,
    syncLocationId: null,
    encryptedApiKey: 'ck_test',
    encryptedApiSecret: 'cs_test',
    ...overrides,
  };
}

/** Build a mock ProductLink with internalProduct + product_locations */
function makeProductLink(opts: {
  externalProductId: string;
  externalVariantId?: string | null;
  locations: Array<{ locationId: number; quantity: number }>;
}) {
  return {
    externalProductId: opts.externalProductId,
    externalVariantId: opts.externalVariantId ?? null,
    internalProduct: {
      product_locations: opts.locations.map((loc) => ({
        locationId: loc.locationId,
        quantity: loc.quantity,
      })),
    },
  };
}

/** Create a mock adapter with batchUpdateProductStock */
function makeAdapter(
  batchResult: BatchStockUpdateResult = { succeeded: 0, failed: [] }
): PlatformAdapter & { batchUpdateProductStock: jest.Mock } {
  return {
    platform: 'WOOCOMMERCE',
    extractWebhookHeaders: jest.fn(),
    verifyWebhook: jest.fn(),
    parseOrderWebhook: jest.fn(),
    batchUpdateProductStock: jest.fn().mockResolvedValue(batchResult),
  } as unknown as PlatformAdapter & { batchUpdateProductStock: jest.Mock };
}

/** Wire up getIntegrationClient to return given adapter + integration */
function setupClient(
  adapter: PlatformAdapter,
  integrationOverrides: Record<string, unknown> = {}
) {
  const integration = makeIntegration(integrationOverrides);
  mockGetIntegrationClient.mockResolvedValue({
    adapter,
    storeUrl: integration.storeUrl,
    credentials: { key: 'ck_test', secret: 'cs_test' },
    integration,
  });
}

// ===========================================================================
// Tests
// ===========================================================================

describe('syncStockToExternal', () => {
  // 1. Happy path: all products synced, lastStockSyncAt updated
  it('syncs all products and clears lastStockSyncError on success', async () => {
    const adapter = makeAdapter({ succeeded: 2, failed: [] });
    setupClient(adapter);

    // First call: single-product links (isBundle:false). Second call: bundle links (isBundle:true).
    mockPrisma.productLink.findMany
      .mockResolvedValueOnce([
        makeProductLink({ externalProductId: '10', locations: [{ locationId: 1, quantity: 5 }] }),
        makeProductLink({ externalProductId: '20', locations: [{ locationId: 1, quantity: 0 }] }),
      ] as any)
      .mockResolvedValueOnce([] as any);
    mockPrisma.integration.update.mockResolvedValue({} as any);

    const result = await syncStockToExternal('int-1');

    expect(result.synced).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify adapter was called
    expect(adapter.batchUpdateProductStock).toHaveBeenCalledTimes(1);

    // Verify integration was updated with cleared error
    expect(mockPrisma.integration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastStockSyncError: null,
        }),
      })
    );
  });

  // 2. Integration disabled: returns early, no API calls
  it('returns early when stockSyncEnabled is false', async () => {
    const adapter = makeAdapter();
    setupClient(adapter, { stockSyncEnabled: false });

    const result = await syncStockToExternal('int-1');

    expect(result.synced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain('disabled');
    expect(adapter.batchUpdateProductStock).not.toHaveBeenCalled();
    expect(mockPrisma.productLink.findMany).not.toHaveBeenCalled();
  });

  // 3. Partial failure: some products fail, others succeed, lastStockSyncError set
  it('records partial failure with lastStockSyncError set', async () => {
    const adapter = makeAdapter({
      succeeded: 1,
      failed: [{ productId: '20', error: 'Product not found' }],
    });
    setupClient(adapter);

    mockPrisma.productLink.findMany
      .mockResolvedValueOnce([
        makeProductLink({ externalProductId: '10', locations: [{ locationId: 1, quantity: 5 }] }),
        makeProductLink({ externalProductId: '20', locations: [{ locationId: 1, quantity: 3 }] }),
      ] as any)
      .mockResolvedValueOnce([] as any);
    mockPrisma.integration.update.mockResolvedValue({} as any);

    const result = await syncStockToExternal('int-1');

    expect(result.synced).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0].productId).toBe('20');

    // Verify lastStockSyncError was set (not null)
    expect(mockPrisma.integration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastStockSyncError: expect.any(String),
        }),
      })
    );
  });

  // 4. No ProductLinks: empty result, no API calls
  it('handles zero ProductLinks gracefully', async () => {
    const adapter = makeAdapter();
    setupClient(adapter);

    // Both single and bundle queries return empty
    mockPrisma.productLink.findMany
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([] as any);
    mockPrisma.integration.update.mockResolvedValue({} as any);

    const result = await syncStockToExternal('int-1');

    expect(result.synced).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(adapter.batchUpdateProductStock).not.toHaveBeenCalled();

    // Should still update lastStockSyncAt
    expect(mockPrisma.integration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastStockSyncAt: expect.any(Date),
          lastStockSyncError: null,
        }),
      })
    );
  });

  // 5. Variant products: grouped by parent, uses variation endpoint
  it('passes variant updates with variantId to adapter', async () => {
    const adapter = makeAdapter({ succeeded: 3, failed: [] });
    setupClient(adapter);

    mockPrisma.productLink.findMany
      .mockResolvedValueOnce([
        makeProductLink({ externalProductId: '10', locations: [{ locationId: 1, quantity: 5 }] }),
        makeProductLink({
          externalProductId: '50',
          externalVariantId: '101',
          locations: [{ locationId: 1, quantity: 3 }],
        }),
        makeProductLink({
          externalProductId: '50',
          externalVariantId: '102',
          locations: [{ locationId: 1, quantity: 0 }],
        }),
      ] as any)
      .mockResolvedValueOnce([] as any);
    mockPrisma.integration.update.mockResolvedValue({} as any);

    const result = await syncStockToExternal('int-1');

    expect(result.synced).toBe(3);

    // Check adapter was called with correct updates including variantId
    const updates = adapter.batchUpdateProductStock.mock.calls[0][2];
    expect(updates).toHaveLength(3);

    const variantUpdates = updates.filter((u: any) => u.variantId);
    expect(variantUpdates).toHaveLength(2);
    expect(variantUpdates[0].variantId).toBe('101');
    expect(variantUpdates[1].variantId).toBe('102');
  });

  // 6. Credential decryption failure: throws, no API calls
  it('throws when credentials cannot be decrypted', async () => {
    mockGetIntegrationClient.mockRejectedValue(
      new Error('Failed to decrypt integration credentials')
    );

    // getIntegrationClient is called before the try/catch, so the error propagates
    await expect(syncStockToExternal('int-1')).rejects.toThrow(
      'Failed to decrypt integration credentials'
    );
  });

  // 7. syncLocationId set: only counts stock from that location
  it('filters stock by syncLocationId when set', async () => {
    const adapter = makeAdapter({ succeeded: 1, failed: [] });
    setupClient(adapter, { syncLocationId: 2 });

    mockPrisma.productLink.findMany
      .mockResolvedValueOnce([
        makeProductLink({
          externalProductId: '10',
          locations: [
            { locationId: 1, quantity: 100 },
            { locationId: 2, quantity: 5 },
            { locationId: 3, quantity: 50 },
          ],
        }),
      ] as any)
      .mockResolvedValueOnce([] as any);
    mockPrisma.integration.update.mockResolvedValue({} as any);

    await syncStockToExternal('int-1');

    // Should only count stock from location 2 (quantity=5, which is > 0 -> instock)
    const updates = adapter.batchUpdateProductStock.mock.calls[0][2];
    expect(updates).toHaveLength(1);
    expect(updates[0].stockStatus).toBe('instock');
  });

  // 7b. syncLocationId with zero stock at target (P1 coverage gap)
  // This is the operationally dangerous case: other locations have stock but
  // the sync location has zero, so we must push outofstock. If this test were
  // missing, a regression that fell back to summing all locations would ship.
  it('pushes outofstock when syncLocationId target has zero stock (other locations positive)', async () => {
    const adapter = makeAdapter({ succeeded: 1, failed: [] });
    setupClient(adapter, { syncLocationId: 2 });

    mockPrisma.productLink.findMany
      .mockResolvedValueOnce([
        makeProductLink({
          externalProductId: '10',
          locations: [
            { locationId: 1, quantity: 100 }, // big stock elsewhere
            { locationId: 2, quantity: 0 },   // zero at the sync location
            { locationId: 3, quantity: 50 },
          ],
        }),
      ] as any)
      .mockResolvedValueOnce([] as any);
    mockPrisma.integration.update.mockResolvedValue({} as any);

    await syncStockToExternal('int-1');

    const updates = adapter.batchUpdateProductStock.mock.calls[0][2];
    expect(updates).toHaveLength(1);
    expect(updates[0].stockStatus).toBe('outofstock');
  });

  // 7c. syncLocationId points to a location that has no row at all
  it('pushes outofstock when syncLocationId target has no product_locations row', async () => {
    const adapter = makeAdapter({ succeeded: 1, failed: [] });
    setupClient(adapter, { syncLocationId: 99 }); // non-existent location

    mockPrisma.productLink.findMany
      .mockResolvedValueOnce([
        makeProductLink({
          externalProductId: '10',
          locations: [
            { locationId: 1, quantity: 100 },
            { locationId: 2, quantity: 50 },
          ],
        }),
      ] as any)
      .mockResolvedValueOnce([] as any);
    mockPrisma.integration.update.mockResolvedValue({} as any);

    await syncStockToExternal('int-1');

    const updates = adapter.batchUpdateProductStock.mock.calls[0][2];
    expect(updates).toHaveLength(1);
    expect(updates[0].stockStatus).toBe('outofstock');
  });

  // 8. syncLocationId null: sums all locations
  it('sums all location quantities when syncLocationId is null', async () => {
    const adapter = makeAdapter({ succeeded: 1, failed: [] });
    setupClient(adapter, { syncLocationId: null });

    mockPrisma.productLink.findMany
      .mockResolvedValueOnce([
        makeProductLink({
          externalProductId: '10',
          locations: [
            { locationId: 1, quantity: 10 },
            { locationId: 2, quantity: 20 },
            { locationId: 3, quantity: 30 },
          ],
        }),
      ] as any)
      .mockResolvedValueOnce([] as any);
    mockPrisma.integration.update.mockResolvedValue({} as any);

    await syncStockToExternal('int-1');

    // Should sum all: 10 + 20 + 30 = 60, which is > 0 -> instock
    const updates = adapter.batchUpdateProductStock.mock.calls[0][2];
    expect(updates).toHaveLength(1);
    expect(updates[0].stockStatus).toBe('instock');
  });

  // 9. Stock > 0 -> instock, stock = 0 -> outofstock (Amendment 11)
  // The stock-sync engine now derives stockStatus directly from total quantity.
  it('maps stock > 0 to instock and stock = 0 to outofstock', async () => {
    const adapter = makeAdapter({ succeeded: 2, failed: [] });
    setupClient(adapter);

    mockPrisma.productLink.findMany
      .mockResolvedValueOnce([
        makeProductLink({ externalProductId: '10', locations: [{ locationId: 1, quantity: 290 }] }),
        makeProductLink({ externalProductId: '20', locations: [{ locationId: 1, quantity: 0 }] }),
      ] as any)
      .mockResolvedValueOnce([] as any);
    mockPrisma.integration.update.mockResolvedValue({} as any);

    await syncStockToExternal('int-1');

    const updates = adapter.batchUpdateProductStock.mock.calls[0][2];
    // Product with stock 290 -> "instock"
    expect(updates.find((u: any) => u.productId === '10').stockStatus).toBe('instock');
    // Product with stock 0 -> "outofstock"
    expect(updates.find((u: any) => u.productId === '20').stockStatus).toBe('outofstock');
  });

  // 10. Adapter throws an Error: catch block stores error on integration
  it('handles adapter.batchUpdateProductStock throwing an Error', async () => {
    const adapter = makeAdapter();
    // Make the adapter throw instead of returning gracefully
    adapter.batchUpdateProductStock.mockRejectedValue(
      new Error('Connection refused')
    );
    setupClient(adapter);

    mockPrisma.productLink.findMany
      .mockResolvedValueOnce([
        makeProductLink({ externalProductId: '10', locations: [{ locationId: 1, quantity: 5 }] }),
        makeProductLink({ externalProductId: '20', locations: [{ locationId: 1, quantity: 3 }] }),
      ] as any)
      .mockResolvedValueOnce([] as any);
    mockPrisma.integration.update.mockResolvedValue({} as any);

    const result = await syncStockToExternal('int-1');

    // Should return synced: 0, failed: N, errors with the message
    expect(result.synced).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain('Connection refused');

    // Verify lastStockSyncError is set on the integration
    expect(mockPrisma.integration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastStockSyncError: expect.stringContaining('Connection refused'),
        }),
      })
    );

    // Verify lastStockSyncAt is also set (per QA fix)
    const updateCall = mockPrisma.integration.update.mock.calls[0][0];
    expect(updateCall.data).toHaveProperty('lastStockSyncAt');
    expect(updateCall.data.lastStockSyncAt).toBeInstanceOf(Date);
  });

  // 11. Updates lastStockSyncError to null on full success
  it('clears lastStockSyncError when all products succeed', async () => {
    const adapter = makeAdapter({ succeeded: 1, failed: [] });
    setupClient(adapter, { lastStockSyncError: 'previous error' });

    mockPrisma.productLink.findMany
      .mockResolvedValueOnce([
        makeProductLink({ externalProductId: '10', locations: [{ locationId: 1, quantity: 5 }] }),
      ] as any)
      .mockResolvedValueOnce([] as any);
    mockPrisma.integration.update.mockResolvedValue({} as any);

    const result = await syncStockToExternal('int-1');

    expect(result.synced).toBe(1);
    expect(result.failed).toBe(0);

    // lastStockSyncError should be cleared
    const updateCall = mockPrisma.integration.update.mock.calls[0][0];
    expect(updateCall.data).toHaveProperty('lastStockSyncError', null);
    expect(updateCall.data).toHaveProperty('lastStockSyncAt');
  });

  // 12. Bundle statuses are included in the push updates alongside single-product links
  it('includes bundle statuses in the push updates', async () => {
    const adapter = makeAdapter({ succeeded: 2, failed: [] });
    setupClient(adapter);

    // Single-product link
    mockPrisma.productLink.findMany
      .mockResolvedValueOnce([
        makeProductLink({ externalProductId: '10', locations: [{ locationId: 1, quantity: 5 }] }),
      ] as any)
      // Bundle link
      .mockResolvedValueOnce([
        { id: 'bl-1', externalProductId: '99', externalVariantId: null, isBundle: true },
      ] as any);

    mockComputeBundleStockStatus.mockResolvedValue({ status: 'outofstock' });
    mockPrisma.integration.update.mockResolvedValue({} as any);

    const result = await syncStockToExternal('int-1');

    expect(result.synced).toBe(2);

    // Adapter should receive both the single-product update AND the bundle update
    const updates = adapter.batchUpdateProductStock.mock.calls[0][2];
    expect(updates).toHaveLength(2);

    const singleUpdate = updates.find((u: any) => u.productId === '10');
    expect(singleUpdate?.stockStatus).toBe('instock');

    const bundleUpdate = updates.find((u: any) => u.productId === '99');
    expect(bundleUpdate?.stockStatus).toBe('outofstock');

    // computeBundleStockStatus was called with the correct productLinkId and syncLocationId
    expect(mockComputeBundleStockStatus).toHaveBeenCalledWith('bl-1', null);
  });

  // 13. Bundle orphan warnings are logged but do not block the push
  it('logs orphan warnings for bundles with deleted components but still pushes', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = makeAdapter({ succeeded: 1, failed: [] });
    setupClient(adapter);

    mockPrisma.productLink.findMany
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([
        { id: 'bl-orphan', externalProductId: '200', externalVariantId: null, isBundle: true },
      ] as any);

    mockComputeBundleStockStatus.mockResolvedValue({
      status: 'outofstock',
      warning: { kind: 'orphan-component', internalProductId: 42 },
    });
    mockPrisma.integration.update.mockResolvedValue({} as any);

    await syncStockToExternal('int-1');

    // Bundle is still pushed as outofstock
    const updates = adapter.batchUpdateProductStock.mock.calls[0][2];
    expect(updates).toHaveLength(1);
    expect(updates[0].productId).toBe('200');
    expect(updates[0].stockStatus).toBe('outofstock');

    // Orphan warning is emitted to console
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('orphan'),
      expect.any(String)
    );

    consoleSpy.mockRestore();
  });
});
