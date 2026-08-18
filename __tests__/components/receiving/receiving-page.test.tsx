/** @jest-environment jsdom */
/**
 * /receiving — the ORDERS PAGE's read states (W25-3; M4a left this unpinned and
 * the M4b amendment 4c adds the pin here).
 *
 * The one thing that must never happen: a FAILED read rendering the list's own
 * empty state. "No supply orders yet — the queue fills when an order is placed"
 * is an invitation to enter an order, and giving that invitation because a
 * request did not land is how the same order gets entered twice.
 *
 * QA-3 adds the second: the page owns TWO reads, because `?model=` is
 * single-valued and a selection spanning both families cannot be asked for in
 * one request. The union-with-no-model form it replaces was bounded at 100 rows
 * ordered by `orderedAt DESC`, and a legacy header has no `orderedAt` — so the
 * archive the operator ticked was the first thing the bound threw away.
 */

import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "t", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: Record<string, string>) => ({ ...h, "x-csrf-token": "t" }),
}));
jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: 7, isAdmin: true, defaultLocationId: 1 } } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
}));
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn(), warning: jest.fn() },
}));

import ReceivingPage from "@/app/(app)/receiving/page";

const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = mockFetch as unknown as typeof fetch;
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ReceivingPage />
    </QueryClientProvider>,
  );
}


function supplyOrder(over: Record<string, unknown> = {}) {
  return {
    model: "supply-order",
    id: "cksupply000000000000000001",
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
    ...over,
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
      closedBy: null,
      createdAt: "2026-01-04T09:00:00.000Z",
      updatedAt: "2026-01-04T09:00:00.000Z",
      closedAt: null,
      creator: { id: 7, username: "kris" },
      itemCount: 3,
      receivedItemCount: 3,
      graduatedItemCount: 0,
      uncountedReceivedItemCount: 0,
      discrepancy: {
        itemCount: 3,
        countedItemCount: 3,
        uncountedItemCount: 0,
        discrepancyItemCount: 0,
        totalOver: 0,
        totalUnder: 0,
      },
    },
  };
}

/** Every request the page issued, as `{ model: statuses }`. */
function requestedByModel(): Record<string, string | null> {
  return Object.fromEntries(
    mockFetch.mock.calls.map((call) => {
      const url = new URL(String(call[0]), "http://t");
      return [url.searchParams.get("model") ?? "none", url.searchParams.get("status")];
    }),
  );
}


it("QA-3: the Legacy chip asks its OWN request, and the two answers are merged", async () => {
  const user = userEvent.setup();
  mockFetch.mockImplementation(async (input: RequestInfo) => {
    const legacyAsked = String(input).includes("model=legacy");
    return {
      ok: true,
      status: 200,
      json: async () => ({ shipments: legacyAsked ? [legacyReceipt()] : [supplyOrder()] }),
    } as unknown as Response;
  });

  renderPage();
  expect(await screen.findByText("PO-2026-0142")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Legacy receipts" }));

  // BOTH families are on screen at once — the union request could only ever
  // have returned the newest 100 of them, legacy last.
  expect(await screen.findByText("LEG-77")).toBeInTheDocument();
  expect(screen.getByText("PO-2026-0142")).toBeInTheDocument();

  const asked = requestedByModel();
  expect(asked["supply-order"]).toBe("ORDERED,RECEIVING");
  expect(asked["legacy"]).toBe("OPEN,CLOSED,CANCELLED");
  // And NO unioned, model-less request was ever sent.
  expect(asked["none"]).toBeUndefined();
});

it("QA-3: issues NO request at all when no chip is selected", async () => {
  const user = userEvent.setup();
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ shipments: [] }),
  } as unknown as Response);

  renderPage();
  await screen.findByTestId("shipment-list-empty");

  await user.click(screen.getByRole("button", { name: "Ordered" }));
  await user.click(screen.getByRole("button", { name: "Receiving" }));

  await screen.findByText(/No status selected/i);
  // Two chips were switched off; the page asked exactly twice, for the two
  // selections that existed. A question nobody asked is not a request.
  expect(mockFetch.mock.calls.length).toBe(2);
});

it("QA-3: says the list is BOUNDED when a full page comes back", async () => {
  const page = Array.from({ length: 100 }, (_, index) =>
    supplyOrder({ id: `cksupply00000000000000${String(index).padStart(4, "0")}` }),
  );
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ shipments: page }),
  } as unknown as Response);

  renderPage();

  expect(await screen.findByTestId("shipment-list-truncated")).toHaveTextContent(
    "Showing the newest 100 — refine the chips.",
  );
});

it("renders the ERROR BANNER INSTEAD OF the list when the read fails", async () => {
  mockFetch.mockResolvedValue({
    ok: false,
    status: 500,
    json: async () => ({ error: "Failed to list inbound shipments" }),
  } as unknown as Response);

  renderPage();

  expect(await screen.findByTestId("shipment-list-error")).toBeInTheDocument();
  expect(screen.getByText("Failed to list inbound shipments")).toBeInTheDocument();
  // NOT the list, and above all not its empty state.
  expect(
    screen.queryByText(/No supply orders yet — the queue fills when an order is placed/i),
  ).not.toBeInTheDocument();
  expect(screen.queryByTestId("shipment-list-empty")).not.toBeInTheDocument();
});

it("renders the list when the read lands", async () => {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ shipments: [] }),
  } as unknown as Response);

  renderPage();

  await waitFor(() =>
    expect(screen.queryByTestId("shipment-list-error")).not.toBeInTheDocument(),
  );
  expect(await screen.findByTestId("shipment-list-empty")).toHaveTextContent(
    "No supply orders yet — the queue fills when an order is placed with a supplier.",
  );
});
