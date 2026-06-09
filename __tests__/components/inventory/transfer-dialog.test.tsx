/** @jest-environment jsdom */
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "t", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: HeadersInit) => h,
}));
jest.mock("@/contexts/location-context", () => {
  // Stable reference: the dialog's seed effect depends on `locations`; the real
  // context provides stable state, so the mock must not re-create the array.
  const locations = [
    { id: 2, name: "Office" },
    { id: 3, name: "Warehouse" },
  ];
  return {
    useLocation: () => ({ selectedLocationId: 2, locations }),
  };
});

import { TransferDialog } from "@/components/inventory/transfer-dialog";

const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);

test("flat insufficient-stock 400 body drives the auto-add AlertDialog with shortfall numbers", async () => {
  global.fetch = jest.fn((url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("/api/inventory/transfer")) {
      return Promise.resolve({
        ok: false,
        status: 400,
        json: async () => ({
          error: "Insufficient stock",
          code: "INVENTORY_INSUFFICIENT_STOCK",
          currentQuantity: 2,
          requestedQuantity: 5,
          shortfall: 3,
        }),
      });
    }
    if (u.includes("/api/inventory/product/")) {
      const locationId = new URL(u, "http://test.local").searchParams.get("locationId");
      // Source (Office, id 2) has 2 units; destination (Warehouse, id 3) has 0.
      return Promise.resolve({
        ok: true,
        json: async () => ({ currentQuantity: locationId === "2" ? 2 : 0 }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  }) as unknown as typeof fetch;

  wrap(
    <TransferDialog
      open
      onOpenChange={() => {}}
      product={{ id: 42, name: "AOD 2mg" }}
      onSuccess={() => {}}
    />
  );

  // Source quantity resolves (2 units at Office) before we submit.
  expect(await screen.findAllByText(/2 units/)).not.toHaveLength(0);

  fireEvent.change(screen.getByPlaceholderText("0"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: /transfer 5 units/i }));

  // CONTRACT: flat-shape rejection -> auto-add UI visible with shortfall-derived numbers.
  const alert = await screen.findByRole("alertdialog");
  expect(alert).toHaveTextContent("Not enough stock at source location");
  expect(alert).toHaveTextContent("Available now: 2");
  expect(alert).toHaveTextContent("Shortfall to complete transfer: 3");
  expect(alert).toHaveTextContent("so you can move 5");
});
