/** @jest-environment jsdom */
/**
 * THE RECONCILIATION HOOKS (pack C4a.1) — `hooks/use-admin.ts`.
 *
 * The components are pinned against a MOCKED hook module, so these are the pins
 * that keep the mock honest: what the hooks actually ask the server for, and
 * what they hand back when it refuses.
 *
 *   1. ONE KEY NAMESPACE. Everything lives under `["admin","reconciliation",…]`
 *      so the mutation can invalidate the whole surface with one prefix — the
 *      report, the drill-down and the picker all move together after a write.
 *   2. AN EMPTY SEARCH ASKS NOTHING. `useOrderSearch("")` is disabled: an empty
 *      search is not a request for every order (the route says the same).
 *   3. THE REFUSAL SURVIVES THE PARSE. `code` and `currentOrderRecordId` are
 *      what the confirm panel needs to render a 409 verbatim and to know the
 *      batch moved; a plain `Error(message)` would throw both away.
 */

import * as React from "react";
import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "csrf-token", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (headers: Record<string, string>, token: string | null) => ({
    ...headers,
    ...(token ? { "x-csrf-token": token } : {}),
  }),
}));

import {
  useAttributionReport,
  useBatchDetail,
  useOrderSearch,
  useAttributeBatch,
} from "@/hooks/use-admin";

const mockFetch = jest.fn();

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  }
  return { client, Wrapper };
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = mockFetch as unknown as typeof fetch;
});

describe("useAttributionReport", () => {
  it("asks for the window, the class, the order number and the cursor, under one key", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ rows: [] }) });
    const { Wrapper } = harness();

    const { result } = renderHook(
      () =>
        useAttributionReport({
          from: "2026-08-11",
          to: "2026-08-24",
          classKey: "attributed·manual",
          orderNumber: "1009",
          limit: 50,
          cursor: "cur",
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.data).toEqual({ rows: [] }));
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/api/reconciliation/attribution?");
    expect(url).toContain("from=2026-08-11");
    expect(url).toContain("to=2026-08-24");
    expect(url).toContain(`class=${encodeURIComponent("attributed·manual")}`);
    expect(url).toContain("orderNumber=1009");
    expect(url).toContain("limit=50");
    expect(url).toContain("cursor=cur");
    expect(mockFetch.mock.calls[0][1]).toEqual({ signal: expect.any(AbortSignal) });
  });

  it("omits the optional filters it was not given", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ rows: [] }) });
    const { Wrapper } = harness();

    const { result } = renderHook(
      () => useAttributionReport({ from: "2026-08-11", to: "2026-08-24" }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.data).toEqual({ rows: [] }));
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).not.toContain("class=");
    expect(url).not.toContain("orderNumber=");
    expect(url).not.toContain("cursor=");
  });

  // QA-5: a date input the operator cleared holds "", which the route answers
  // with a 400 — a request nobody made, and an error card over a screen the
  // operator is still in the middle of filling in.
  it("an EMPTY date asks nothing — a half-typed window is not a request (QA-5)", () => {
    const { Wrapper } = harness();

    renderHook(() => useAttributionReport({ from: "", to: "2026-08-24" }), { wrapper: Wrapper });
    renderHook(() => useAttributionReport({ from: "2026-08-11", to: "" }), { wrapper: Wrapper });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

/**
 * QA-5 — WHAT A FAILED READ CARRIES. A 4xx is the server telling the operator
 * what is wrong with the request they made; the tabs render that sentence
 * verbatim, so the hook has to keep it. A 5xx says nothing an operator can act
 * on and carries no sentence at all.
 */
describe("the read helper's error shape (QA-5)", () => {
  it("keeps the server's 4xx sentence beside the status", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid cursor", code: "VALIDATION_ERROR" }),
    });
    const { Wrapper } = harness();

    const { result } = renderHook(
      () => useAttributionReport({ from: "2026-08-11", to: "2026-08-24" }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toMatchObject({ status: 400, serverMessage: "invalid cursor" });
  });

  it("a body-less failure carries a status and NO server sentence", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    const { Wrapper } = harness();

    const { result } = renderHook(
      () => useAttributionReport({ from: "2026-08-11", to: "2026-08-24" }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toMatchObject({ status: 500 });
    expect(result.current.error?.serverMessage).toBeUndefined();
  });
});

describe("useBatchDetail / useOrderSearch", () => {
  it("a null batch id asks nothing", () => {
    const { Wrapper } = harness();
    renderHook(() => useBatchDetail(null), { wrapper: Wrapper });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("a batch id reads the drill-down route", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ batch: {} }) });
    const { Wrapper } = harness();

    const { result } = renderHook(() => useBatchDetail("batch 1"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.data).toEqual({ batch: {} }));
    expect(mockFetch.mock.calls[0][0]).toBe("/api/reconciliation/attribution/batch%201");
  });

  it("an empty search asks nothing; one character asks", async () => {
    const { Wrapper } = harness();
    renderHook(() => useOrderSearch(""), { wrapper: Wrapper });
    expect(mockFetch).not.toHaveBeenCalled();

    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ orders: [], moreCount: 0 }) });
    const { result } = renderHook(() => useOrderSearch("1"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.data).toEqual({ orders: [], moreCount: 0 }));
    expect(mockFetch.mock.calls[0][0]).toBe("/api/reconciliation/orders/search?q=1");
  });
});

describe("useAttributeBatch", () => {
  it("posts the body with the CSRF header and invalidates the whole surface", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        changed: true,
        orderRecordId: "ord-2",
        previousOrderRecordId: null,
        rowCount: 2,
        completedFulfillment: false,
      }),
    });
    const { client, Wrapper } = harness();
    const invalidate = jest.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useAttributeBatch("batch-1"), { wrapper: Wrapper });
    await result.current.mutateAsync({
      orderRecordId: "ord-2",
      expectPreviousOrderRecordId: null,
    });

    expect(mockFetch).toHaveBeenCalledWith("/api/reconciliation/attribution/batch-1", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-csrf-token": "csrf-token" },
      body: JSON.stringify({ orderRecordId: "ord-2", expectPreviousOrderRecordId: null }),
    });
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "reconciliation"] }),
    );
  });

  it("keeps the refusal's code, its message and the id the batch moved to", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: "Someone attributed this batch while you were looking (now ord-7) — refresh and try again",
        code: "BATCH_MOVED",
        currentOrderRecordId: "ord-7",
        expected: "ord-1",
      }),
    });
    const { Wrapper } = harness();

    const { result } = renderHook(() => useAttributeBatch("batch-1"), { wrapper: Wrapper });

    await expect(
      result.current.mutateAsync({ orderRecordId: "ord-2", expectPreviousOrderRecordId: "ord-1" }),
    ).rejects.toMatchObject({
      code: "BATCH_MOVED",
      status: 409,
      currentOrderRecordId: "ord-7",
      message:
        "Someone attributed this batch while you were looking (now ord-7) — refresh and try again",
    });
  });

  it("invalidates even when the write was refused (the report is what refreshes)", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "the batch moved (updated 1 of 2 rows)", code: "CONFLICT" }),
    });
    const { client, Wrapper } = harness();
    const invalidate = jest.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useAttributeBatch("batch-1"), { wrapper: Wrapper });
    await expect(
      result.current.mutateAsync({ orderRecordId: "ord-2", expectPreviousOrderRecordId: null }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["admin", "reconciliation"] }),
    );
  });
});
