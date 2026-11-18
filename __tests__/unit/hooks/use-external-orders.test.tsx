/** @jest-environment jsdom */
//
// Facelift F1-17 (plan 2026-11-18-facelift-f1; F0 GR-10 note, G1-14) —
// `useExternalOrders` gains `{ debounceSearch = true }`.
//
// The Orders page debounces its own search, so it can reset its page size in
// the same render the debounced value changes; it passes that value with
// `debounceSearch: false`, and the hook must read it AS GIVEN — a second 300 ms
// inside the hook would put the reset and the search in different renders
// again. Every other caller (the workbench's order selector) keeps the hook's
// own debounce, unchanged.

import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";

import { useExternalOrders } from "@/hooks/use-external-orders";
import type { ExternalOrderFilters } from "@/types/external-orders";

let fetchMock: jest.Mock;
beforeEach(() => {
  fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ orders: [], total: 0, page: 1, pageSize: 10, hasMore: false }),
  })) as unknown as jest.Mock;
  global.fetch = fetchMock as unknown as typeof fetch;
});

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

const searches = () =>
  fetchMock.mock.calls.map(([u]) => new URL(String(u), "http://x").searchParams.get("search"));

function renderOrders(options?: { debounceSearch?: boolean }) {
  return renderHook(
    ({ filters }: { filters: ExternalOrderFilters }) => useExternalOrders(filters, options),
    { wrapper, initialProps: { filters: { search: "", pageSize: 10 } } },
  );
}

describe("F1-17 — useExternalOrders' `debounceSearch` option", () => {
  it("`debounceSearch: false`: a new search is read as given — its request goes out at once", async () => {
    const { rerender } = renderOrders({ debounceSearch: false });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ filters: { search: "9001", pageSize: 10 } });
    await act(async () => {});
    expect(searches()).toContain("9001");
  });

  it("the default (the workbench's call, unchanged): the hook still debounces 300 ms", async () => {
    const { rerender } = renderOrders();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ filters: { search: "9001", pageSize: 10 } });
    await act(async () => {});
    expect(searches()).not.toContain("9001");
    await waitFor(() => expect(searches()).toContain("9001"));
  });
});
