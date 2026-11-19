/** @jest-environment jsdom */
//
// Facelift FR2-4 (plan 2026-11-18-facelift-f1, REV 8; FD1-4, FD1-7) — Stocker
// never reads or stocks without a location.
//
// Before (after FR1-4 disabled the refill read with no location):
//   - a stock-in that SUCCEEDED after the location went away called
//     `refetch()`, which ignores `enabled` — and read `/api/stocker/minimums`
//     with no `locationId`, the server's fallback to the user's default or
//     location 1 (FD1-4);
//   - the Stock In transfer dialog stayed mounted with no location, with a
//     destination of `0` and a name of "Unknown" (FD1-7);
//   - the header badges read `0 products need refill` / `0 units needed` with
//     no location, while loading and after a failure (REV 7's F4 registration).
// Now the refetch runs only with a location, the dialog exists only with one,
// and the badges show only for an answer.

import * as React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

// The Stock In transfer dialog, captured: every render's props, and a marker
// in the tree while it is rendered.
type DialogProps = {
  open: boolean;
  destinationLocationId: number;
  destinationLocationName: string;
  onSuccess?: () => void;
};
const dialogRenders: DialogProps[] = [];
jest.mock("@/components/inventory/stock-in-transfer-dialog", () => ({
  StockInTransferDialog: (props: DialogProps) => {
    dialogRenders.push(props);
    return <div data-testid="stock-in-transfer-dialog" />;
  },
}));

import StockerPage from "@/app/(app)/stocker/page";

const ANSWER = {
  location: OFFICE,
  items: [{ productId: 1, productName: "Widget 5mg", currentQuantity: 1, minQuantity: 4, shortage: 3 }],
};

let fetchMock: jest.Mock;
const minimumsReads = () =>
  fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/api/stocker/minimums"));

beforeEach(() => {
  dialogRenders.length = 0;
  fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => ANSWER }));
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

const none = (list: Partial<LocationContext> = {}): LocationContext => ({
  locations: [OFFICE],
  isLoading: false,
  loadFailed: false,
  selectedLocationId: null,
  selectedLocation: null,
  ...list,
});
const atOffice = (): LocationContext => ({ ...none(), selectedLocationId: 2, selectedLocation: OFFICE });

const PRODUCTS_BADGE = /^\d+ products? need refill$/;
const UNITS_BADGE = /^\d+ units? needed$/;

describe("FR2-4 — Stock In and its refetch, only with a location", () => {
  it("a stock-in that succeeds after the location went away reads NOTHING — never the list with no `locationId`", async () => {
    locationContext = atOffice();
    const view = renderPage();
    expect(await screen.findByText("Widget 5mg")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stock In" }));
    const opened = dialogRenders[dialogRenders.length - 1];
    expect(opened).toMatchObject({ open: true, destinationLocationId: 2, destinationLocationName: "Office" });
    const readsBefore = minimumsReads().length;

    // The location goes away while the stock-in is in flight…
    locationContext = none();
    view.rerender();
    await act(async () => {});

    // …and the stock-in then succeeds, calling the callback it was given.
    await act(async () => {
      opened.onSuccess?.();
    });
    await act(async () => {});
    expect(minimumsReads()).toHaveLength(readsBefore);
    expect(minimumsReads().every((u) => u.includes("locationId="))).toBe(true);
  });

  it("with a location, a stock-in success reads the list again FOR it (unchanged)", async () => {
    locationContext = atOffice();
    renderPage();
    expect(await screen.findByText("Widget 5mg")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stock In" }));
    const opened = dialogRenders[dialogRenders.length - 1];
    const readsBefore = minimumsReads().length;

    await act(async () => {
      opened.onSuccess?.();
    });
    await waitFor(() => expect(minimumsReads()).toHaveLength(readsBefore + 1));
    expect(minimumsReads()[readsBefore]).toBe("/api/stocker/minimums?locationId=2");
  });

  it("the Stock In dialog exists only with a location: never a destination of `0` or `Unknown`", async () => {
    locationContext = none();
    const view = renderPage();
    await act(async () => {});
    expect(screen.queryByTestId("stock-in-transfer-dialog")).toBeNull();
    expect(dialogRenders).toHaveLength(0);

    locationContext = atOffice();
    view.rerender();
    expect(await screen.findByText("Widget 5mg")).toBeInTheDocument();
    expect(screen.getByTestId("stock-in-transfer-dialog")).toBeInTheDocument();
    expect(dialogRenders[dialogRenders.length - 1]).toMatchObject({
      destinationLocationId: 2,
      destinationLocationName: "Office",
    });

    locationContext = none();
    view.rerender();
    await act(async () => {});
    expect(screen.queryByTestId("stock-in-transfer-dialog")).toBeNull();
    expect(
      dialogRenders.filter((p) => p.destinationLocationId === 0 || p.destinationLocationName === "Unknown")
    ).toHaveLength(0);
  });
});

describe("FR2-4 — the count badges, only for an answer", () => {
  it.each<[string, () => void]>([
    ["no location", () => (locationContext = none())],
    [
      "the list still loading",
      () => {
        locationContext = atOffice();
        fetchMock.mockImplementation(() => new Promise(() => {}));
      },
    ],
    [
      "the list's read failed",
      () => {
        locationContext = atOffice();
        fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
      },
    ],
  ])("%s: no `0 products need refill` / `0 units needed`", async (label, arrange) => {
    arrange();
    renderPage();
    if (label === "the list's read failed") {
      expect(await screen.findByText("Unable to load refill list. Please try again.")).toBeInTheDocument();
    }
    await act(async () => {});
    expect(screen.queryByText(PRODUCTS_BADGE)).toBeNull();
    expect(screen.queryByText(UNITS_BADGE)).toBeNull();
  });

  it("with an answer: the badges count it", async () => {
    locationContext = atOffice();
    renderPage();
    expect(await screen.findByText("1 product need refill")).toBeInTheDocument();
    expect(screen.getByText("3 units needed")).toBeInTheDocument();
  });
});
