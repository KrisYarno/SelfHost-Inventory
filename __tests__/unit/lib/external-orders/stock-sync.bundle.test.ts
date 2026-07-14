/**
 * @jest-environment node
 *
 * Tests for pushStockForProducts bundle handling (P0-3).
 *
 * Verifies that after fulfillment/unfulfillment, bundles whose components were
 * deducted/restored get their WC stock_status pushed immediately — not just the
 * individual component links.
 */

import type { PlatformAdapter } from '@/lib/platforms/core/types';
import type { EgressResult } from '@/lib/platforms/egress';

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

const mockPushStockStatus = jest.fn();
jest.mock('@/lib/platforms/egress', () => ({
  __esModule: true,
  pushStockStatus: (...args: unknown[]) => mockPushStockStatus(...args),
}));

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
  mockPushStockStatus.mockReset();
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

/** Lane 6: the adapter carries no write methods; egress does the sending. */
function makeAdapter(): PlatformAdapter {
  return {
    platform: 'WOOCOMMERCE',
    extractWebhookHeaders: jest.fn(),
    verifyWebhook: jest.fn(),
    parseOrderWebhook: jest.fn(),
  } as unknown as PlatformAdapter;
}

/** A "the wire calls went through" fan-out (REV-2 #5 partial shape). */
function egressSent(count: number): EgressResult {
  return {
    status: 'partial',
    results: Array.from({ length: count }, () => ({
      status: 'sent' as const,
      httpStatus: 200,
      body: {},
    })),
  };
}

function setupClient(
  adapter: PlatformAdapter,
  integrationOverrides: Record<string, unknown> = {}
) {
  const integration = makeIntegration(integrationOverrides);
  // Lane 6: metadata only — no credentials, no storeUrl (REV-2 #9).
  mockGetIntegrationClient.mockResolvedValue({
    adapter,
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
    const adapter = makeAdapter();
    mockPushStockStatus.mockResolvedValue(egressSent(1));
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

    expect(mockPushStockStatus).toHaveBeenCalledTimes(1);
    const updates = mockPushStockStatus.mock.calls[0][1];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      externalProductId: '200',
      inStock: false,
    });

    // computeBundleStockStatus was called with the bundle link id and null syncLocationId
    expect(mockComputeBundleStockStatus).toHaveBeenCalledWith('bl-bundle', null);
  });

  // 2. When all components have sufficient stock, the bundle should go instock.
  it('pushes instock to bundle when all components have sufficient stock', async () => {
    const adapter = makeAdapter();
    mockPushStockStatus.mockResolvedValue(egressSent(1));
    setupClient(adapter);

    mockPrisma.productLink.findMany
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([
        { id: 'bl-ok', externalProductId: '300', externalVariantId: null },
      ] as any);

    mockComputeBundleStockStatus.mockResolvedValue({ status: 'instock' });

    await pushStockForProducts('int-1', [10, 20]);

    const updates = mockPushStockStatus.mock.calls[0][1];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      externalProductId: '300',
      inStock: true,
    });
  });

  // 3. Bundles whose components were NOT in the deducted set must NOT be pushed.
  it('does not push for bundles unrelated to the deducted productIds', async () => {
    const adapter = makeAdapter();
    mockPushStockStatus.mockResolvedValue(egressSent(1));
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

    const updates = mockPushStockStatus.mock.calls[0][1];
    expect(updates).toHaveLength(1);
    expect(updates[0].externalProductId).toBe('400');

    // B2 (externalProductId '500') was never pushed
    expect(updates.find((u: any) => u.externalProductId === '500')).toBeUndefined();

    // computeBundleStockStatus was only called for B1
    expect(mockComputeBundleStockStatus).toHaveBeenCalledTimes(1);
    expect(mockComputeBundleStockStatus).toHaveBeenCalledWith('bl-1', null);
  });

  // 4. Both single-product links AND bundle links are pushed in the same batch.
  it('pushes both single-product links and bundle links in one batch', async () => {
    const adapter = makeAdapter();
    mockPushStockStatus.mockResolvedValue(egressSent(2));
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

    const updates = mockPushStockStatus.mock.calls[0][1];
    expect(updates).toHaveLength(2);

    const singleUpdate = updates.find((u: any) => u.externalProductId === '10');
    expect(singleUpdate?.inStock).toBe(true);

    const bundleUpdate = updates.find((u: any) => u.externalProductId === '99');
    expect(bundleUpdate?.inStock).toBe(false);
  });

  // 5. The -1 sentinel (bundle placeholder) is ignored when no real component
  //    IDs are present — nothing gets pushed.
  it('does nothing when only the -1 sentinel is passed (no positive component IDs)', async () => {
    const adapter = makeAdapter();
    mockPushStockStatus.mockResolvedValue(egressSent(0));
    setupClient(adapter);

    // Even if findMany were to return something, the guard prevents the call
    mockPrisma.productLink.findMany.mockResolvedValue([] as any);

    await pushStockForProducts('int-1', [-1]);

    // No single-product links found, bundle query not attempted (positiveIds is empty)
    // and no updates accumulated → egress.pushStockStatus never called
    expect(mockPushStockStatus).not.toHaveBeenCalled();
  });

  // 6. syncLocationId is forwarded to computeBundleStockStatus for bundles.
  it('passes syncLocationId to computeBundleStockStatus', async () => {
    const adapter = makeAdapter();
    mockPushStockStatus.mockResolvedValue(egressSent(1));
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
    mockPushStockStatus.mockResolvedValue(egressSent(0));
    setupClient(adapter, { stockSyncEnabled: false });

    await pushStockForProducts('int-1', [1, 2]);

    expect(mockPrisma.productLink.findMany).not.toHaveBeenCalled();
    expect(mockPushStockStatus).not.toHaveBeenCalled();
  });

  // 8. Orphan component warning is logged but does not prevent the push.
  it('logs orphan warning and still pushes outofstock for bundle with deleted component', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = makeAdapter();
    mockPushStockStatus.mockResolvedValue(egressSent(1));
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

    const updates = mockPushStockStatus.mock.calls[0][1];
    expect(updates).toHaveLength(1);
    expect(updates[0].externalProductId).toBe('888');
    expect(updates[0].inStock).toBe(false);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('orphan'),
      expect.anything()
    );

    consoleSpy.mockRestore();
  });

  // FIX I (P2): dedup updates by (externalProductId, externalVariantId) before
  // calling egress.pushStockStatus. A single-product link AND a bundle link
  // pointing at the same WC product, OR two components mapping to the same
  // bundle, would otherwise produce duplicate updates and redundant API calls.
  it('dedups duplicate (externalProductId, externalVariantId) updates before sending', async () => {
    const adapter = makeAdapter();
    mockPushStockStatus.mockResolvedValue(egressSent(1));
    setupClient(adapter);

    // Two single-product links pointing at the SAME externalProductId '999'
    // (e.g., two internal products both linked to the same WC product — rare
    // but legal). Without Fix I, both would produce updates.
    mockPrisma.productLink.findMany
      .mockResolvedValueOnce([
        makeSingleLink({
          externalProductId: '999',
          internalProductId: 1,
          locations: [{ locationId: 1, quantity: 5 }],
        }),
        makeSingleLink({
          externalProductId: '999',
          internalProductId: 2,
          locations: [{ locationId: 1, quantity: 5 }],
        }),
      ] as any)
      .mockResolvedValueOnce([] as any);

    await pushStockForProducts('int-1', [1, 2]);

    // Without dedup the adapter would receive 2 updates for productId 999;
    // with dedup it should receive only 1.
    const updates = mockPushStockStatus.mock.calls[0][1];
    expect(updates).toHaveLength(1);
    expect(updates[0].externalProductId).toBe('999');
  });
});
