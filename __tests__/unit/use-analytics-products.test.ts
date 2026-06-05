/** @jest-environment jsdom */
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useAnalyticsProducts } from "@/hooks/use-analytics-products";

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ products: [], total: 0, page: 1, pageSize: 25 }),
  }) as unknown as typeof fetch;
});

afterEach(() => jest.clearAllMocks());

test("builds the query string from filters and hits /api/analytics/products", async () => {
  const { result } = renderHook(
    () =>
      useAnalyticsProducts({
        search: "wid",
        filter: "low",
        sort: "revenue",
        dir: "asc",
        page: 2,
        pageSize: 25,
        companyId: "c1",
        from: "2026-01-01",
        to: "2026-06-01",
      }),
    { wrapper }
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
  expect(url).toContain("/api/analytics/products?");
  expect(url).toContain("search=wid");
  expect(url).toContain("filter=low");
  expect(url).toContain("sort=revenue");
  expect(url).toContain("dir=asc");
  expect(url).toContain("page=2");
  expect(url).toContain("companyId=c1");
  expect(url).toContain("from=2026-01-01");
  expect(url).toContain("to=2026-06-01");
});

test("omits companyId when undefined (all my companies)", async () => {
  const { result } = renderHook(
    () => useAnalyticsProducts({ companyId: undefined }),
    { wrapper }
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
  expect(url).not.toContain("companyId=");
});

test("throws on non-ok response", async () => {
  (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false });
  const { result } = renderHook(() => useAnalyticsProducts({}), { wrapper });
  await waitFor(() => expect(result.current.isError).toBe(true));
});
