/** @jest-environment jsdom */
//
// Facelift FR1-4 (plan 2026-11-18-facelift-f1, REV 6; GR-4 = OCR-8) — the
// Stocker page never asks for a refill list with no location.
//
// Before: with no location selected the page still read `/api/stocker/minimums`
// with no `locationId`, and the server fell back to the user's default or
// location 1 — a refill list (and Stock In buttons) for somewhere nobody chose,
// or "Everything is fully stocked" for nowhere. Now the read is DISABLED with
// no location, and the location ladder says why.

import * as React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Loc = { id: number; name: string };
const OFFICE: Loc = { id: 2, name: "Office" };
type LocationContext = {
  locations: Loc[];
  selectedLocationId: number | null;
  selectedLocation: Loc | null;
  isLoading: boolean;
  loadFailed: boolean;
};
let locationContext: LocationContext;
jest.mock("@/contexts/location-context", () => ({
  useLocation: () => locationContext,
}));
jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "t", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: Record<string, string>) => h,
}));

import StockerPage from "@/app/(app)/stocker/page";

const NO_LOCATION = "Choose a location to see what needs refilling.";
const ALL_STOCKED = "All products are above their minimum levels";

let fetchMock: jest.Mock;
const minimumsReads = () =>
  fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/stocker/minimums"));

beforeEach(() => {
  fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      location: OFFICE,
      items: [
        { productId: 1, productName: "Widget 5mg", currentQuantity: 1, minQuantity: 4, shortage: 3 },
      ],
    }),
  }));
  global.fetch = fetchMock as unknown as typeof fetch;
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = () => (
    <QueryClientProvider client={qc}>
      <StockerPage />
    </QueryClientProvider>
  );
  const view = render(ui());
  return { rerender: () => view.rerender(ui()) };
}

const none = (list: Partial<LocationContext>): LocationContext => ({
  locations: [OFFICE],
  isLoading: false,
  loadFailed: false,
  selectedLocationId: null,
  selectedLocation: null,
  ...list,
});

describe("FR1-4 — the Stocker page with no location", () => {
  it.each<[string, Partial<LocationContext>, string]>([
    ["loading", { locations: [], isLoading: true }, "Loading locations…"],
    ["failed, nothing loaded", { locations: [], loadFailed: true }, "Couldn't load locations."],
    ["zero locations", { locations: [] }, "No locations configured."],
    ["loaded, none selected", {}, NO_LOCATION],
  ])("%s: the ladder says why, the server is never asked, and nothing claims the shelves are stocked", async (_label, list, sentence) => {
    locationContext = none(list);
    renderPage();

    expect(screen.getByText(sentence)).toBeInTheDocument();
    await act(async () => {});
    expect(minimumsReads()).toHaveLength(0);
    expect(screen.queryByText(ALL_STOCKED)).toBeNull();
    expect(screen.queryByText("Widget 5mg")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stock In" })).toBeNull();
  });

  it("with a location, the list is read FOR it and shown (unchanged)", async () => {
    locationContext = { ...none({}), selectedLocationId: 2, selectedLocation: OFFICE };
    renderPage();

    expect(await screen.findByText("Widget 5mg")).toBeInTheDocument();
    expect(minimumsReads().map(([u]) => String(u))).toEqual(["/api/stocker/minimums?locationId=2"]);
    expect(screen.queryByText(NO_LOCATION)).toBeNull();
  });

  it("the location going away stops the reads and says why", async () => {
    locationContext = { ...none({}), selectedLocationId: 2, selectedLocation: OFFICE };
    const view = renderPage();
    expect(await screen.findByText("Widget 5mg")).toBeInTheDocument();
    const reads = minimumsReads().length;

    locationContext = none({});
    view.rerender();
    await waitFor(() => expect(screen.getByText(NO_LOCATION)).toBeInTheDocument());
    expect(minimumsReads()).toHaveLength(reads);
    expect(screen.queryByText("Widget 5mg")).toBeNull();
  });
});
