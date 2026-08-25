/** @jest-environment jsdom */
/**
 * THE `?line=` ANCHOR (pack C4b.3; spec REV-7 D5).
 *
 * The exceptions finder deep-links a discrepancy to the LINE that raised it —
 * `/receiving/<id>?line=<lineId>` — and an order with thirty lines is not a
 * destination unless the right card is under the reader's eyes when the page
 * settles. Four pins:
 *
 *   1. EVERY LINE IS ADDRESSABLE. `id="line-<id>"` on every card, and the
 *      existing `data-testid` KEPT — the id is an addition, not a rename, and
 *      the receiving suite that drives these cards must not notice this change
 *      at all.
 *   2. THE SCROLL IS FOR THE NAMED LINE. `scrollIntoView` fires on that
 *      element, once, and never for a page that named no line.
 *   3. THE HIGHLIGHT IS TRANSIENT. Two seconds says "here", a permanent ring
 *      says "this line is special", which it is not.
 *   4. THE SCREEN IS WHERE `?line=` IS READ. The param is a client-side fact
 *      about the URL; the legacy branch gets nothing, because a W1 receipt is
 *      read-only history with no such lines to anchor.
 *
 * The spy is on `Element.prototype.scrollIntoView` — jsdom implements no
 * layout, so the method does not exist unless a test puts it there.
 */

import * as React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "t", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: Record<string, string>) => ({ ...h, "x-csrf-token": "t" }),
}));
jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: 7, isAdmin: true, defaultLocationId: 1 } } }),
}));
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn(), warning: jest.fn() },
}));

let searchParams = new URLSearchParams("");
jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

import { SupplyOrderDetail } from "@/components/receiving/supply-order-detail";
import { ReceivingDetailScreen } from "@/components/receiving/receiving-detail-screen";

const ORDER_ID = "cksupply000000000000000001";

let scrollIntoView: jest.SpyInstance;
const mockFetch = jest.fn();

beforeAll(() => {
  Element.prototype.hasPointerCapture = jest.fn(() => false) as never;
  Element.prototype.setPointerCapture = jest.fn() as never;
  Element.prototype.releasePointerCapture = jest.fn() as never;
  Element.prototype.scrollIntoView = jest.fn() as never;
});

beforeEach(() => {
  jest.clearAllMocks();
  searchParams = new URLSearchParams("");
  scrollIntoView = jest.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
  global.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
    if (String(url).includes("/api/locations")) {
      return jsonResponse(200, [{ id: 1, name: "Main" }]);
    }
    return jsonResponse(200, detail());
  });
});

afterEach(() => {
  scrollIntoView.mockRestore();
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function line(over: Record<string, unknown> = {}) {
  return {
    id: 11,
    orderedProductId: 55,
    orderedProductName: "BPC-157 5mg",
    productId: 55,
    productName: "BPC-157 5mg",
    status: "ORDERED",
    orderedQuantity: 10,
    verifiedQuantity: null,
    stockedQuantity: 0,
    disposedQuantity: 0,
    remaining: 0,
    lineTotalCents: 125000,
    unitCostCents: 12500,
    derivation: "$1,250.00 / 10 ordered = $125.00/unit",
    labelingRequired: true,
    locationId: null,
    verifiedAt: null,
    verifiedBy: null,
    discrepancy: null,
    exceptionKeys: [],
    lineRemoved: false,
    ...over,
  };
}

function detail(lines = [line(), line({ id: 12, productName: "TB-500 5mg" })]) {
  return {
    model: "supply-order",
    id: ORDER_ID,
    status: "RECEIVING",
    supplier: "Acme Peptides",
    supplierRef: "PO-2026-0142",
    orderedAt: "2026-08-14T00:00:00.000Z",
    feesCents: 0,
    feesNote: null,
    createdBy: 7,
    creator: { id: 7, username: "kris" },
    closedBy: null,
    closedAt: null,
    createdAt: "2026-08-14T09:00:00.000Z",
    updatedAt: "2026-08-15T09:00:00.000Z",
    notes: null,
    lineCounts: { ordered: lines.length, verified: 0, labeling: 0, complete: 0, discarded: 0 },
    units: { verified: 0, stocked: 0, disposed: 0 },
    discrepancy: {
      linesWithDiscrepancy: 0,
      shortUnits: 0,
      overUnits: 0,
      lossCents: 0,
      surplusValueCents: 0,
      unorderedLines: 0,
    },
    lines,
    exceptions: [],
  };
}

function legacyReceipt() {
  return {
    model: "legacy",
    legacy: {
      id: "cklegacy00000000000000001",
      supplierRef: "LEG-77",
      status: "CLOSED",
      notes: null,
      createdBy: 7,
      closedBy: 7,
      createdAt: "2026-06-01T09:00:00.000Z",
      updatedAt: "2026-06-02T09:00:00.000Z",
      closedAt: "2026-06-02T09:00:00.000Z",
      creator: { id: 7, username: "kris" },
      itemCount: 1,
      receivedItemCount: 1,
      graduatedItemCount: 0,
      uncountedReceivedItemCount: 0,
      discrepancy: {
        itemCount: 1,
        countedItemCount: 1,
        uncountedItemCount: 0,
        discrepancyItemCount: 0,
        totalOver: 0,
        totalUnder: 0,
      },
      items: [
        {
          id: 11,
          description: "Vials 10ml",
          status: "RECEIVED",
          expectedQuantity: 10,
          countedQuantity: 10,
          unitCostCents: 250,
          resolvedProductId: null,
          locationId: 1,
          vendor: "Acme",
          reference: "LEG-77",
          notes: null,
          receivedAt: "2026-06-01T09:00:00.000Z",
          countedAt: "2026-06-01T10:00:00.000Z",
          countedBy: 7,
          location: { id: 1, name: "Main" },
          resolvedProduct: null,
          flags: { counted: true, expectedMissing: false, delta: 0, direction: "MATCH" },
        },
      ],
    },
  };
}

function renderDetail(focusLineId?: number | null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <SupplyOrderDetail detail={detail() as any} focusLineId={focusLineId} />
    </QueryClientProvider>,
  );
}

function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ReceivingDetailScreen id={ORDER_ID} />
    </QueryClientProvider>,
  );
}

describe("every line is addressable", () => {
  it("carries id=line-<id> AND keeps its data-testid", () => {
    renderDetail();

    for (const id of [11, 12]) {
      const card = screen.getByTestId(`supply-order-line-${id}`);
      expect(card).toHaveAttribute("id", `line-${id}`);
      expect(document.getElementById(`line-${id}`)).toBe(card);
    }
  });
});

describe("the scroll", () => {
  it("scrolls the NAMED line into view, and nothing else", () => {
    renderDetail(12);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(scrollIntoView.mock.instances[0]).toBe(document.getElementById("line-12"));
  });

  it("a page that named no line scrolls nowhere", () => {
    renderDetail();
    expect(scrollIntoView).not.toHaveBeenCalled();

    renderDetail(null);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("a line id this order does not carry scrolls nowhere — and never throws", () => {
    renderDetail(999);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("the highlight", () => {
  it("rings the line for two seconds, then stops", () => {
    jest.useFakeTimers();
    try {
      renderDetail(12);

      const card = screen.getByTestId("supply-order-line-12");
      expect(card.className).toContain("ring-2");
      expect(card.className).toContain("ring-primary");
      expect(screen.getByTestId("supply-order-line-11").className).not.toContain("ring-2");

      act(() => {
        jest.advanceTimersByTime(2000);
      });

      expect(screen.getByTestId("supply-order-line-12").className).not.toContain("ring-2");
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("the screen reads ?line=", () => {
  it("hands the detail the line the URL names", async () => {
    searchParams = new URLSearchParams("line=12");
    renderScreen();

    expect(await screen.findByTestId("supply-order-line-12")).toBeInTheDocument();
    await waitFor(() =>
      expect(scrollIntoView.mock.instances[0]).toBe(document.getElementById("line-12")),
    );
  });

  it("a URL that names no line anchors nothing", async () => {
    renderScreen();

    expect(await screen.findByTestId("supply-order-line-11")).toBeInTheDocument();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("a `line` param that is not a number is ignored, not coerced", async () => {
    searchParams = new URLSearchParams("line=oops");
    renderScreen();

    expect(await screen.findByTestId("supply-order-line-11")).toBeInTheDocument();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("the LEGACY branch has no anchor behaviour — read-only history, no lines to hold", async () => {
    searchParams = new URLSearchParams("line=11");
    mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/locations")) {
        return jsonResponse(200, [{ id: 1, name: "Main" }]);
      }
      return jsonResponse(200, legacyReceipt());
    });
    renderScreen();

    expect(await screen.findByText("Vials 10ml")).toBeInTheDocument();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
