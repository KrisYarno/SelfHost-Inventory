/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "t", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: HeadersInit) => h,
}));
jest.mock("@/contexts/location-context", () => ({
  useLocation: () => ({ selectedLocationId: 2, locations: [{ id: 2, name: "Office" }] }),
}));

import { QuickAdjustDialog } from "@/components/inventory/quick-adjust-dialog";

const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);

test("shows loading then the fetched per-location quantity (never a passed-in total)", async () => {
  let resolveQty!: (v: unknown) => void;
  global.fetch = jest.fn((url: RequestInfo | URL) => {
    if (String(url).includes("/api/inventory/product/")) return new Promise((r) => (resolveQty = r));
    return Promise.resolve({ ok: true, json: async () => ({}) });
  }) as unknown as typeof fetch;
  wrap(<QuickAdjustDialog open onOpenChange={() => {}} product={{ id: 42, name: "AOD 2mg" }} onSuccess={() => {}} />);
  expect(screen.getByText(/loading/i)).toBeInTheDocument();
  resolveQty({ ok: true, json: async () => ({ currentQuantity: 7 }) });
  await waitFor(() => expect(screen.getByText(/7/)).toBeInTheDocument());
});
