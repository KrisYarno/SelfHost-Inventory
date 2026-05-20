/**
 * @jest-environment node
 *
 * Tests for pushStockForProducts bundle handling (P0-3).
 *
 * Verifies that after fulfillment/unfulfillment, bundles whose components were
 * deducted/restored get their WC stock_status pushed immediately — not just the
 * individual component links.
 */

import type { PlatformAdapter, BatchStockUpdateResult } from '@/lib/platforms/core/types';

// ---------------------------------------------------------------------------
// Mocks
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

import { pushStockForProducts } from '@/lib/external-orders/stock-sync';
import mockPrismaDefault from '@/lib/prisma';
import { mockReset } from 'jest-mock-extended';

const mockPrisma = mockPrismaDefault as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockReset(mockPrisma);
  mockGetIntegrationClient.mockReset();
  mockComputeBundleStockStatus.mockReset();
});

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

/**
 * Build a mock single-product ProductLink returned by the first findMany call
 * (isBundle: false, filtered by internalProductId IN [...]).
 */
function makeSingleLink(opts: {
  externalProductId: string;
  internalProductId: number;
  locations: Array<{ locationId: number; quantity: number }>;
}) {
  return {
    externalProductId: opts.externalProductId,
    externalVariantId: null,
    isBundle: false,
    internalProduct: {
      id: opts.internalProductId,
      product_locations: opts.locations,
    },
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('pushStockForProducts — bundles', () => {
  // 1. When a component is below its required quantity-per-bundle, the bundle
  //    should go outofstock in WC immediately.
  it('pushes outofstock to bundle when any component is below minimum', async () => {
    const adapter = makeAdapter({ succeeded: 1, failed: [] });
    setupClient(adapter);

    // First findMany: single-product links for the deducted component IDs.
    // (none in this test — component C1 and C2 may not have their own WC links)
    mockPrisma.productLink.findMany
      .mockResolvedValueOnce([] as any) // single-product links
      .mockResolvedValueOnce([           // bundle links containing C1 or C2
        { id: 'bl-bundle', externalProductId: '200', externalVariantId: null },
      ] as any);

    // computeBundleStockStatus reports outofstock (C2 only has qty 1, needs 2)
    mockComputeBundleStockStatus.mockResolvedValue({ status: 'outofstock' });

    await pushStockForProducts('int-1', [1, 2]);

    expect(adapter.batchUpdateProductStock).toHaveBeenCalledTimes(1);
    const updates = adapter.batchUpdateProductStock.mock.calls[0][2];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      productId: '200',
      stockStatus: 'outofstock',
    });

    // computeBundleStockStatus was called with the bundle link id and null syncLocationId
    expect(mockComputeBundleStockStatus).toHaveBeenCalledWith('bl-bundle', null);
  });

  // 2. When all components have sufficient stock, the bundle should go instock.
  it('pushes instock to bundle when all components have sufficient stock', async () => {
    const adapter = makeAdapter({ succeeded: 1, failed: [] });
    setupClient(adapter);

    mockPrisma.productLink.findMany
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([
        { id: 'bl-ok', externalProductId: '300', externalVariantId: null },
      ] as any);

    mockComputeBundleStockStatus.mockResolvedValue({ status: 'instock' });

    await pushStockForProducts('int-1', [10, 20]);

    const updates = adapter.batchUpdateProductStock.mock.calls[0][2];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      productId: '300',
      stockStatus: 'instock',
    });
  });

  // 3. Bundles whose components were NOT in the deducted set must NOT be pushed.
  it('does not push for bundles unrelated to the deducted productIds', async () => {
    const adapter = makeAdapter({ succeeded: 1, failed: [] });
    setupClient(adapter);

    // B1 contains C1+C2 (deducted). B2 contains C3+C4 (not deducted).
    // The Prisma query filters by bundleComponents.some.internalProductId IN [C1, C2],
    // so B2 should never be returned.
    mockPrisma.productLink.findMany
      .mockResolvedValueOnce([] as any)   // single-product links
      .mockResolvedValueOnce([            // only B1 returned (Prisma filters B2 out)
        { id: 'bl-1', externalProductId: '400', externalVariantId: null },
      ] as any);

    mockComputeBundleStockStatus.mockResolvedValue({ status: 'outofstock' });

    await pushStockForProducts('int-1', [1, 2]);

    const updates = adapter.batchUpdateProductStock.mock.calls[0][2];
    expect(updates).toHaveLength(1);
    expect(updates[0].productId).toBe('400');

    // B2 (externalProductId '500') was never pushed
    expect(updates.find((u: any) => u.productId === '500')).toBeUndefined();

    // computeBundleStockStatus was only called for B1
    expect(mockComputeBundleStockStatus).toHaveBeenCalledTimes(1);
    expect(mockComputeBundleStockStatus).toHaveBeenCalledWith('bl-1', null);
  });

  // 4. Both single-product links AND bundle links are pushed in the same batch.
  it('pushes both single-product links and bundle links in one batch', async () => {
    const adapter = makeAdapter({ succeeded: 2, failed: [] });
    setupClient(adapter);

    // Single-product link for component C1
    mockPrisma.productLink.findMany
      .mockResolvedValueOnce([
        makeSingleLink({ externalProductId: '10', internalProductId: 1, locations: [{ locationId: 1, quantity: 5 }] }),
      ] as any)
      .mockResolvedValueOnce([
        { id: 'bl-mixed', externalProductId: '99', externalVariantId: null },
      ] as any);

    mockComputeBundleStockStatus.mockResolvedValue({ status: 'outofstock' });

    await pushStockForProducts('int-1', [1, 2]);

    const updates = adapter.batchUpdateProductStock.mock.calls[0][2];
    expect(updates).toHaveLength(2);

    const singleUpdate = updates.find((u: any) => u.productId === '10');
    expect(singleUpdate?.stockStatus).toBe('instock');

    const bundleUpdate = updates.find((u: any) => u.productId === '99');
    expect(bundleUpdate?.stockStatus).toBe('outofstock');
  });

  // 5. The -1 sentinel (bundle placeholder) is ignored when no real component
  //    IDs are present — nothing gets pushed.
  it('does nothing when only the -1 sentinel is passed (no positive component IDs)', async () => {
    const adapter = makeAdapter({ succeeded: 0, failed: [] });
    setupClient(adapter);

    // Even if findMany were to return something, the guard prevents the call
    mockPrisma.productLink.findMany.mockResolvedValue([] as any);

    await pushStockForProducts('int-1', [-1]);

    // No single-product links found, bundle query not attempted (positiveIds is empty)
    // and no updates accumulated → batchUpdateProductStock never called
    expect(adapter.batchUpdateProductStock).not.toHaveBeenCalled();
  });

  // 6. syncLocationId is forwarded to computeBundleStockStatus for bundles.
  it('passes syncLocationId to computeBundleStockStatus', async () => {
    const adapter = makeAdapter({ succeeded: 1, failed: [] });
    setupClient(adapter, { syncLocationId: 3 });

    mockPrisma.productLink.findMany
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([
        { id: 'bl-loc', externalProductId: '777', externalVariantId: null },
      ] as any);

    mockComputeBundleStockStatus.mockResolvedValue({ status: 'instock' });

    await pushStockForProducts('int-1', [5]);

    expect(mockComputeBundleStockStatus).toHaveBeenCalledWith('bl-loc', 3);
  });

  // 7. stockSyncEnabled=false: function returns early, no bundles pushed.
  it('returns early without pushing bundles when stockSyncEnabled is false', async () => {
    const adapter = makeAdapter();
    setupClient(adapter, { stockSyncEnabled: false });

    await pushStockForProducts('int-1', [1, 2]);

    expect(mockPrisma.productLink.findMany).not.toHaveBeenCalled();
    expect(adapter.batchUpdateProductStock).not.toHaveBeenCalled();
  });

  // 8. Orphan component warning is logged but does not prevent the push.
  it('logs orphan warning and still pushes outofstock for bundle with deleted component', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = makeAdapter({ succeeded: 1, failed: [] });
    setupClient(adapter);

    mockPrisma.productLink.findMany
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([
        { id: 'bl-orphan', externalProductId: '888', externalVariantId: null },
      ] as any);

    mockComputeBundleStockStatus.mockResolvedValue({
      status: 'outofstock',
      warning: { kind: 'orphan-component', internalProductId: 99 },
    });

    await pushStockForProducts('int-1', [1]);

    const updates = adapter.batchUpdateProductStock.mock.calls[0][2];
    expect(updates).toHaveLength(1);
    expect(updates[0].productId).toBe('888');
    expect(updates[0].stockStatus).toBe('outofstock');

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('orphan'),
      expect.anything()
    );

    consoleSpy.mockRestore();
  });
});
