/** @jest-environment jsdom */
/**
 * /receiving/[id] — the `model` fork (contract pack C4b.1).
 *
 * ONE dataset, two shapes: a supply order renders the new detail, a W1 receipt
 * renders read-only history, and the screen above them owns the single read.
 * The load-error case lives here (moved out of the legacy detail's suite in
 * M4b): the failure belongs to whoever made the request, and a renderer handed
 * no data has nothing honest to say about why.
 */

import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
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

import { ReceivingDetailScreen } from "@/components/receiving/receiving-detail-screen";

const ORDER_ID = "cksupply000000000000000001";
const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = mockFetch as unknown as typeof fetch;
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function supplyOrder() {
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
    lineCounts: { ordered: 1, verified: 0, labeling: 0, complete: 0, discarded: 0 },
    units: { verified: 0, stocked: 0, disposed: 0 },
    discrepancy: {
      linesWithDiscrepancy: 0,
      shortUnits: 0,
      overUnits: 0,
      lossCents: 0,
      surplusValueCents: 0,
      unorderedLines: 0,
    },
    lines: [],
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
      notes: "delivered in two vans",
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

function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ReceivingDetailScreen id={ORDER_ID} />
    </QueryClientProvider>,
  );
}

const detailReads = () =>
  mockFetch.mock.calls.filter(
    ([url, init]) =>
      String(url).includes(`/api/inbound-shipments/${ORDER_ID}`) &&
      (init as RequestInit | undefined)?.method === undefined,
  );

describe("the model fork", () => {
  it("renders the supply-order detail for a new-flow order", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, supplyOrder()));
    renderScreen();

    expect(await screen.findByTestId("supply-order-header")).toBeInTheDocument();
    expect(screen.queryByTestId("legacy-banner")).not.toBeInTheDocument();
  });

  it("renders the legacy receipt as read-only history — with NO controls", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, legacyReceipt()));
    renderScreen();

    expect(await screen.findByTestId("legacy-banner")).toHaveTextContent(
      "Legacy receipt (read-only history)",
    );
    expect(screen.getByText("Vials 10ml")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByTestId("supply-order-header")).not.toBeInTheDocument();
  });

  it("reads the order ONCE — the legacy branch never fetches for itself", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, legacyReceipt()));
    renderScreen();

    await screen.findByTestId("legacy-banner");
    await waitFor(() => expect(detailReads()).toHaveLength(1));
  });
});

describe("a failed read", () => {
  it("says the order could not be loaded, with the server's reason", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(404, { error: "Inbound shipment not found", code: "NOT_FOUND" }),
    );
    renderScreen();

    expect(await screen.findByTestId("shipment-detail-error")).toBeInTheDocument();
    expect(screen.getByText("Inbound shipment not found")).toBeInTheDocument();
    // The list/detail is NOT rendered next to the failure (W25-3's rule).
    expect(screen.queryByTestId("supply-order-header")).not.toBeInTheDocument();
    expect(screen.queryByTestId("legacy-banner")).not.toBeInTheDocument();
  });
});
