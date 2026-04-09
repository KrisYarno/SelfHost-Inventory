/**
 * @jest-environment node
 */

/**
 * Tests for WooCommerce adapter write methods (Phase D).
 *
 * Mocks global.fetch to simulate WC REST API responses for:
 *   - batchUpdateProductStock
 *   - updateOrderStatus
 */

import { WooCommerceAdapter } from '@/lib/platforms/woocommerce/adapter';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const adapter = new WooCommerceAdapter();
const storeUrl = 'https://store.test';
const credentials = { key: 'ck_test', secret: 'cs_test' };

const originalFetch = global.fetch;

beforeEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  global.fetch = originalFetch;
});

// Helper to create a mock fetch Response
function mockResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers ?? {}),
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

// ===========================================================================
// batchUpdateProductStock
// ===========================================================================

describe('batchUpdateProductStock', () => {
  // 1. Full batch success (simple products)
  it('full batch success for simple products', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse(200, {
        update: [
          { id: 10 },
          { id: 20 },
        ],
      })
    );

    const result = await adapter.batchUpdateProductStock(storeUrl, credentials, [
      { productId: '10', stockStatus: 'instock' },
      { productId: '20', stockStatus: 'outofstock' },
    ]);

    expect(result.succeeded).toBe(2);
    expect(result.failed).toHaveLength(0);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Verify the URL is the products batch endpoint
    const callUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(callUrl).toContain('/wp-json/wc/v3/products/batch');
  });

  // 2. Partial failure (some items fail in batch response)
  it('partial failure from batch response', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse(200, {
        update: [
          { id: 10 },
          { id: 20, error: { message: 'Product not found' } },
        ],
      })
    );

    const result = await adapter.batchUpdateProductStock(storeUrl, credentials, [
      { productId: '10', stockStatus: 'instock' },
      { productId: '20', stockStatus: 'outofstock' },
    ]);

    expect(result.succeeded).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].productId).toBe('20');
    expect(result.failed[0].error).toContain('Product not found');
  });

  // 3. Empty batch returns { succeeded: 0, failed: [] }
  it('empty batch returns zero results', async () => {
    global.fetch = jest.fn();

    const result = await adapter.batchUpdateProductStock(storeUrl, credentials, []);

    expect(result.succeeded).toBe(0);
    expect(result.failed).toHaveLength(0);
    // No HTTP calls should be made for empty input
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // 4. >50 items splits into multiple requests
  it('>50 items splits into multiple batch requests', async () => {
    // Create 75 items
    const updates = Array.from({ length: 75 }, (_, i) => ({
      productId: `${i + 1}`,
      stockStatus: 'instock' as const,
    }));

    // Mock: first call returns 50 successes, second call returns 25 successes
    global.fetch = jest.fn()
      .mockResolvedValueOnce(
        mockResponse(200, {
          update: Array.from({ length: 50 }, (_, i) => ({ id: i + 1 })),
        })
      )
      .mockResolvedValueOnce(
        mockResponse(200, {
          update: Array.from({ length: 25 }, (_, i) => ({ id: i + 51 })),
        })
      );

    const result = await adapter.batchUpdateProductStock(storeUrl, credentials, updates);

    expect(result.succeeded).toBe(75);
    expect(result.failed).toHaveLength(0);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  // 5. Variant products use per-parent variation batch endpoint
  it('variant products use per-parent variation batch endpoint', async () => {
    // Mock: first call = simple product batch, second call = variation batch
    global.fetch = jest.fn()
      .mockResolvedValueOnce(
        mockResponse(200, { update: [{ id: 10 }] })
      )
      .mockResolvedValueOnce(
        mockResponse(200, { update: [{ id: 101 }, { id: 102 }] })
      );

    const result = await adapter.batchUpdateProductStock(storeUrl, credentials, [
      { productId: '10', stockStatus: 'instock' },                         // simple
      { productId: '50', variantId: '101', stockStatus: 'instock' },       // variation of parent 50
      { productId: '50', variantId: '102', stockStatus: 'outofstock' },    // variation of parent 50
    ]);

    expect(result.succeeded).toBe(3);
    expect(result.failed).toHaveLength(0);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    // Check that the second call uses the variation endpoint
    const secondCallUrl = (global.fetch as jest.Mock).mock.calls[1][0];
    expect(secondCallUrl).toContain('/wp-json/wc/v3/products/50/variations/batch');
  });

  // 6. 429 response -> read Retry-After -> retry -> success
  it('retries on 429 with Retry-After header', async () => {
    global.fetch = jest.fn()
      // First attempt: 429 with Retry-After: 1
      .mockResolvedValueOnce(
        mockResponse(429, { message: 'Rate limited' }, { 'Retry-After': '1' })
      )
      // Retry: success
      .mockResolvedValueOnce(
        mockResponse(200, { update: [{ id: 10 }] })
      );

    const result = await adapter.batchUpdateProductStock(storeUrl, credentials, [
      { productId: '10', stockStatus: 'instock' },
    ]);

    expect(result.succeeded).toBe(1);
    expect(result.failed).toHaveLength(0);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  // 7. 429 retry also fails -> log and continue remaining batches
  it('429 retry failure marks batch as failed and continues', async () => {
    // Two batches of 50 each (100 items total to force 2 batches)
    const updates = Array.from({ length: 100 }, (_, i) => ({
      productId: `${i + 1}`,
      stockStatus: 'instock' as const,
    }));

    global.fetch = jest.fn()
      // First batch: 429
      .mockResolvedValueOnce(
        mockResponse(429, { message: 'Rate limited' }, { 'Retry-After': '1' })
      )
      // First batch retry: still 429
      .mockResolvedValueOnce(
        mockResponse(429, { message: 'Rate limited' }, { 'Retry-After': '1' })
      )
      // Second batch: success
      .mockResolvedValueOnce(
        mockResponse(200, {
          update: Array.from({ length: 50 }, (_, i) => ({ id: i + 51 })),
        })
      );

    const result = await adapter.batchUpdateProductStock(storeUrl, credentials, updates);

    // First batch of 50 failed (429 persisted), second batch of 50 succeeded
    expect(result.succeeded).toBe(50);
    expect(result.failed).toHaveLength(50);
    // Verify it continued to the second batch
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  // 8. Timeout -> error returned
  it('timeout error is captured in failed results', async () => {
    const timeoutError = new Error('The operation was aborted');
    timeoutError.name = 'AbortError';

    global.fetch = jest.fn().mockRejectedValue(timeoutError);

    const result = await adapter.batchUpdateProductStock(storeUrl, credentials, [
      { productId: '10', stockStatus: 'instock' },
    ]);

    expect(result.succeeded).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].productId).toBe('10');
    expect(result.failed[0].error).toContain('aborted');
  });

  // 9. Auth failure -> error returned
  it('auth failure (401) marks all batch items as failed', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse(401, { message: 'Invalid consumer key' })
    );

    const result = await adapter.batchUpdateProductStock(storeUrl, credentials, [
      { productId: '10', stockStatus: 'instock' },
      { productId: '20', stockStatus: 'outofstock' },
    ]);

    expect(result.succeeded).toBe(0);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0].error).toContain('401');
  });
});

// ===========================================================================
// updateOrderStatus
// ===========================================================================

describe('updateOrderStatus', () => {
  // 10. Success
  it('returns success on 200 response', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse(200, { id: 123, status: 'completed' })
    );

    const result = await adapter.updateOrderStatus(storeUrl, credentials, '123', 'completed');

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    // Verify URL and body
    const callUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(callUrl).toContain('/wp-json/wc/v3/orders/123');
    const callOpts = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(JSON.parse(callOpts.body)).toEqual({ status: 'completed' });
  });

  // 11. Timeout
  it('returns error on timeout', async () => {
    const timeoutError = new Error('The operation was aborted');
    timeoutError.name = 'AbortError';

    global.fetch = jest.fn().mockRejectedValue(timeoutError);

    const result = await adapter.updateOrderStatus(storeUrl, credentials, '123', 'completed');

    expect(result.success).toBe(false);
    expect(result.error).toContain('aborted');
  });

  // 12. 429 retry with Retry-After header (P1 coverage gap)
  it('retries once on 429 with Retry-After header', async () => {
    jest.useFakeTimers();

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        mockResponse(429, { message: 'Rate limited' }, { 'Retry-After': '1' })
      )
      .mockResolvedValueOnce(mockResponse(200, { id: 123, status: 'completed' }));
    global.fetch = fetchMock;

    const promise = adapter.updateOrderStatus(
      storeUrl,
      credentials,
      '123',
      'completed'
    );

    // Advance through the 1-second Retry-After wait
    await jest.advanceTimersByTimeAsync(1100);

    const result = await promise;

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });

  // 13. 429 retry fails a second time (P1 coverage gap)
  it('returns error when 429 retry also fails', async () => {
    jest.useFakeTimers();

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        mockResponse(429, { message: 'Rate limited' }, { 'Retry-After': '1' })
      )
      .mockResolvedValueOnce(
        mockResponse(429, { message: 'Still rate limited' }, { 'Retry-After': '1' })
      );
    global.fetch = fetchMock;

    const promise = adapter.updateOrderStatus(
      storeUrl,
      credentials,
      '123',
      'completed'
    );

    await jest.advanceTimersByTimeAsync(1100);

    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toContain('429');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });
});
