// @jest-environment node

/**
 * LANE 6: fetch-catalog no longer calls fetch, and no longer takes a storeUrl or
 * credentials. It reads through `egress.platformRead`, which resolves the READ
 * credential and pins the origin — so a catalog fetch is now physically incapable
 * of writing to the store. These tests therefore queue responses on platformRead.
 */

const mockPlatformRead = jest.fn();
jest.mock('@/lib/platforms/egress', () => ({
  __esModule: true,
  platformRead: (...args: unknown[]) => mockPlatformRead(...args),
}));

import { fetchWooCatalog } from '@/lib/platforms/woocommerce/fetch-catalog';

const INTEGRATION_ID = 'int-1';

function mockResponseQueue(queue: Array<{ status: number; body: unknown }>) {
  mockPlatformRead.mockImplementation(async () => {
    const next = queue.shift();
    if (!next) throw new Error('no more queued responses');
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    } as Response;
  });
  return mockPlatformRead;
}

describe('fetchWooCatalog', () => {
  beforeEach(() => {
    mockPlatformRead.mockReset();
  });

  it('returns empty rows for an empty store', async () => {
    mockResponseQueue([{ status: 200, body: [] }]);
    const out = await fetchWooCatalog(INTEGRATION_ID);
    expect(out.rows).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  it('flattens simple products into rows', async () => {
    mockResponseQueue([
      {
        status: 200,
        body: [
          { id: 1, name: 'Mug', sku: 'MUG-1', type: 'simple' },
          { id: 2, name: 'Hat', sku: null, type: 'simple' },
        ],
      },
      { status: 200, body: [] }, // page 2 returns empty -> stop
    ]);
    const out = await fetchWooCatalog(INTEGRATION_ID);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]).toMatchObject({
      externalProductId: '1',
      externalVariantId: null,
      parentTitle: 'Mug',
      type: 'simple',
      sku: 'MUG-1',
    });
  });

  it('expands variable products into per-variation rows', async () => {
    mockResponseQueue([
      {
        status: 200,
        body: [{ id: 10, name: 'Coffee Beans', sku: null, type: 'variable' }],
      },
      { status: 200, body: [] },
      {
        status: 200,
        body: [
          { id: 101, sku: 'CB-1LB', attributes: [{ name: 'Size', option: '1lb' }] },
          { id: 102, sku: 'CB-5LB', attributes: [{ name: 'Size', option: '5lb' }] },
        ],
      },
    ]);
    const out = await fetchWooCatalog(INTEGRATION_ID);
    expect(out.rows).toHaveLength(2);
    expect(out.rows.map((r) => r.externalVariantId)).toEqual(['101', '102']);
    expect(out.rows[0]).toMatchObject({
      type: 'variation',
      parentTitle: 'Coffee Beans',
      variantTitle: '1lb',
    });
  });

  it('records a structured warning when variations fail', async () => {
    mockResponseQueue([
      {
        status: 200,
        body: [{ id: 10, name: 'Coffee Beans', sku: null, type: 'variable' }],
      },
      { status: 200, body: [] },
      { status: 500, body: { message: 'boom' } },
    ]);
    const out = await fetchWooCatalog(INTEGRATION_ID);
    expect(out.rows).toEqual([]);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatchObject({
      kind: 'variations-failed',
      productId: '10',
      parentTitle: 'Coffee Beans',
    });
  });

  it('stops fetching products at the page cap and emits a warning', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `P${i}`,
      sku: null,
      type: 'simple',
    }));
    mockResponseQueue(
      Array.from({ length: 105 }, () => ({ status: 200, body: fullPage })),
    );
    const out = await fetchWooCatalog(INTEGRATION_ID);
    expect(out.rows).toHaveLength(100 * 100);
    expect(out.warnings).toContainEqual(
      expect.objectContaining({ kind: 'page-cap-reached' }),
    );
  });

  it('emits a timeout-skipped warning for parents not started before the deadline', async () => {
    mockResponseQueue([
      {
        status: 200,
        body: Array.from({ length: 5 }, (_, i) => ({
          id: 100 + i,
          name: `Variable ${i}`,
          sku: null,
          type: 'variable',
        })),
      },
      { status: 200, body: [] },
    ]);
    // deadlineMs: -1 ensures Date.now() > deadline is true on the first
    // worker tick. With deadlineMs: 0, deadline = Date.now() and the worker's
    // Date.now() > deadline check is flaky inside a single ms tick — mocked
    // fetch can resolve before the clock advances. -1 is unambiguously past.
    const out = await fetchWooCatalog(INTEGRATION_ID, { deadlineMs: -1 });
    const timeoutWarnings = out.warnings.filter((w) => w.kind === 'timeout-skipped');
    expect(timeoutWarnings.length).toBeGreaterThan(0);
  });

  it('flags WPC bundles as isBundleCandidate + parses wcBundledItems', async () => {
    mockResponseQueue([
      {
        status: 200,
        body: [
          {
            id: 100,
            name: 'Recovery Bundle',
            sku: 'REC-BUNDLE',
            type: 'woosb',
            meta_data: [
              { key: '_woosb_ids', value: '10/1,20/1,30/2' },
              { key: 'other_meta', value: 'ignored' },
            ],
          },
        ],
      },
      { status: 200, body: [] },
    ]);
    const out = await fetchWooCatalog(INTEGRATION_ID);
    expect(out.rows).toHaveLength(1);
    const row = out.rows[0];
    expect(row.isBundleCandidate).toBe(true);
    expect(row.wcBundledItems).toEqual([
      { productId: '10', variantId: null, defaultQuantity: 1 },
      { productId: '20', variantId: null, defaultQuantity: 1 },
      { productId: '30', variantId: null, defaultQuantity: 2 },
    ]);
  });

  it('does not populate wcBundledItems when _woosb_ids is missing (D8)', async () => {
    mockResponseQueue([
      {
        status: 200,
        body: [{ id: 100, name: 'Bundle Without Meta', sku: null, type: 'woosb', meta_data: [] }],
      },
      { status: 200, body: [] },
    ]);
    const out = await fetchWooCatalog(INTEGRATION_ID);
    expect(out.rows[0].isBundleCandidate).toBe(true);
    expect(out.rows[0].wcBundledItems).toBeUndefined();
  });
});
