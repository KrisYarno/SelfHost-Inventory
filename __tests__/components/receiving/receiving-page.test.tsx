/** @jest-environment jsdom */
/**
 * /receiving — the ORDERS PAGE's read states (W25-3; M4a left this unpinned and
 * the M4b amendment 4c adds the pin here).
 *
 * The one thing that must never happen: a FAILED read rendering the list's own
 * empty state. "No supply orders yet — the queue fills when an order is placed"
 * is an invitation to enter an order, and giving that invitation because a
 * request did not land is how the same order gets entered twice.
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
