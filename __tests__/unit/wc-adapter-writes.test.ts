/**
 * @jest-environment node
 */

/**
 * WooCommerce adapter — WRITE REQUEST SHAPING.
 *
 * LANE 6 REWRITE. This suite used to drive `batchUpdateProductStock` and
 * `updateOrderStatus` against a mocked `global.fetch`. Those two methods held the
 * only `fetch()` calls that could mutate the live store, and they took
 * `(storeUrl, credentials, ...)` from whoever called them — so every holder of an
 * adapter was a write surface.
 *
 * They are GONE. The adapter now only DESCRIBES what a WooCommerce write looks
 * like; lib/platforms/egress decides whether a single byte may leave (that half
 * is covered by egress-gates.test.ts).
 *
 * These builders are PURE. There is nothing to mock here, because there is
 * nothing here that can reach the network — which is the entire point.
 */

import { WooCommerceAdapter } from '@/lib/platforms/woocommerce/adapter';

const adapter = new WooCommerceAdapter();

describe('buildStockStatusRequests', () => {
  it('shapes simple products into ONE products/batch request', () => {
    const requests = adapter.buildStockStatusRequests([
      { externalProductId: '101', inStock: true },
      { externalProductId: '102', inStock: false },
    ]);

    expect(requests).toEqual([
      {
        op: 'products_batch',
        updates: [
          { id: '101', stock_status: 'instock' },
          { id: '102', stock_status: 'outofstock' },
        ],
      },
    ]);
  });

  it('maps inStock -> stock_status and NOTHING else (Amendment 11)', () => {
    const [req] = adapter.buildStockStatusRequests([
      { externalProductId: '1', inStock: true },
    ]);

    // Never manage_stock, never stock_quantity. Pushing a quantity would make the
    // app the source of truth for stock in a store that manages its own.
    const update = req.updates[0] as unknown as Record<string, unknown>;
    expect(Object.keys(update).sort()).toEqual(['id', 'stock_status']);
  });

  it('groups variations by PARENT into per-parent variations/batch requests', () => {
    const requests = adapter.buildStockStatusRequests([
      { externalProductId: '10', externalVariationId: '11', inStock: true },
      { externalProductId: '10', externalVariationId: '12', inStock: false },
      { externalProductId: '20', externalVariationId: '21', inStock: true },
    ]);

    expect(requests).toEqual([
      {
        op: 'variations_batch',
        parentId: '10',
        updates: [
          { id: '11', stock_status: 'instock' },
          { id: '12', stock_status: 'outofstock' },
        ],
      },
      {
        op: 'variations_batch',
        parentId: '20',
        updates: [{ id: '21', stock_status: 'instock' }],
      },
    ]);
  });

  it('separates simple products from variations (Amendment 6)', () => {
    const requests = adapter.buildStockStatusRequests([
      { externalProductId: '1', inStock: true },
      { externalProductId: '10', externalVariationId: '11', inStock: false },
    ]);

    expect(requests).toHaveLength(2);
    expect(requests[0].op).toBe('products_batch');
    expect(requests[1].op).toBe('variations_batch');
  });

  it('chunks simple products at 50 per request', () => {
    const updates = Array.from({ length: 120 }, (_, i) => ({
      externalProductId: String(i + 1),
      inStock: true,
    }));

    const requests = adapter.buildStockStatusRequests(updates);

    expect(requests).toHaveLength(3);
    expect(requests[0].updates).toHaveLength(50);
    expect(requests[1].updates).toHaveLength(50);
    expect(requests[2].updates).toHaveLength(20);
  });

  it('chunks variations at 50 per parent', () => {
    const updates = Array.from({ length: 75 }, (_, i) => ({
      externalProductId: '10',
      externalVariationId: String(i + 100),
      inStock: false,
    }));

    const requests = adapter.buildStockStatusRequests(updates);

    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.op === 'variations_batch')).toBe(true);
    expect(requests[0].updates).toHaveLength(50);
    expect(requests[1].updates).toHaveLength(25);
  });

  it('returns NO requests for an empty update list', () => {
    expect(adapter.buildStockStatusRequests([])).toEqual([]);
  });
});

describe('buildOrderStatusRequest', () => {
  it('shapes an order-status write', () => {
    expect(adapter.buildOrderStatusRequest('123', 'completed')).toEqual({
      op: 'order_status',
      externalOrderId: '123',
      status: 'completed',
    });
  });

  it('carries the status verbatim for the gate to validate', () => {
    expect(adapter.buildOrderStatusRequest('9', 'processing').status).toBe(
      'processing'
    );
  });
});

describe('the write surface is closed', () => {
  it('the adapter no longer exposes methods that perform I/O', () => {
    // These two were the entire write surface toward the live store. Their
    // absence is the structural guarantee this lane exists to create.
    const surface = adapter as unknown as Record<string, unknown>;
    expect(surface.batchUpdateProductStock).toBeUndefined();
    expect(surface.updateOrderStatus).toBeUndefined();
  });

  it('the builders take no credential and no store URL', () => {
    // If either signature ever grows one, the adapter has become able to address
    // a store again — that is the regression this asserts against.
    expect(adapter.buildStockStatusRequests).toHaveLength(1);
    expect(adapter.buildOrderStatusRequest).toHaveLength(2);
  });
});
