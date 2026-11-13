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
  useMoveBatch,
} from "@/hooks/use-admin";
// Part 2 B3-1b: the transport and the search MOVED to leaf modules; these type
// imports from `use-admin` are themselves a pin — they stop compiling if the
// re-exports go.
import type { ApiError, OrderSearchResponse, OrderSearchResult } from "@/hooks/use-admin";
import { useOrderSearch as leafUseOrderSearch } from "@/hooks/use-order-search";

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

// ---------------------------------------------------------------------------
// CB2.5e.4 (amended B25-FR1/F2) — the drill-down's move caller has no OUTCOME.
//
// The rule is not "was it a timeout": it is "did an answer arrive". Every
// rejected fetch is unanswered (TIMEOUT for the abort we asked for, UNANSWERED
// for everything else), and a `!ok` response is a REFUSAL only when it parsed
// into the house `{ error, code }` envelope.
// ---------------------------------------------------------------------------

describe("useMoveBatch — no answer means no outcome", () => {
  const UNANSWERED_SENTENCE = "The move did not answer — check the batch before trying again";

  it("posts with an abort signal", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ pairs: [] }) });
    const { Wrapper } = harness();
    const { result } = renderHook(() => useMoveBatch("batch-1"), { wrapper: Wrapper });

    await result.current.mutateAsync({ physicalLocationId: 2 });

    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  // A mocked fetch never reads the signal, so the abort is staged as the
  // rejection `AbortSignal.timeout` actually produces: a TimeoutError
  // DOMException. The hook maps it to the SAME `{ error, code }` shape the
  // workbench's raw-fetch caller rejects with, so the one shared dialog reads
  // one refusal shape.
  it("maps a TimeoutError abort to the frozen TIMEOUT envelope, and asks ONCE", async () => {
    mockFetch.mockRejectedValue(new DOMException("timeout", "TimeoutError"));
    const { Wrapper } = harness();
    const { result } = renderHook(() => useMoveBatch("batch-1"), { wrapper: Wrapper });

    await expect(result.current.mutateAsync({ physicalLocationId: 2 })).rejects.toEqual({
      error: UNANSWERED_SENTENCE,
      code: "TIMEOUT",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // B25-FR1/F2: a dead socket mid-response tells us as little as a timeout does.
  // It rejects with the SAME sentence under the UNANSWERED code — never a raw
  // TypeError the shared dialog would have to guess at.
  it("a REJECTED fetch is UNANSWERED, carrying the one sentence", async () => {
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const { Wrapper } = harness();
    const { result } = renderHook(() => useMoveBatch("batch-1"), { wrapper: Wrapper });

    await expect(result.current.mutateAsync({ physicalLocationId: 2 })).rejects.toEqual({
      error: UNANSWERED_SENTENCE,
      code: "UNANSWERED",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // The ingress 502/504 whose body is an HTML error page: `.json()` rejects, the
  // caller's `.catch(() => ({}))` hands over `{}` — no code, so it says NOTHING
  // about where the batch is and must not be read as a refusal.
  it("a code-less 502 is UNANSWERED, not a refusal", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new SyntaxError("Unexpected token <")),
    });
    const { Wrapper } = harness();
    const { result } = renderHook(() => useMoveBatch("batch-1"), { wrapper: Wrapper });

    await expect(result.current.mutateAsync({ physicalLocationId: 2 })).rejects.toEqual({
      error: UNANSWERED_SENTENCE,
      code: "UNANSWERED",
    });
  });

  // The contrast: 503 BUSY IS an answer (a definite rollback), so it keeps the
  // server's own mapping through `readReconciliationError`.
  it("a 503 BUSY is a REFUSAL — the server's own sentence and code", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: "Another writer holds this batch — try again", code: "BUSY" }),
    });
    const { Wrapper } = harness();
    const { result } = renderHook(() => useMoveBatch("batch-1"), { wrapper: Wrapper });

    await expect(result.current.mutateAsync({ physicalLocationId: 2 })).rejects.toEqual({
      error: "Another writer holds this batch — try again",
      code: "BUSY",
    });
  });

  it("a 409 still rejects with the SERVER's sentence and code", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "This batch was already reversed", code: "ALREADY_REVERSED" }),
    });
    const { Wrapper } = harness();
    const { result } = renderHook(() => useMoveBatch("batch-1"), { wrapper: Wrapper });

    await expect(result.current.mutateAsync({ physicalLocationId: 2 })).rejects.toEqual({
      error: "This batch was already reversed",
      code: "ALREADY_REVERSED",
    });
  });
});

// ---------------------------------------------------------------------------
// Part 2 B3-1b (pack § P2-B3-1) — the order search MOVED to
// `hooks/use-order-search.ts` and the transport to `hooks/get-json.ts`, so the
// adjust dialog's lookup can read through them without the admin module.
// `use-admin` re-exports the names; nothing about the hook may change: ONE key,
// ONE `enabled` rule, the AbortSignal forwarded, the same error shape.
// ---------------------------------------------------------------------------

describe("the moved order search — re-exported; the key re-cut in § P2-B3-1R (R-b.3)", () => {
  it("use-admin re-exports the SAME hook the leaf module defines", () => {
    expect(useOrderSearch).toBe(leafUseOrderSearch);
  });

  it("keys [admin, reconciliation, orders, q, productId ?? null, limit ?? 20], forwards the signal, and carries `note`", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [], moreCount: 0, note: "no order matching that number in your companies" }),
    });
    const { client, Wrapper } = harness();

    const { result } = renderHook(() => useOrderSearch("10 9"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      client
        .getQueryCache()
        .find({ queryKey: ["admin", "reconciliation", "orders", "10 9", null, 20], exact: true }),
    ).toBeDefined();
    // Absent options stay off the URL: the route's defaults are the key's `null` / `20`.
    expect(mockFetch.mock.calls[0][0]).toBe("/api/reconciliation/orders/search?q=10%209");
    expect((mockFetch.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    const data: OrderSearchResponse | undefined = result.current.data;
    expect(data?.note).toBe("no order matching that number in your companies");
  });

  it("a refusal keeps the status, the generic message and the server's sentence", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: "Too many requests", code: "RATE_LIMITED" }),
    });
    const { Wrapper } = harness();

    const { result } = renderHook(() => useOrderSearch("1"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    const error: ApiError | null = result.current.error;
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: "Request failed (429)",
      status: 429,
      serverMessage: "Too many requests",
    });
  });

  it("the row type is the seven-field projection plus the optional `thisProduct` (R-a.1)", () => {
    const row: OrderSearchResult = {
      id: "ord-1",
      orderNumber: "1001",
      platform: "WOOCOMMERCE",
      internalStatus: "pending",
      externalCreatedAt: null,
      itemCount: 3,
      store: "North Shop",
    };
    expect(Object.keys(row).sort()).toEqual(
      ["externalCreatedAt", "id", "internalStatus", "itemCount", "orderNumber", "platform", "store"],
    );
    const withProduct: OrderSearchResult = { ...row, thisProduct: { orderedUnits: 2, uncheckedLines: 0 } };
    expect(withProduct.thisProduct).toEqual({ orderedUnits: 2, uncheckedLines: 0 });
    const answer: OrderSearchResponse = { orders: [row], moreCount: 0, exactCount: 1 };
    expect(answer.exactCount).toBe(1);
  });

  it("a product and a page ride in the KEY and on the URL", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ orders: [], moreCount: 0, exactCount: 0 }) });
    const { client, Wrapper } = harness();

    const { result } = renderHook(() => useOrderSearch("1009", { productId: 42, limit: 5 }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockFetch.mock.calls[0][0]).toBe("/api/reconciliation/orders/search?q=1009&productId=42&limit=5");
    expect(
      client.getQueryCache().find({ queryKey: ["admin", "reconciliation", "orders", "1009", 42, 5], exact: true }),
    ).toBeDefined();
  });

  it("a product alone keys the default page (20) and leaves `limit` off the URL", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ orders: [], moreCount: 0, exactCount: 0 }) });
    const { client, Wrapper } = harness();

    const { result } = renderHook(() => useOrderSearch("1009", { productId: 42 }), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockFetch.mock.calls[0][0]).toBe("/api/reconciliation/orders/search?q=1009&productId=42");
    expect(
      client.getQueryCache().find({ queryKey: ["admin", "reconciliation", "orders", "1009", 42, 20], exact: true }),
    ).toBeDefined();
  });

  it("the same text for another product is ANOTHER query — never the first one's answer", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ orders: [], moreCount: 0, exactCount: 0 }) });
    const { Wrapper } = harness();

    function Both() {
      const a = useOrderSearch("1009", { productId: 42, limit: 5 });
      const b = useOrderSearch("1009", { productId: 43, limit: 5 });
      return { a, b };
    }
    const { result } = renderHook(() => Both(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.a.isSuccess && result.current.b.isSuccess).toBe(true));
    expect(mockFetch.mock.calls.map((call) => call[0]).sort()).toEqual([
      "/api/reconciliation/orders/search?q=1009&productId=42&limit=5",
      "/api/reconciliation/orders/search?q=1009&productId=43&limit=5",
    ]);
  });

  it("NO placeholderData (R-b.1): a new key has no data until ITS answer arrives", async () => {
    let answerSecond!: (value: unknown) => void;
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ orders: [], moreCount: 0, exactCount: 1 }) })
      .mockImplementationOnce(() => new Promise((resolve) => (answerSecond = resolve)));
    const { client, Wrapper } = harness();

    const { result, rerender } = renderHook(({ q }) => leafUseOrderSearch(q, { productId: 42, limit: 5 }), {
      wrapper: Wrapper,
      initialProps: { q: "1009" },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ q: "10091" });
    expect(result.current.status).toBe("pending");
    expect(result.current.data).toBeUndefined();
    expect(result.current.isPlaceholderData).toBe(false);
    const query = client
      .getQueryCache()
      .find({ queryKey: ["admin", "reconciliation", "orders", "10091", 42, 5], exact: true });
    expect((query?.options as { placeholderData?: unknown } | undefined)?.placeholderData).toBeUndefined();

    answerSecond({ ok: true, json: async () => ({ orders: [], moreCount: 0, exactCount: 0 }) });
    await waitFor(() => expect(result.current.data?.exactCount).toBe(0));
  });
});

// ---------------------------------------------------------------------------
// B3-1 FR1 (OC-4 / OC-5): the search's two options. A 429 is NOT retried — a
// retry spends the same limiter bucket that just refused it — while every
// other failure keeps the app's one retry (`lib/query-client.ts`). And an
// answer goes stale after 30 s, not the app's 5 min.
//
// The client here says `retry: false`, so a retry seen below is the HOOK's
// own; `retryDelay: 0` only spares the run the default one-second back-off.
// ---------------------------------------------------------------------------

describe("the order search's retry and freshness (B3-1 FR1)", () => {
  function retryHarness() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    function Wrapper({ children }: { children: ReactNode }) {
      return React.createElement(QueryClientProvider, { client }, children);
    }
    return { client, Wrapper };
  }

  it("a 429 is NOT retried: one request, then the error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: "Too many requests", code: "RATE_LIMITED" }),
    });
    const { Wrapper } = retryHarness();

    const { result } = renderHook(() => leafUseOrderSearch("1"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.current.error?.status).toBe(429);
  });

  it("a 500 is retried exactly ONCE, then the error", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const { Wrapper } = retryHarness();

    const { result } = renderHook(() => leafUseOrderSearch("1"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.current.error?.status).toBe(500);
  });

  it("the one retry recovers a transient failure", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ orders: [], moreCount: 0 }) });
    const { Wrapper } = retryHarness();

    const { result } = renderHook(() => leafUseOrderSearch("1"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("an answer is fresh for 30 s — the query carries staleTime 30_000", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ orders: [], moreCount: 0 }) });
    const { client, Wrapper } = retryHarness();

    const { result } = renderHook(() => leafUseOrderSearch("1"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const query = client
      .getQueryCache()
      .find({ queryKey: ["admin", "reconciliation", "orders", "1", null, 20], exact: true });
    expect((query?.options as { staleTime?: unknown } | undefined)?.staleTime).toBe(30_000);
  });
});
