/** @jest-environment jsdom */
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { useProductLocationQuantity } from "@/hooks/use-product-location-quantity";

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ currentQuantity: 7 }) })) as unknown as typeof fetch;
});

test("fetches with locationId and limit=1, returns the quantity", async () => {
  const { result } = renderHook(() => useProductLocationQuantity(42, 2), { wrapper: makeWrapper() });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toBe(7);
  const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
  expect(url).toContain("/api/inventory/product/42");
  expect(url).toContain("locationId=2");
  expect(url).toContain("limit=1");
});

test("disabled when locationId is null or enabled:false", () => {
  renderHook(() => useProductLocationQuantity(42, null), { wrapper: makeWrapper() });
  renderHook(() => useProductLocationQuantity(42, 2, { enabled: false }), { wrapper: makeWrapper() });
  expect(global.fetch).not.toHaveBeenCalled();
});

test("passes an AbortSignal", async () => {
  const { result } = renderHook(() => useProductLocationQuantity(42, 2), { wrapper: makeWrapper() });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect((global.fetch as jest.Mock).mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
});
