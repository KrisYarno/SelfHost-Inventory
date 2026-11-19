/** @jest-environment jsdom */
//
// Facelift FR3-4 (plan 2026-11-18-facelift-f1 REV 11; QA-3, the order-sheet
// half of the modal sweep's MS-1-7) — THE ORDER SHEET'S STOCK BADGE STATES ITS
// READ. Truthful data: a structurally-unknown number is never shown as 0.
//
// Before: a mapped line's badge read `In Stock: {stock ?? 0}` whatever the
// read's state, so while the stock read was in flight, and after it failed,
// every mapped line showed a RED `In Stock: 0` — a stock-out nobody measured.
// Now: no answer yet says `Reading stock…`; a failed read with no answer says
// `Couldn't read stock.`; an answer shows `In Stock: N` with its tones. A
// product missing from a SUCCESSFUL answer is still 0: no inventory row means
// no units there.

import * as React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { isAdmin: false } }, status: "authenticated" }),
}));
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), warning: jest.fn(), success: jest.fn(), message: jest.fn(), info: jest.fn() },
}));
jest.mock("@/hooks/use-orders", () => ({
  useFulfillmentValidation: jest.fn(() => ({})),
  useFulfillOrder: jest.fn(() => ({})),
}));
jest.mock("@/components/products/product-map-dialog", () => ({ ProductMapDialog: () => null }));
jest.mock("@/contexts/location-context", () => ({
  useLocation: () => ({
    locations: [{ id: 2, name: "Office" }],
    selectedLocation: { id: 2, name: "Office" },
    selectedLocationId: 2,
    isLoading: false,
    loadFailed: false,
    setSelectedLocationId: jest.fn(),
    retryLocations: jest.fn(),
  }),
}));

import { ExternalOrderDetailsSheet } from "@/components/orders/external-order-details-sheet";
import type { ExternalOrder } from "@/types/external-orders";

const READING = "Reading stock…";
const FAILED = "Couldn't read stock.";

/** One open, mapped line (product 501), 2 to fill. */
const ORDER = {
  id: "ord-1",
  companyId: "co-1",
  integrationId: "int-1",
  externalId: "9001",
  orderNumber: "9001",
  nativeStatus: "processing",
  internalStatus: "processing",
  total: 1,
  currency: "USD",
  customerName: "Ada",
  createdAt: new Date(),
  updatedAt: new Date(),
  items: [
    {
      id: "it-0",
      orderId: "ord-1",
      name: "Line",
      quantity: 2,
      fulfilledQty: 0,
      price: 1,
      isMapped: true,
      externalProductId: "p",
      productLink: { internalProductId: 501, internalProduct: { id: 501, name: "Widget" } },
    },
  ],
} as unknown as ExternalOrder;

/** How `/api/inventory/current-fast` answers: held, refused, or with these rows. */
type StockRead = { mode: "held" } | { mode: "failed" } | { mode: "ok"; inventory: Array<{ productId: number; quantity: number }> };
let stockRead: StockRead;
let releaseHeld: (() => void) | null;
let fetchMock: jest.Mock;
const stockReads = () =>
  fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/inventory/current-fast")).length;

beforeEach(() => {
  releaseHeld = null;
  fetchMock = jest.fn((url: unknown) => {
    if (String(url).startsWith("/api/inventory/current-fast")) {
      const read = stockRead;
      if (read.mode === "held") {
        return new Promise<Response>((resolve) => {
          releaseHeld = () =>
            resolve({ ok: true, status: 200, json: async () => ({ inventory: [] }) } as unknown as Response);
        });
      }
      if (read.mode === "failed") {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ inventory: read.inventory }),
      } as unknown as Response);
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => [] } as unknown as Response);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  releaseHeld?.();
});

function renderSheet() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ExternalOrderDetailsSheet order={ORDER} open onOpenChange={jest.fn()} csrfToken="t" />
    </QueryClientProvider>
  );
  return queryClient;
}

/** Lets the stock read (and its render) run. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));

/** No badge on screen claims a number, and none wears the stock-out red. */
function expectNoStockNumber() {
  expect(screen.queryByText(/In Stock:/)).toBeNull();
  expect(document.querySelector(".text-red-700")).toBeNull();
}

describe("FR3-4 — the order sheet's stock badge states its read", () => {
  it("pending, no answer: an outline `Reading stock…` badge — never a red `In Stock: 0`", async () => {
    stockRead = { mode: "held" };
    renderSheet();
    await waitFor(() => expect(stockReads()).toBe(1));
    await settle();

    const badge = screen.getByText(READING);
    expect(badge.tagName).toBe("DIV");
    expect(badge).toHaveClass("text-xs", "border-border");
    expect(badge).not.toHaveClass("text-destructive");
    expectNoStockNumber();
  });

  it("failed, no answer: `Couldn't read stock.` in the destructive tone — never `In Stock: 0`", async () => {
    stockRead = { mode: "failed" };
    renderSheet();
    const badge = await screen.findByText(FAILED);
    expect(badge.tagName).toBe("DIV");
    expect(badge).toHaveClass("text-xs", "text-destructive", "border-border");
    expect(screen.queryByText(READING)).toBeNull();
    expectNoStockNumber();
  });

  it.each([
    ["enough for the line: green", 5, "text-green-700"],
    ["fewer than the line needs: amber", 1, "text-amber-700"],
    ["none: red", 0, "text-red-700"],
  ])("with an answer, %s", async (_what, quantity, tone) => {
    stockRead = { mode: "ok", inventory: [{ productId: 501, quantity }] };
    renderSheet();
    const badge = await screen.findByText(`In Stock: ${quantity}`);
    expect(badge).toHaveClass("text-xs", tone);
    expect(screen.queryByText(READING)).toBeNull();
    expect(screen.queryByText(FAILED)).toBeNull();
  });

  it("a product missing from a SUCCESSFUL answer is 0 (no inventory row, no units) — red", async () => {
    stockRead = { mode: "ok", inventory: [{ productId: 777, quantity: 9 }] };
    renderSheet();
    const badge = await screen.findByText("In Stock: 0");
    expect(badge).toHaveClass("text-red-700");
  });

  it("the red `In Stock: 0` shows only once the answer arrives — never before it", async () => {
    stockRead = { mode: "held" };
    renderSheet();
    await waitFor(() => expect(stockReads()).toBe(1));
    await settle();
    expect(screen.getByText(READING)).toBeInTheDocument();
    expectNoStockNumber();

    await act(async () => {
      releaseHeld!();
      releaseHeld = null;
    });
    const badge = await screen.findByText("In Stock: 0");
    expect(badge).toHaveClass("text-red-700");
    expect(screen.queryByText(READING)).toBeNull();
  });

  it("a failed REFRESH over an answer keeps the number (it is still the last answer)", async () => {
    stockRead = { mode: "ok", inventory: [{ productId: 501, quantity: 5 }] };
    const queryClient = renderSheet();
    expect(await screen.findByText("In Stock: 5")).toBeInTheDocument();

    stockRead = { mode: "failed" };
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["inventory-current-fast", 2] });
    });
    expect(stockReads()).toBe(2);
    expect(queryClient.getQueryState(["inventory-current-fast", 2])?.status).toBe("error");
    // react-query tells its observers on a timer: let the sheet render the failure.
    await settle();
    expect(screen.getByText("In Stock: 5")).toBeInTheDocument();
    expect(screen.queryByText(FAILED)).toBeNull();
  });
});
