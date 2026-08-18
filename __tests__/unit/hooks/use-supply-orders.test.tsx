/** @jest-environment jsdom */
/**
 * `hooks/use-supply-orders.ts` — the supply-order client surface (contract pack
 * C4a.1, seams S22/S23).
 *
 * Four things this file exists to hold still:
 *
 *   1. THE BOOKING KEY. One active key per line, minted once and REUSED for
 *      every attempt whose outcome left the server's answer unknown (no
 *      response, 5xx, 409 CEILING|CONFLICT). Anything else RETIRES it — a 2xx
 *      (replay included), an IDEMPOTENCY_MISMATCH (which re-mints IMMEDIATELY,
 *      so the next click cannot resend the key the server already refused), and
 *      every other 4xx. A key kept after a settled answer is how one labeled
 *      batch turns into two, or how a corrected quantity gets swallowed by a
 *      replay of the wrong one.
 *   2. STORAGE IS NEVER LOAD-BEARING. Every read/write is inside the mutation
 *      function in a try/catch with an in-memory fallback: a browser that
 *      refuses sessionStorage must still book stock.
 *   3. ONE INVALIDATION SET. Every mutation refreshes the same three families
 *      (orders, labeling queue, inventory) — a stock-in that moved units and
 *      only refreshed receiving is how /inventory starts disagreeing with it.
 *   4. NO SILENT RETRIES. `retry: false` on every business mutation: the 409s
 *      in this lane are claims, and re-firing them behind the operator's back
 *      is exactly the stale-tab bug the envelopes were designed to surface.
 */

import fs from "fs";
import path from "path";
import React, { type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({
    token: "csrf-token",
    isLoading: false,
    error: null,
    refreshToken: jest.fn(),
  }),
  withCSRFHeaders: (headers: Record<string, string>) => ({
    ...headers,
    "x-csrf-token": "csrf-token",
  }),
}));

import { shipmentKeys, ShipmentApiError, readShipmentError } from "@/hooks/use-inbound-shipments";
import { labelingKeys } from "@/hooks/use-labeling-keys";
import {
  BOOKING_ATTEMPT_STORAGE_PREFIX,
  SUPPLY_ORDER_LIST_LIMIT,
  invalidateSupplyOrderCaches,
  useAddLine,
  useCreateSupplyOrder,
  useDiscardLine,
  useDiscardRemaining,
  usePatchLine,
  usePatchSupplyOrder,
  useResolveException,
  useStockIn,
  useSupplyOrder,
  useSupplyOrders,
  useVerifyLine,
  type DiscardRemainingResult,
  type ResolveExceptionResult,
  type StockInResult,
} from "@/hooks/use-supply-orders";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ORDER_ID = "cksupply000000000000000001";
const LINE_ID = 4242;

let queryClient: QueryClient;
let invalidateSpy: jest.SpyInstance;

function wrapper() {
  function Harness({ children }: { children: ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  }
  return Harness;
}

/** The keys every `invalidateQueries` call asked for, flattened for assertions. */
function invalidatedKeys(): string[] {
  return invalidateSpy.mock.calls.map((call) =>
    JSON.stringify((call[0] as { queryKey?: unknown[] })?.queryKey ?? []),
  );
}

const mockFetch = jest.fn();

/** A fake sessionStorage whose reads AND writes can be made to throw. */
class FakeStorage {
  map = new Map<string, string>();
  throwOnWrite = false;
  throwOnRead = false;

  getItem(key: string): string | null {
    if (this.throwOnRead) throw new Error("SecurityError: storage is not available");
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    if (this.throwOnWrite) throw new Error("QuotaExceededError");
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    if (this.throwOnWrite) throw new Error("QuotaExceededError");
    this.map.delete(key);
  }
}

let storage: FakeStorage;
let mintedUuids: number;

function attemptRecord(line: number): { attempt: number; key: string } | null {
  const raw = storage.map.get(`${BOOKING_ATTEMPT_STORAGE_PREFIX}${line}`);
  return raw ? JSON.parse(raw) : null;
}

/** `{ ok, status, json }` — the shape the hooks read, nothing more. */
function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");
  global.fetch = mockFetch as unknown as typeof fetch;

  storage = new FakeStorage();
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    get: () => storage,
  });

  mintedUuids = 0;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      randomUUID: () => `booking-key-${++mintedUuids}`,
    },
  });
});

// ---------------------------------------------------------------------------
// The shared base (S23)
// ---------------------------------------------------------------------------

describe("the shared base — shipmentKeys.list(filter) / ShipmentApiError / readShipmentError", () => {
  it("serializes the filter CANONICALLY: statuses sorted + joined, model defaulted to 'all'", () => {
    expect(shipmentKeys.list({ statuses: ["RECEIVING", "ORDERED"] })).toEqual([
      "inbound-shipments",
      "list",
      "ORDERED,RECEIVING",
      "all",
    ]);
    // The same set in the other order is the SAME cache entry.
    expect(shipmentKeys.list({ statuses: ["ORDERED", "RECEIVING"] })).toEqual(
      shipmentKeys.list({ statuses: ["RECEIVING", "ORDERED"] }),
    );
    expect(shipmentKeys.list({ statuses: ["OPEN"], model: "legacy" })).toEqual([
      "inbound-shipments",
      "list",
      "OPEN",
      "legacy",
    ]);
    // An absent status set is the server's default set — a stable empty tail.
    expect(shipmentKeys.list({})).toEqual(["inbound-shipments", "list", "", "all"]);
  });

  it("the client's page bound MIRRORS the server's, and cannot drift from it", () => {
    // The UI cannot IMPORT `SUPPLY_ORDER_LIST_LIMIT` — `lib/supply-orders/queries`
    // holds Prisma at runtime — so the constant is hand-declared and the two are
    // pinned to each other by reading the source, the same way the locations
    // key-ownership pin does. A list that thinks the bound is 100 while the
    // server sends 200 stops saying it was cut.
    const server = fs.readFileSync(
      path.join(process.cwd(), "lib", "supply-orders", "queries.ts"),
      "utf8",
    );
    const declared = /export const SUPPLY_ORDER_LIST_LIMIT = (\d+);/.exec(server);
    expect(declared).not.toBeNull();
    expect(SUPPLY_ORDER_LIST_LIMIT).toBe(Number((declared as RegExpExecArray)[1]));
  });

  it("keeps the WHOLE parsed body on the error as `details`, with the W1 compatibility getters", () => {
    const err = readShipmentError(
      jsonResponse(409, {
        error: "The order still has unverified lines (7, 9)",
        code: "UNVERIFIED",
        lineIds: [7, 9],
        uncountedItemIds: [3],
      }),
      {
        error: "The order still has unverified lines (7, 9)",
        code: "UNVERIFIED",
        lineIds: [7, 9],
        uncountedItemIds: [3],
      },
      "fallback",
    );

    expect(err).toBeInstanceOf(ShipmentApiError);
    expect(err.message).toBe("The order still has unverified lines (7, 9)");
    expect(err.status).toBe(409);
    expect(err.code).toBe("UNVERIFIED");
    // The structured refusal survives WHOLE — a 409 that names lines must not
    // be flattened to "conflict" on the way to the screen.
    expect(err.details).toEqual({
      error: "The order still has unverified lines (7, 9)",
      code: "UNVERIFIED",
      lineIds: [7, 9],
      uncountedItemIds: [3],
    });
    expect(err.uncountedItemIds).toEqual([3]);
    expect(err.graduatedItemIds).toBeUndefined();
  });

  it("falls back to the supplied message when the server sent no `error` string", () => {
    const err = readShipmentError(jsonResponse(500, {}), {}, "Failed to stock in the batch");
    expect(err.message).toBe("Failed to stock in the batch");
    expect(err.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("reads", () => {
  it("useSupplyOrders sends the multi-status filter and unwraps `{ shipments }`", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, { shipments: [{ model: "supply-order", id: ORDER_ID }] }),
    );

    const { result } = renderHook(
      () => useSupplyOrders({ statuses: ["ORDERED", "RECEIVING"] }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/inbound-shipments?status=ORDERED%2CRECEIVING",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("useSupplyOrders sends `model` when the filter names one", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { shipments: [] }));

    const { result } = renderHook(
      () => useSupplyOrders({ statuses: ["OPEN"], model: "legacy" }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(String(mockFetch.mock.calls[0][0])).toBe(
      "/api/inbound-shipments?status=OPEN&model=legacy",
    );
    // An empty list is a real answer; a FAILED read is not (W25-3).
    expect(result.current.data).toEqual([]);
  });

  it("useSupplyOrder reads the detail under the detail key and is disabled without an id", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { model: "supply-order", id: ORDER_ID }));

    const { result } = renderHook(() => useSupplyOrder(null), { wrapper: wrapper() });
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockFetch).not.toHaveBeenCalled();

    const live = renderHook(() => useSupplyOrder(ORDER_ID), { wrapper: wrapper() });
    await waitFor(() => expect(live.result.current.isSuccess).toBe(true));
    expect(String(mockFetch.mock.calls[0][0])).toBe(`/api/inbound-shipments/${ORDER_ID}`);
    expect(queryClient.getQueryData(shipmentKeys.detail(ORDER_ID))).toBeDefined();
  });

  it("a failed read throws the server's message rather than resolving to an empty list", async () => {
    mockFetch.mockResolvedValue(jsonResponse(500, { error: "boom" }));

    const { result } = renderHook(() => useSupplyOrders({ statuses: ["ORDERED"] }), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(result.current.error?.message).toBe("boom");
  });
});

// ---------------------------------------------------------------------------
// Mutations — wire shapes + the shared invalidation
// ---------------------------------------------------------------------------

describe("mutations", () => {
  it("useCreateSupplyOrder POSTs the body with CSRF and returns the created detail", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(201, { model: "supply-order", id: ORDER_ID, lines: [] }),
    );

    const { result } = renderHook(() => useCreateSupplyOrder(), { wrapper: wrapper() });
    const created = await result.current.mutateAsync({
      supplier: "Acme",
      orderedAt: "2026-08-18",
      feesCents: 0,
      lines: [
        {
          product: { mode: "existing", productId: 12 },
          orderedQuantity: 10,
          lineTotalCents: 10001,
          labelingRequired: true,
        },
      ],
    });

    expect(created).toEqual({ model: "supply-order", id: ORDER_ID, lines: [] });
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe("/api/inbound-shipments");
    expect(init.method).toBe("POST");
    expect(init.headers["x-csrf-token"]).toBe("csrf-token");
    expect(JSON.parse(init.body).orderedAt).toBe("2026-08-18");
  });

  it("EVERY mutation refreshes the same THREE families — orders, labeling, inventory", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { id: LINE_ID }));

    const { result } = renderHook(() => usePatchSupplyOrder(ORDER_ID), { wrapper: wrapper() });
    await result.current.mutateAsync({ action: "close" });

    const keys = invalidatedKeys();
    expect(keys).toContain(JSON.stringify(shipmentKeys.all));
    expect(keys).toContain(JSON.stringify(labelingKeys.all));
    // The inventory family, via the house helper (one representative member).
    expect(keys).toContain(JSON.stringify(["inventory-logs"]));
    expect(keys).toContain(JSON.stringify(["products"]));
  });

  it("invalidateSupplyOrderCaches is the ONE implementation of that set", async () => {
    await invalidateSupplyOrderCaches(queryClient);
    const keys = invalidatedKeys();
    expect(keys).toContain(JSON.stringify(shipmentKeys.all));
    expect(keys).toContain(JSON.stringify(labelingKeys.all));
    expect(keys).toContain(JSON.stringify(["inventory-logs"]));
  });

  it("the caches are refreshed BEFORE a 409 rejection reaches the caller (C4b.4)", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(409, { error: "This order is already closed", code: "CONFLICT" }),
    );

    const { result } = renderHook(() => usePatchSupplyOrder(ORDER_ID), { wrapper: wrapper() });
    await expect(result.current.mutateAsync({ action: "cancel" })).rejects.toMatchObject({
      status: 409,
      message: "This order is already closed",
    });

    expect(invalidatedKeys()).toContain(JSON.stringify(shipmentKeys.all));
  });

  it("no business mutation retries itself, even when the client defaults say retry", async () => {
    // The house default is what a stale-tab 409 must NOT meet: re-firing a claim
    // behind the operator's back is how one refusal becomes several writes.
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: 5, retryDelay: 0 },
      },
    });
    invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");

    const cases: Array<[string, () => { mutateAsync: (vars: never) => Promise<unknown> }, unknown]> =
      [
        ["create", () => useCreateSupplyOrder(), { orderedAt: "2026-08-18", lines: [] }],
        ["patch", () => usePatchSupplyOrder(ORDER_ID), { action: "close" }],
        ["addLine", () => useAddLine(ORDER_ID), { verifiedQuantity: 1 }],
        ["patchLine", () => usePatchLine(ORDER_ID), { lineId: LINE_ID, body: {} }],
        ["discardLine", () => useDiscardLine(ORDER_ID), { lineId: LINE_ID }],
        ["verify", () => useVerifyLine(ORDER_ID), { lineId: LINE_ID, body: {} }],
        ["stockIn", () => useStockIn(ORDER_ID), { lineId: LINE_ID, quantity: 1, locationId: 1 }],
        ["discardRemaining", () => useDiscardRemaining(ORDER_ID), { lineId: LINE_ID, reason: "x" }],
        [
          "resolve",
          () => useResolveException(ORDER_ID),
          { lineId: LINE_ID, exceptionKey: "k", resolution: "accepted-loss" },
        ],
      ];

    for (const [name, hook, vars] of cases) {
      mockFetch.mockClear();
      mockFetch.mockResolvedValue(jsonResponse(409, { error: "stale", code: "CONFLICT" }));
      const { result } = renderHook(hook, { wrapper: wrapper() });
      await expect(result.current.mutateAsync(vars as never)).rejects.toBeTruthy();
      expect([name, mockFetch.mock.calls.length]).toEqual([name, 1]);
    }
  });

  it("useAddLine / usePatchLine / useDiscardLine hit the M3a line routes", async () => {
    mockFetch.mockResolvedValue(jsonResponse(201, { id: LINE_ID }));
    const add = renderHook(() => useAddLine(ORDER_ID), { wrapper: wrapper() });
    await add.result.current.mutateAsync({
      product: { mode: "existing", productId: 3 },
      verifiedQuantity: 5,
    });
    expect(String(mockFetch.mock.calls[0][0])).toBe(
      `/api/inbound-shipments/${ORDER_ID}/lines`,
    );

    mockFetch.mockResolvedValue(jsonResponse(200, { id: LINE_ID }));
    const patch = renderHook(() => usePatchLine(ORDER_ID), { wrapper: wrapper() });
    await patch.result.current.mutateAsync({ lineId: LINE_ID, body: { orderedQuantity: 4 } });
    expect(String(mockFetch.mock.calls[1][0])).toBe(
      `/api/inbound-shipments/${ORDER_ID}/lines/${LINE_ID}`,
    );
    expect(mockFetch.mock.calls[1][1].method).toBe("PATCH");

    mockFetch.mockResolvedValue(
      jsonResponse(200, { id: LINE_ID, shipmentId: ORDER_ID, status: "DISCARDED", reason: "x" }),
    );
    const discard = renderHook(() => useDiscardLine(ORDER_ID), { wrapper: wrapper() });
    await discard.result.current.mutateAsync({ lineId: LINE_ID, reason: "x" });
    expect(String(mockFetch.mock.calls[2][0])).toBe(
      `/api/inbound-shipments/${ORDER_ID}/lines/${LINE_ID}/discard`,
    );
  });

  it("useVerifyLine / useDiscardRemaining / useResolveException hit the M3b routes", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { lineId: LINE_ID, line: { id: LINE_ID } }));
    const verify = renderHook(() => useVerifyLine(ORDER_ID), { wrapper: wrapper() });
    await verify.result.current.mutateAsync({ lineId: LINE_ID, body: { verifiedQuantity: 0 } });
    expect(String(mockFetch.mock.calls[0][0])).toBe(
      `/api/inbound-shipments/${ORDER_ID}/lines/${LINE_ID}/verify`,
    );
    // A verified count of ZERO is a fact about the dock and must survive JSON.
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).verifiedQuantity).toBe(0);

    mockFetch.mockResolvedValue(
      jsonResponse(200, { lineId: LINE_ID, status: "COMPLETE", line: { id: LINE_ID } }),
    );
    const discard = renderHook(() => useDiscardRemaining(ORDER_ID), { wrapper: wrapper() });
    // THE ROUTE'S ANSWER, WHOLE (QA-7). Discard-remaining re-reads the line and
    // returns it beside the booking result exactly as stock-in and resolve do;
    // a hook typed as the primitive's result alone is a bench that cannot see
    // the row it just finished.
    const written: DiscardRemainingResult = await discard.result.current.mutateAsync({
      lineId: LINE_ID,
      reason: "dropped",
    });
    expect(written.line).toEqual({ id: LINE_ID });
    expect(String(mockFetch.mock.calls[1][0])).toBe(
      `/api/inbound-shipments/${ORDER_ID}/lines/${LINE_ID}/discard-remaining`,
    );

    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        key: `recv-discrepancy:${LINE_ID}`,
        resolution: "accepted-loss",
        lineId: LINE_ID,
        exception: null,
        line: { id: LINE_ID },
      }),
    );
    const resolve = renderHook(() => useResolveException(ORDER_ID), { wrapper: wrapper() });
    // THE ROUTE'S ANSWER, WHOLE (seam S-B). A settlement hands back the
    // refreshed line beside the exception row, and a hook typed as the row
    // alone is a screen that cannot see what it just changed.
    const settled: ResolveExceptionResult = await resolve.result.current.mutateAsync({
      lineId: LINE_ID,
      exceptionKey: `recv-discrepancy:${LINE_ID}`,
      resolution: "accepted-loss",
    });
    expect(settled).toEqual({
      key: `recv-discrepancy:${LINE_ID}`,
      resolution: "accepted-loss",
      lineId: LINE_ID,
      exception: null,
      line: { id: LINE_ID },
    });
    expect(String(mockFetch.mock.calls[2][0])).toBe(
      `/api/inbound-shipments/${ORDER_ID}/lines/${LINE_ID}/resolve`,
    );
    expect(JSON.parse(mockFetch.mock.calls[2][1].body)).toEqual({
      exceptionKey: `recv-discrepancy:${LINE_ID}`,
      resolution: "accepted-loss",
    });
  });
});

// ---------------------------------------------------------------------------
// The bookingKey discipline (S22 — the KEEP/RETIRE matrix)
// ---------------------------------------------------------------------------

describe("useStockIn — the bookingKey discipline", () => {
  // A FRESH line id per test: the in-memory fallback is module state by design
  // (it has to outlive a component), so tests must not share a line the way two
  // renders of the same screen deliberately do.
  let lineSeq = 0;
  let lineId = 0;

  beforeEach(() => {
    lineId = 90000 + ++lineSeq * 10;
  });

  function stockIn() {
    return renderHook(() => useStockIn(ORDER_ID), { wrapper: wrapper() });
  }

  const BOOKED = {
    lineId: lineId,
    status: "LABELING",
    stockedQuantity: 4,
    disposedQuantity: 0,
    remaining: 6,
    batch: {
      quantity: 4,
      locationId: 1,
      unitCostCents: 1000,
      receiptCostCents: 4000,
      replayed: false,
    },
    productId: 12,
    approvalStatus: "APPROVED",
    costPrompt: null,
  };

  it("MINTS ONCE and sends the key it minted", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { ...BOOKED, line: { id: lineId } }));

    const { result } = stockIn();
    // M3b's stock-in answers the booking PLUS the refreshed line (seam S-B);
    // `line` is nullable because the refresh read can find no supply order.
    const booked: StockInResult = await result.current.mutateAsync({
      lineId: lineId,
      quantity: 4,
      locationId: 1,
    });
    expect(booked.line).toEqual({ id: lineId });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({ bookingKey: "booking-key-1", quantity: 4, locationId: 1 });
    expect(mintedUuids).toBe(1);
  });

  it("MINTS A V4 KEY where `crypto.randomUUID` does not exist (QA-2)", async () => {
    // Every non-secure-context page and a long tail of embedded webviews expose
    // a Web Crypto object WITHOUT `randomUUID`. The old mint called it
    // unconditionally, so on those clients the first stock-in threw before it
    // ever reached the network — a bench that cannot book stock at all. The
    // server asserts `z.string().uuid()`, so the fallback has to produce one.
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        getRandomValues: (bytes: Uint8Array) => {
          for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37 + 11) % 256;
          return bytes;
        },
      },
    });

    mockFetch.mockResolvedValueOnce(jsonResponse(200, BOOKED));
    const { result } = stockIn();
    await result.current.mutateAsync({ lineId: lineId, quantity: 4, locationId: 1 });

    const sent = JSON.parse(mockFetch.mock.calls[0][1].body).bookingKey;
    expect(sent).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    // The booking landed, and the settled key was retired like any other.
    expect(attemptRecord(lineId)).toBeNull();
  });

  it("KEEPS the key across a 5xx, a network failure, a 409 CEILING and a 409 CONFLICT", async () => {
    const { result } = stockIn();

    // 5xx — the server may or may not have booked it.
    mockFetch.mockResolvedValueOnce(jsonResponse(503, { error: "upstream down" }));
    await expect(
      result.current.mutateAsync({ lineId: lineId, quantity: 4, locationId: 1 }),
    ).rejects.toBeInstanceOf(ShipmentApiError);
    expect(attemptRecord(lineId)).toEqual({ attempt: 1, key: "booking-key-1" });

    // No response at all.
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(
      result.current.mutateAsync({ lineId: lineId, quantity: 4, locationId: 1 }),
    ).rejects.toBeTruthy();
    expect(attemptRecord(lineId)).toEqual({ attempt: 1, key: "booking-key-1" });

    // 409 CEILING — a real refusal, but the attempt itself is unsettled.
    mockFetch.mockResolvedValueOnce(
      jsonResponse(409, {
        error: "Only 2 unit(s) remain on this line",
        code: "CEILING",
        stocked: 6,
        disposed: 2,
        verified: 10,
        requested: 4,
      }),
    );
    await expect(
      result.current.mutateAsync({ lineId: lineId, quantity: 4, locationId: 1 }),
    ).rejects.toMatchObject({ code: "CEILING" });
    expect(attemptRecord(lineId)).toEqual({ attempt: 1, key: "booking-key-1" });

    // 409 CONFLICT — a claim lost; same reasoning.
    mockFetch.mockResolvedValueOnce(
      jsonResponse(409, { error: "another writer moved this line", code: "CONFLICT" }),
    );
    await expect(
      result.current.mutateAsync({ lineId: lineId, quantity: 4, locationId: 1 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(attemptRecord(lineId)).toEqual({ attempt: 1, key: "booking-key-1" });

    // Four attempts, ONE key on the wire every time.
    const keysSent = mockFetch.mock.calls
      .filter((call) => call[1]?.body)
      .map((call) => JSON.parse(call[1].body).bookingKey);
    expect(keysSent).toEqual([
      "booking-key-1",
      "booking-key-1",
      "booking-key-1",
      "booking-key-1",
    ]);
    expect(mintedUuids).toBe(1);
  });

  it("RETIRES the key on a 2xx — and on a REPLAYED 2xx just the same", async () => {
    const { result } = stockIn();

    mockFetch.mockResolvedValueOnce(jsonResponse(200, BOOKED));
    await result.current.mutateAsync({ lineId: lineId, quantity: 4, locationId: 1 });
    expect(attemptRecord(lineId)).toBeNull();

    // The next booking mints a FRESH key rather than replaying the settled one.
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { ...BOOKED, batch: { ...BOOKED.batch, replayed: true } }),
    );
    const replayed = await result.current.mutateAsync({
      lineId: lineId,
      quantity: 4,
      locationId: 1,
    });
    expect(replayed.batch.replayed).toBe(true);
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).bookingKey).toBe("booking-key-2");
    // A replay is a settled answer too.
    expect(attemptRecord(lineId)).toBeNull();
  });

  it("RETIRES and IMMEDIATELY RE-MINTS on 409 IDEMPOTENCY_MISMATCH", async () => {
    const { result } = stockIn();

    mockFetch.mockResolvedValueOnce(
      jsonResponse(409, {
        error: "this booking key was used with different numbers",
        code: "IDEMPOTENCY_MISMATCH",
      }),
    );
    await expect(
      result.current.mutateAsync({ lineId: lineId, quantity: 5, locationId: 1 }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });

    // The refused key is GONE and a successor is already persisted, so the next
    // click cannot resend the key the server just rejected.
    expect(attemptRecord(lineId)).toEqual({ attempt: 2, key: "booking-key-2" });

    mockFetch.mockResolvedValueOnce(jsonResponse(200, BOOKED));
    await result.current.mutateAsync({ lineId: lineId, quantity: 4, locationId: 1 });
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).bookingKey).toBe("booking-key-2");
  });

  it("RETIRES the key on NOT_BOOKABLE, on VERIFIED_LOCKED and on a plain 400", async () => {
    const { result } = stockIn();

    for (const [status, code] of [
      [409, "NOT_BOOKABLE"],
      [409, "VERIFIED_LOCKED"],
      [400, "VALIDATION_ERROR"],
    ] as const) {
      storage.map.clear();
      mockFetch.mockResolvedValueOnce(jsonResponse(status, { error: "refused", code }));
      await expect(
        result.current.mutateAsync({ lineId: lineId, quantity: 4, locationId: 1 }),
      ).rejects.toMatchObject({ code });
      expect(attemptRecord(lineId)).toBeNull();
    }
  });

  it("books anyway when sessionStorage THROWS — the in-memory fallback carries the key", async () => {
    storage.throwOnWrite = true;
    storage.throwOnRead = true;
    const { result } = stockIn();

    mockFetch.mockResolvedValueOnce(jsonResponse(502, { error: "bad gateway" }));
    await expect(
      result.current.mutateAsync({ lineId: lineId, quantity: 4, locationId: 1 }),
    ).rejects.toBeInstanceOf(ShipmentApiError);

    // Nothing reached storage, and the retry still reuses the SAME key.
    expect(storage.map.size).toBe(0);
    mockFetch.mockResolvedValueOnce(jsonResponse(200, BOOKED));
    await result.current.mutateAsync({ lineId: lineId, quantity: 4, locationId: 1 });

    const keysSent = mockFetch.mock.calls.map((call) => JSON.parse(call[1].body).bookingKey);
    expect(keysSent).toEqual(["booking-key-1", "booking-key-1"]);
  });

  it("keeps one active record PER LINE", async () => {
    const { result } = stockIn();

    mockFetch.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));
    await expect(
      result.current.mutateAsync({ lineId: lineId, quantity: 4, locationId: 1 }),
    ).rejects.toBeTruthy();
    mockFetch.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));
    await expect(
      result.current.mutateAsync({ lineId: lineId + 1, quantity: 2, locationId: 1 }),
    ).rejects.toBeTruthy();

    expect(storage.map.get(`${BOOKING_ATTEMPT_STORAGE_PREFIX}${lineId}`)).toBe(
      JSON.stringify({ attempt: 1, key: "booking-key-1" }),
    );
    expect(storage.map.get(`${BOOKING_ATTEMPT_STORAGE_PREFIX}${lineId + 1}`)).toBe(
      JSON.stringify({ attempt: 1, key: "booking-key-2" }),
    );
  });

  it("survives a RELOAD: an unsettled key persisted in sessionStorage is reused", async () => {
    storage.map.set(
      `${BOOKING_ATTEMPT_STORAGE_PREFIX}${lineId}`,
      JSON.stringify({ attempt: 3, key: "key-from-a-previous-page-load" }),
    );

    const { result } = stockIn();
    mockFetch.mockResolvedValueOnce(jsonResponse(200, BOOKED));
    await result.current.mutateAsync({ lineId: lineId, quantity: 4, locationId: 1 });

    expect(JSON.parse(mockFetch.mock.calls[0][1].body).bookingKey).toBe(
      "key-from-a-previous-page-load",
    );
    expect(mintedUuids).toBe(0);
  });

  it("a successful booking refreshes all three families", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, BOOKED));
    const { result } = stockIn();
    await result.current.mutateAsync({ lineId: lineId, quantity: 4, locationId: 1 });

    const keys = invalidatedKeys();
    expect(keys).toContain(JSON.stringify(shipmentKeys.all));
    expect(keys).toContain(JSON.stringify(labelingKeys.all));
    expect(keys).toContain(JSON.stringify(["inventory-logs"]));
  });
});
