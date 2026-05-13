// @jest-environment node
import { fetchWooCatalog } from '@/lib/platforms/woocommerce/fetch-catalog';

const STORE = 'https://store.example.com';
const KEY = 'ck_x';
const SECRET = 'cs_x';

function mockResponseQueue(queue: Array<{ status: number; body: unknown }>) {
  const fetchMock = jest.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('no more queued responses');
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    } as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('fetchWooCatalog', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns empty rows for an empty store', async () => {
    mockResponseQueue([{ status: 200, body: [] }]);
    const out = await fetchWooCatalog(STORE, KEY, SECRET);
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
    const out = await fetchWooCatalog(STORE, KEY, SECRET);
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
    const out = await fetchWooCatalog(STORE, KEY, SECRET);
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
    const out = await fetchWooCatalog(STORE, KEY, SECRET);
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
    const out = await fetchWooCatalog(STORE, KEY, SECRET);
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
    const out = await fetchWooCatalog(STORE, KEY, SECRET, { deadlineMs: 0 });
    const timeoutWarnings = out.warnings.filter((w) => w.kind === 'timeout-skipped');
    expect(timeoutWarnings.length).toBeGreaterThan(0);
  });
});
