/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { useInventoryVariants, groupByBaseName } from "@/hooks/use-inventory-variants";

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const page1 = {
  products: [
    {
      id: 1,
      name: "AOD 2mg",
      baseName: "AOD",
      variant: "2mg",
      combinedMinimum: 0,
      locations: [],
      totalQuantity: 5,
    },
  ],
  pagination: { page: 1, pageSize: 12, total: 13, totalPages: 2, hasMore: true },
};

beforeEach(() => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => page1 })) as unknown as typeof fetch;
});

test("builds the variants URL with page/pageSize and omits empty search", async () => {
  const { result } = renderHook(() => useInventoryVariants(""), { wrapper: makeWrapper() });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
  expect(url).toContain("/api/inventory/variants?");
  expect(url).toContain("page=1");
  expect(url).toContain("pageSize=12");
  expect(url).not.toContain("search=");
});

test("hasNextPage follows pagination.hasMore; select exposes products/total/pagesLoaded", async () => {
  const { result } = renderHook(() => useInventoryVariants(""), { wrapper: makeWrapper() });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.hasNextPage).toBe(true);
  expect(result.current.data?.products).toHaveLength(1);
  expect(result.current.data?.total).toBe(13);
  expect(result.current.data?.pagesLoaded).toBe(1);
});

test("passes an AbortSignal to fetch", async () => {
  const { result } = renderHook(() => useInventoryVariants(""), { wrapper: makeWrapper() });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  const init = (global.fetch as jest.Mock).mock.calls[0][1];
  expect(init?.signal).toBeInstanceOf(AbortSignal);
});

test("changing search triggers a fresh page-1 fetch with the new term", async () => {
  jest.useFakeTimers();
  const { result, rerender } = renderHook(({ s }) => useInventoryVariants(s), {
    wrapper: makeWrapper(),
    initialProps: { s: "" },
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(350);
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  rerender({ s: "alpha" });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(350);
  });
  await waitFor(() =>
    expect(
      (global.fetch as jest.Mock).mock.calls.some(
        (c) => String(c[0]).includes("search=alpha") && String(c[0]).includes("page=1"),
      ),
    ).toBe(true),
  );
  jest.useRealTimers();
});

test("groupByBaseName groups and sorts categories + variants", () => {
  const grouped = groupByBaseName([
    { id: 2, name: "B 5", baseName: "B", variant: "5mg", combinedMinimum: 0, locations: [], totalQuantity: 1 },
    { id: 1, name: "A 2", baseName: "A", variant: "2mg", combinedMinimum: 0, locations: [], totalQuantity: 1 },
    { id: 3, name: "A 1", baseName: "A", variant: "1mg", combinedMinimum: 0, locations: [], totalQuantity: 1 },
    { id: 4, name: "Solo", baseName: "", variant: null, combinedMinimum: 0, locations: [], totalQuantity: 1 },
  ]);
  expect(Object.keys(grouped)).toEqual(["A", "B", "Uncategorized"]);
  expect(grouped["A"].map((p) => p.variant)).toEqual(["1mg", "2mg"]);
});
