/** @jest-environment jsdom */
/**
 * Facelift F2-3 (plan 2026-11-19-facelift-f2, REV 1 as amended by REV 2 A18) —
 * `useProducts` gains two optional server-side filters, `stock` and
 * `hereLocationId`.
 *
 *   - Each is sent only when set: `stock` only when it is not `all`,
 *     `hereLocationId` only when it is a number.
 *   - Both are part of the query key, so changing either reads again.
 *   - A caller that passes neither (the receiving pickers, today's Products list)
 *     sends today's EXACT request.
 *   - REV 3 B1: `useProducts(filters, { enabled })` can wait; `enabled` defaults
 *     to true and is NOT part of the query key.
 *   - REV 3 B5: the response type carries the `stock` the answer describes.
 */

import React from 'react';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { useProducts } from '@/hooks/use-products';

jest.mock('@/hooks/use-csrf', () => ({
  useCSRF: () => ({ token: 't', isLoading: false, error: null }),
  withCSRFHeaders: (h: Record<string, string>) => h,
}));

let client: QueryClient;
function Harness({ children }: { children: ReactNode }) {
  return React.createElement(QueryClientProvider, { client }, children);
}

const mockFetch = jest.fn();
const urls = () => mockFetch.mock.calls.map(([u]) => String(u));

beforeEach(() => {
  jest.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockFetch.mockImplementation(async () => ({
    ok: true,
    json: async () => ({
      products: [],
      total: 0,
      page: 1,
      pageSize: 25,
      totalPages: 0,
      hereLocationId: null,
      stock: 'all',
    }),
  }));
  global.fetch = mockFetch as unknown as typeof fetch;
});

type Filters = Parameters<typeof useProducts>[0];

async function urlFor(filters: Filters) {
  mockFetch.mockClear();
  const { result, unmount } = renderHook(() => useProducts(filters), { wrapper: Harness });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  unmount();
  expect(mockFetch).toHaveBeenCalledTimes(1);
  return urls()[0];
}

describe('F2-3 — a caller passing neither filter sends today\'s exact request', () => {
  it('the Products list\'s shape', async () => {
    expect(
      await urlFor({ search: '', page: 1, pageSize: 25, sortBy: 'baseNameNumeric', sortOrder: 'asc' }),
    ).toBe('/api/products/optimized?sortBy=baseNameNumeric&sortOrder=asc&page=1&pageSize=25');
  });

  it('the receiving pickers\' shape', async () => {
    expect(await urlFor({ search: 'BPC', page: 1, pageSize: 25 })).toBe(
      '/api/products/optimized?search=BPC&page=1&pageSize=25',
    );
  });

  it('stock "all" and hereLocationId null send nothing extra', async () => {
    expect(await urlFor({ search: 'BPC', page: 1, pageSize: 25, stock: 'all', hereLocationId: null })).toBe(
      '/api/products/optimized?search=BPC&page=1&pageSize=25',
    );
  });
});

describe('F2-3 — the filters are sent when set', () => {
  it.each(['in-stock', 'low', 'out'] as const)('stock=%s is sent', async (stock) => {
    expect(await urlFor({ page: 1, pageSize: 25, stock })).toBe(
      `/api/products/optimized?page=1&pageSize=25&stock=${stock}`,
    );
  });

  it('hereLocationId is sent', async () => {
    expect(await urlFor({ page: 2, pageSize: 25, hereLocationId: 3 })).toBe(
      '/api/products/optimized?page=2&pageSize=25&hereLocationId=3',
    );
  });

  it('both, beside the search and sort', async () => {
    const url = new URL(
      await urlFor({
        search: 'Wid',
        page: 1,
        pageSize: 25,
        sortBy: 'baseNameNumeric',
        sortOrder: 'asc',
        stock: 'low',
        hereLocationId: 7,
      }),
      'http://t',
    );
    expect(url.pathname).toBe('/api/products/optimized');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      search: 'Wid',
      sortBy: 'baseNameNumeric',
      sortOrder: 'asc',
      page: '1',
      pageSize: '25',
      stock: 'low',
      hereLocationId: '7',
    });
  });
});

describe('F2-3 — the query key changes with them', () => {
  it('a new stock or hereLocationId is a new key and a new read', async () => {
    let filters: Filters = { page: 1, pageSize: 25 };
    const { result, rerender } = renderHook(() => useProducts(filters), { wrapper: Harness });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    filters = { page: 1, pageSize: 25, stock: 'low' };
    rerender();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    filters = { page: 1, pageSize: 25, stock: 'low', hereLocationId: 4 };
    rerender();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));

    filters = { page: 1, pageSize: 25, stock: 'low', hereLocationId: 5 };
    rerender();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(4));

    const keys = client
      .getQueryCache()
      .findAll({ queryKey: ['products'] })
      .map((q) => q.queryKey[1] as Record<string, unknown>);
    expect(keys).toEqual([
      { page: 1, pageSize: 25, search: '' },
      { page: 1, pageSize: 25, stock: 'low', search: '' },
      { page: 1, pageSize: 25, stock: 'low', hereLocationId: 4, search: '' },
      { page: 1, pageSize: 25, stock: 'low', hereLocationId: 5, search: '' },
    ]);
  });

  it('a caller passing neither keeps today\'s key', async () => {
    const { result } = renderHook(
      () => useProducts({ search: 'BPC', page: 1, pageSize: 25 }),
      { wrapper: Harness },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryCache().findAll({ queryKey: ['products'] })[0].queryKey).toEqual([
      'products',
      { search: 'BPC', page: 1, pageSize: 25 },
    ]);
  });

  it('the response type carries hereLocationId and (B5) stock', async () => {
    mockFetch.mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        products: [],
        total: 0,
        page: 1,
        pageSize: 25,
        totalPages: 0,
        hereLocationId: 3,
        stock: 'low',
      }),
    }));
    const { result } = renderHook(
      () => useProducts({ page: 1, pageSize: 25, hereLocationId: 3, stock: 'low' }),
      { wrapper: Harness },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const echoed: number | null = result.current.data!.hereLocationId;
    const stock: 'all' | 'in-stock' | 'low' | 'out' = result.current.data!.stock;
    expect(echoed).toBe(3);
    expect(stock).toBe('low');
  });
});

describe('REV 3 B1 — useProducts can wait (options.enabled)', () => {
  const settle = () => new Promise((r) => setTimeout(r, 30));

  it('enabled: false sends nothing', async () => {
    const { result } = renderHook(() => useProducts({ page: 1, pageSize: 25 }, { enabled: false }), {
      wrapper: Harness,
    });
    await settle();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('the default sends (no options, and an options object without enabled)', async () => {
    expect(await urlFor({ page: 1, pageSize: 25 })).toBe('/api/products/optimized?page=1&pageSize=25');

    mockFetch.mockClear();
    const { result } = renderHook(() => useProducts({ page: 1, pageSize: 25 }, {}), { wrapper: Harness });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('turning enabled on sends then — and enabled is NOT part of the query key', async () => {
    let enabled = false;
    const { result, rerender } = renderHook(
      () => useProducts({ page: 1, pageSize: 25, hereLocationId: 2 }, { enabled }),
      { wrapper: Harness },
    );
    await settle();
    expect(mockFetch).not.toHaveBeenCalled();

    enabled = true;
    rerender();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(urls()).toEqual(['/api/products/optimized?page=1&pageSize=25&hereLocationId=2']);

    const keys = client
      .getQueryCache()
      .findAll({ queryKey: ['products'] })
      .map((q) => q.queryKey);
    expect(keys).toEqual([['products', { page: 1, pageSize: 25, hereLocationId: 2, search: '' }]]);
  });
});
