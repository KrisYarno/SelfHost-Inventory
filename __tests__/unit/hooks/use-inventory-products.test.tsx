/** @jest-environment jsdom */
/**
 * use-inventory-products — the `refetch()` TRUTH contract (FDc-2 / FDd-3 / FDd-5).
 *
 * The boolean feeds the journal's 409 recovery: TRUE re-seeds a PERSISTED cart's
 * versions, so TRUE must mean "fresh rows actually arrived". Three pins:
 * a real refetch → true; a PAUSED (offline) query — react-query substitutes a
 * resolved promise and never fetches — → FALSE (the pin that catches the clause
 * being dropped: `status` stays "success" from the prior load either way); a
 * failing refetch → false.
 */
import * as React from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { useInventoryProducts } from "@/hooks/use-inventory-products";

const PRODUCTS = { products: [{ id: 1, name: "Widget" }] };
const INVENTORY = { inventory: [{ productId: 1, quantity: 5, version: 3 }] };

let fetchOk = true;
const fetchMock = jest.fn(async (url: unknown) => {
  const href = String(url);
  if (!fetchOk) return { ok: false, json: async () => ({}) } as unknown as Response;
  if (href.includes("/api/products")) {
    return { ok: true, json: async () => PRODUCTS } as unknown as Response;
  }
  return { ok: true, json: async () => INVENTORY } as unknown as Response;
});

let lastClient: QueryClient | null = null;
function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  lastClient = queryClient;
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return Wrapper;
}

beforeEach(() => {
  fetchOk = true;
  fetchMock.mockClear();
  global.fetch = fetchMock as unknown as typeof fetch;
  onlineManager.setOnline(true);
});

afterEach(async () => {
  // FDe-5: a PAUSED fetch is abandoned, not cancelled — going back online would
  // RESUME it against a discarded client and land a stray fetchMock call in a
  // later test. Cancel first, then restore the online state.
  await lastClient?.cancelQueries();
  lastClient?.clear();
  onlineManager.setOnline(true);
});

describe("useInventoryProducts refetch() — fresh-rows truth", () => {
  it("answers TRUE when a real refetch succeeded", async () => {
    const { result } = renderHook(() => useInventoryProducts({ locationId: 1 }), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());

    let answer: boolean | undefined;
    await act(async () => {
      answer = await result.current.refetch();
    });
    expect(answer).toBe(true);
  });

  it("answers FALSE for a PAUSED (offline) query that never fetched — the prior success must not count", async () => {
    const { result } = renderHook(() => useInventoryProducts({ locationId: 1 }), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const callsBefore = fetchMock.mock.calls.length;

    onlineManager.setOnline(false);
    let answer: boolean | undefined;
    await act(async () => {
      answer = await result.current.refetch();
    });

    // No request went out, the old data is still "success" — and the boolean
    // says so honestly. Without the dataUpdateCount clause this is the case
    // that silently re-seeded a cart from stale rows.
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect(answer).toBe(false);
  });

  it("answers FALSE when the refetch itself fails", async () => {
    const { result } = renderHook(() => useInventoryProducts({ locationId: 1 }), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());

    fetchOk = false;
    let answer: boolean | undefined;
    await act(async () => {
      answer = await result.current.refetch();
    });
    expect(answer).toBe(false);
  });
});
