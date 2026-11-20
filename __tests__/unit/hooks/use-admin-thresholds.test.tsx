/** @jest-environment jsdom */
/**
 * Facelift F2 fix round FR2-2 (plan 2026-11-19-facelift-f2, REV 12; Q/A QA-2):
 * a threshold save refreshes the Products list. The list's stock state is
 * computed by the SERVER from the thresholds, so after either save the cached
 * `["products", …]` answers are stale: `useSaveThresholds` and
 * `useSaveLowStockDefault` (`hooks/use-admin.ts`) both also invalidate
 * `["products"]` on success, beside what they invalidated before. A refused
 * save invalidates nothing.
 */

import React from "react";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "csrf-token", isLoading: false, error: null }),
  withCSRFHeaders: (headers: Record<string, string>, token: string | null) => ({
    ...headers,
    ...(token ? { "x-csrf-token": token } : {}),
  }),
}));

import { useSaveLowStockDefault, useSaveThresholds } from "@/hooks/use-admin";
import { useProducts } from "@/hooks/use-products";

let client: QueryClient;
function Harness({ children }: { children: ReactNode }) {
  return React.createElement(QueryClientProvider, { client }, children);
}

const mockFetch = jest.fn();
let productReads = 0;

beforeEach(() => {
  jest.clearAllMocks();
  productReads = 0;
  // The app's own freshness window (lib/query-client): an answer is reused for 5 minutes.
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000 }, mutations: { retry: false } },
  });
  mockFetch.mockImplementation(async (input: unknown) => {
    const url = new URL(String(input), "http://x");
    if (url.pathname === "/api/products/optimized") {
      productReads += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ products: [], total: 0, page: 1, pageSize: 25, hereLocationId: null, stock: "all", search: "" }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  global.fetch = mockFetch as unknown as typeof fetch;
});

const refusedResponse = () => ({ ok: false, status: 400, json: async () => ({ error: "Bad threshold" }) });

const SAVES = [
  ["useSaveThresholds", () => useSaveThresholds(), [{ productId: 1, combinedMinimum: 20 }]],
  ["useSaveLowStockDefault", () => useSaveLowStockDefault(), 20],
] as const;
type Save = () => { mutateAsync: (v: unknown) => Promise<unknown> };

describe("FR2-2 — threshold saves refresh the Products list", () => {
  it("useSaveThresholds: success invalidates [\"products\"], and still [\"admin\", \"thresholds\"]", async () => {
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useSaveThresholds(), { wrapper: Harness });

    await act(async () => {
      await result.current.mutateAsync([{ productId: 1, combinedMinimum: 20 }]);
    });

    expect(mockFetch).toHaveBeenCalledWith("/api/admin/products/thresholds", expect.objectContaining({ method: "PATCH" }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["products"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "thresholds"] });
  });

  it("useSaveLowStockDefault: success invalidates [\"products\"], and still the thresholds, the settings and the cached default", async () => {
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useSaveLowStockDefault(), { wrapper: Harness });

    await act(async () => {
      await result.current.mutateAsync(20);
    });

    expect(mockFetch).toHaveBeenCalledWith("/api/admin/settings", expect.objectContaining({ method: "POST" }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["products"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "thresholds"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "settings"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["settings", "low-stock-default"] });
  });

  it.each(SAVES)("%s: a cached Products answer (within its 5 minutes) is read again on the next visit", async (_name, hook, arg) => {
    const filters = { page: 1, pageSize: 25, sortBy: "baseNameNumeric", sortOrder: "asc", stock: "all", hereLocationId: null } as const;
    // 1. The Products page reads once, then is left.
    const list = renderHook(() => useProducts(filters), { wrapper: Harness });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    list.unmount();
    expect(productReads).toBe(1);

    // 2. The thresholds page saves.
    const save = renderHook(hook as Save, { wrapper: Harness });
    await act(async () => {
      await save.result.current.mutateAsync(arg);
    });
    save.unmount();

    // 3. Back on the Products page: the answer is read again, not reused.
    const again = renderHook(() => useProducts(filters), { wrapper: Harness });
    await waitFor(() => expect(productReads).toBe(2));
    await waitFor(() => expect(again.result.current.isFetching).toBe(false));
  });

  it.each(SAVES)("%s: a refused save does not invalidate [\"products\"]", async (_name, hook, arg) => {
    mockFetch.mockResolvedValue(refusedResponse());
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const { result } = renderHook(hook as Save, { wrapper: Harness });

    await act(async () => {
      await result.current.mutateAsync(arg).catch(() => {});
    });

    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["products"] });
  });
});
