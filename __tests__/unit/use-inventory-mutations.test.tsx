/** @jest-environment jsdom */
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";

// Mirrors the REAL exports of @/hooks/use-csrf: useCSRF() -> { token, isLoading, error, refreshToken }
// plus the re-exported withCSRFHeaders(headers, token) from lib/csrf-client.
jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "test-token", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: HeadersInit, token: string | null) => ({ ...(h as Record<string, string>), "x-csrf-token": token ?? "" }),
}));

import { useAdjustInventory } from "@/hooks/use-inventory-mutations";

const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ success: true }) })) as unknown as typeof fetch;
});

test("adjust POSTs to /api/inventory/adjust with CSRF header and invalidates the full 8-key set", async () => {
  const spy = jest.spyOn(qc, "invalidateQueries");
  const { result } = renderHook(() => useAdjustInventory(), { wrapper });
  await result.current.mutateAsync({ productId: 42, locationId: 2, delta: 3, reason: "test" });
  await waitFor(() => expect(spy).toHaveBeenCalled());
  const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
  expect(String(fetchCall[0])).toBe("/api/inventory/adjust");
  expect(fetchCall[1].headers["x-csrf-token"]).toBe("test-token");
  const keys = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
  for (const expected of [
    ["inventory-variants"], ["product-location-quantity", 42], ["inventory-products"],
    ["inventory-logs"], ["inventory-transfers"], ["products"],
    ["dashboard-metrics"], ["dashboard-location-stock"],
  ]) {
    expect(keys).toContain(JSON.stringify(expected));
  }
  spy.mockRestore();
});

test("thrown error carries code and data from the response body", async () => {
  global.fetch = jest.fn(async () => ({
    ok: false, status: 400,
    json: async () => ({ error: "Insufficient stock", code: "INVENTORY_INSUFFICIENT_STOCK", currentQuantity: 2, shortfall: 3 }),
  })) as unknown as typeof fetch;
  const { result } = renderHook(() => useAdjustInventory(), { wrapper });
  const err = await result.current.mutateAsync({ productId: 1, locationId: 1, delta: -5 }).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toBe("Insufficient stock");
  expect(err.code).toBe("INVENTORY_INSUFFICIENT_STOCK");
  expect(err.data.currentQuantity).toBe(2);
  expect(err.data.shortfall).toBe(3);
});
