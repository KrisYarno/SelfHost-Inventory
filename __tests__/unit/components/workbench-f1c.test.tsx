/** @jest-environment jsdom */
//
// Facelift F1c (plan 2026-11-18-facelift-f1, REV 2 F1c) — the workbench page's
// small items F0 registered for F1.
//
//   F1-9  the order rows say WHY there is no location: the page hands the
//         selector the location list's state (the ladder itself is pinned in
//         workbench-wc-order-selector.test.tsx);
//   F1-10 a cart whose build read no one location's rows (null) is "not built
//         here" — even with no location selected (null/null);
//   F1-11 a picker confirm while the order is updating says so;
//   F1-15 the product grid: with no location, the location ladder (never
//         another location's rows, never `No products available`); a failed
//         read with nothing loaded says so, with Retry.
//
// The REAL products hook on a REAL QueryClient, so "placeholder" and "error
// with no data" are react-query's, not a mock's.

import * as React from "react";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }),
}));
jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "test-csrf", isLoading: false, error: null, refreshToken: jest.fn() }),
  withCSRFHeaders: (h: Record<string, string>) => ({ ...h, "x-csrf-token": "test-csrf" }),
}));
jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { isAdmin: false } } }),
}));

type Loc = { id: number; name: string };
const MAIN: Loc = { id: 1, name: "Main" };
const OVERFLOW: Loc = { id: 2, name: "Overflow" };
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
jest.mock("@/hooks/use-low-stock-default", () => ({ useLowStockDefault: () => 10 }));

jest.mock("sonner", () => {
  const toast = jest.fn() as jest.Mock & Record<string, jest.Mock>;
  toast.error = jest.fn();
  toast.success = jest.fn();
  toast.info = jest.fn();
  toast.warning = jest.fn();
  toast.message = jest.fn();
  toast.dismiss = jest.fn();
  return { toast };
});

jest.mock("@/components/workbench/complete-order-dialog", () => ({
  CompleteOrderDialog: () => null,
}));
jest.mock("@/components/workbench/order-queue", () => ({ OrderQueue: () => null }));
jest.mock("@/components/products/product-map-dialog", () => ({ ProductMapDialog: () => null }));

type SelectorProps = {
  noLocation?: boolean;
  locationList?: { isLoading: boolean; loadFailed: boolean; count: number };
};
let selectorProps: SelectorProps | null;
jest.mock("@/components/workbench/wc-order-selector", () => ({
  noLocationSentence: jest.requireActual("@/components/workbench/wc-order-selector").noLocationSentence,
  WCOrderSelector: (props: SelectorProps) => {
    selectorProps = props;
    return null;
  },
}));

type SheetProps = { canComplete: boolean; updatingNotice?: string | null; cartReadOnly?: boolean };
let sheetProps: SheetProps | null;
jest.mock("@/components/workbench/mobile-cart-sheet", () => ({
  MobileCartSheet: (props: SheetProps) => {
    sheetProps = props;
    return null;
  },
}));

import { toast } from "sonner";
import WorkbenchPage from "@/app/(app)/workbench/page";
import { useWorkbench } from "@/hooks/use-workbench";
import type { ExternalOrder } from "@/types/external-orders";
import type { ProductWithQuantity } from "@/types/product";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type ExternalItem = NonNullable<ExternalOrder["items"]>[number];

const ORDER_X = {
  id: "ord-x",
  companyId: "co-1",
  integrationId: "int-1",
  externalId: "9001",
  orderNumber: "9001",
  total: 1,
  customerName: "Ada L",
  internalStatus: "processing",
  items: [
    {
      id: "x-1",
      orderId: "ord-x",
      externalItemId: null,
      externalProductId: "wc-x-1",
      externalVariantId: null,
      name: "Widget 10mg",
      variantName: null,
      sku: null,
      quantity: 2,
      fulfilledQty: 0,
      price: 10,
      productLinkId: "pl-x-1",
      isMapped: true,
      productLink: { internalProductId: 501, internalProduct: { id: 501 } },
    } as unknown as ExternalItem,
  ],
} as unknown as ExternalOrder;

const CATALOGUE = [
  { id: 501, name: "Widget 10mg" },
  { id: 502, name: "Gadget 5mg" },
];
const STOCK: Record<number, { productId: number; quantity: number; version: number }[]> = {
  1: [
    { productId: 501, quantity: 10, version: 1 },
    { productId: 502, quantity: 4, version: 1 },
  ],
  2: [
    { productId: 501, quantity: 5, version: 1 },
    { productId: 502, quantity: 3, version: 1 },
  ],
};
const MAIN_ROWS = [
  { id: 501, name: "Widget 10mg", currentQuantity: 10 },
  { id: 502, name: "Gadget 5mg", currentQuantity: 4 },
] as unknown as ProductWithQuantity[];

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const refused = () =>
  ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }) as unknown as Response;

let stockReply: Record<number, () => Promise<Response>>;
let fetchMock: jest.Mock;
const stockFetches = (locationId: number) =>
  fetchMock.mock.calls.filter(
    ([u]) => String(u) === `/api/inventory/current-fast?locationId=${locationId}`
  );

let qc: QueryClient;
function renderPage() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = () => (
    <QueryClientProvider client={qc}>
      <WorkbenchPage />
    </QueryClientProvider>
  );
  const view = render(ui());
  return { rerender: () => view.rerender(ui()) };
}

const setWidth = (width: number) =>
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });

const LOADED: Pick<LocationContext, "locations" | "isLoading" | "loadFailed"> = {
  locations: [MAIN, OVERFLOW],
  isLoading: false,
  loadFailed: false,
};
const at = (loc: Loc | null): LocationContext => ({
  ...LOADED,
  selectedLocationId: loc?.id ?? null,
  selectedLocation: loc,
});

/** The product tiles (each shows `Stock: n`). */
const tileButtons = () =>
  screen
    .queryAllByText(/^Stock: /)
    .map((el) => el.closest("button"))
    .filter((b): b is HTMLButtonElement => b !== null);

beforeEach(() => {
  jest.clearAllMocks();
  selectorProps = null;
  sheetProps = null;
  setWidth(1024);
  locationContext = at(MAIN);
  stockReply = {
    1: async () => ok({ inventory: STOCK[1] }),
    2: async () => ok({ inventory: STOCK[2] }),
  };
  fetchMock = jest.fn(async (input: unknown) => {
    const url = new URL(String(input), "http://x");
    if (url.pathname === "/api/products") return ok({ products: CATALOGUE });
    if (url.pathname === "/api/inventory/current-fast") {
      return stockReply[Number(url.searchParams.get("locationId"))]();
    }
    return ok({});
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  act(() => {
    useWorkbench.getState().clearOrder();
  });
});

afterAll(() => setWidth(1024));

// ---------------------------------------------------------------------------
// The location ladder's states, as the context reports them
// ---------------------------------------------------------------------------

type State = [label: string, list: Partial<LocationContext>, grid: string];
const NO_LOCATION_STATES: State[] = [
  ["loading", { locations: [], isLoading: true }, "Loading locations…"],
  ["failed, nothing loaded", { locations: [], loadFailed: true }, "Couldn't load locations."],
  ["zero locations", { locations: [] }, "No locations configured."],
  ["loaded, none selected", {}, "Choose a location to see products."],
];
const LADDER = NO_LOCATION_STATES.map(([, , sentence]) => sentence);

// ---------------------------------------------------------------------------
// F1-9: the selector is handed the location list's state
// ---------------------------------------------------------------------------

describe("F1-9 — the page hands the order rows the location list's state", () => {
  beforeEach(() => {
    act(() => {
      useWorkbench.getState().setOrderSource("wc-order");
    });
  });

  it.each(NO_LOCATION_STATES)("no location, %s: `noLocation` and the list's state", async (_label, list) => {
    locationContext = { ...at(null), ...list };
    renderPage();
    await waitFor(() => expect(selectorProps).not.toBeNull());
    expect(selectorProps!.noLocation).toBe(true);
    expect(selectorProps!.locationList).toEqual({
      isLoading: locationContext.isLoading,
      loadFailed: locationContext.loadFailed,
      count: locationContext.locations.length,
    });
  });

  it("on the phone's From Order tab too", async () => {
    setWidth(375);
    locationContext = { ...at(null), locations: [], isLoading: true };
    renderPage();
    await waitFor(() => expect(selectorProps).not.toBeNull());
    expect(selectorProps!.noLocation).toBe(true);
    expect(selectorProps!.locationList).toEqual({ isLoading: true, loadFailed: false, count: 0 });
  });
});

// ---------------------------------------------------------------------------
// F1-15: the product grid
// ---------------------------------------------------------------------------

describe("F1-15 — the product grid with no location: the location ladder", () => {
  it.each(NO_LOCATION_STATES)("%s: the grid says why, never `No products available`", async (_label, list, sentence) => {
    locationContext = { ...at(null), ...list };
    renderPage();
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    for (const other of LADDER.filter((s) => s !== sentence)) {
      expect(screen.queryByText(other)).toBeNull();
    }
    expect(screen.queryByText("No products available")).toBeNull();
    expect(screen.queryByText("Couldn't load products.")).toBeNull();
    expect(tileButtons()).toHaveLength(0);
    // No location, no stock read.
    expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/inventory/current-fast"))).toHaveLength(0);
  });

  it("the location going away never leaves the previous location's rows on screen", async () => {
    const { rerender } = renderPage();
    await waitFor(() => expect(tileButtons().length).toBe(2));

    locationContext = at(null);
    rerender();
    expect(await screen.findByText("Choose a location to see products.")).toBeInTheDocument();
    expect(tileButtons()).toHaveLength(0);
  });
});

describe("F1-15 — the product grid when the products read failed", () => {
  it("failed with nothing loaded: `Couldn't load products.` + Retry (refetchProducts), never `No products available`", async () => {
    stockReply[1] = async () => refused();
    renderPage();

    expect(await screen.findByText("Couldn't load products.")).toBeInTheDocument();
    expect(screen.getByText("Couldn't load products.")).toHaveClass("text-destructive");
    expect(screen.queryByText("No products available")).toBeNull();
    expect(screen.queryByText("No products match your filters")).toBeNull();
    const before = stockFetches(1).length;

    stockReply[1] = async () => ok({ inventory: STOCK[1] });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(stockFetches(1).length).toBe(before + 1));
    await waitFor(() => expect(tileButtons().length).toBe(2));
    expect(screen.queryByText("Couldn't load products.")).toBeNull();
  });

  it("a failed refresh over loaded rows keeps the rows (no failure sentence)", async () => {
    renderPage();
    await waitFor(() => expect(tileButtons().length).toBe(2));

    stockReply[1] = async () => refused();
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["inventory-products", 1] });
    });
    expect(qc.getQueryState(["inventory-products", 1, "baseNameNumeric", "asc"])?.status).toBe("error");
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

    expect(tileButtons()).toHaveLength(2);
    expect(screen.queryByText("Couldn't load products.")).toBeNull();
  });

  it("a successful empty answer still reads `No products available`", async () => {
    stockReply[1] = async () => ok({ inventory: [] });
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = new URL(String(input), "http://x");
      if (url.pathname === "/api/products") return ok({ products: [] });
      if (url.pathname === "/api/inventory/current-fast") return ok({ inventory: [] });
      return ok({});
    });
    renderPage();
    expect(await screen.findByText("No products available")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load products.")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F1-10: the null/null edge
// ---------------------------------------------------------------------------

describe("F1-10 — a cart built from no one location's rows, with no location selected (null/null)", () => {
  // Facelift FR1-3 (REV 6, GR-2 = OCR-6): with no location the order is not
  // "updating for the selected location" — that sentence (F1-10's original pin)
  // is gone; the location ladder says why Complete waits.
  const UPDATING_UNKNOWN = "Updating this order for the selected location…";
  const NO_LOCATION = "Choose a location to complete this order.";

  it("is not built here: Complete waits and says why", async () => {
    act(() => {
      useWorkbench.getState().selectExternalOrder(ORDER_X, MAIN_ROWS, null);
    });
    locationContext = at(null);
    renderPage();

    expect(await screen.findByText(NO_LOCATION)).toBeInTheDocument();
    expect(screen.queryByText(UPDATING_UNKNOWN)).toBeNull();
    expect(screen.getByRole("button", { name: "Complete & Fulfill" })).toBeDisabled();
    // Nothing was read, so nothing was rebuilt or cleared.
    await act(async () => {});
    expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/orders/external/"))).toHaveLength(0);
    expect(useWorkbench.getState().selectedExternalOrder?.builtAtLocationId).toBeNull();
  });

  it("the phone's sheet is told the same", async () => {
    setWidth(375);
    act(() => {
      useWorkbench.getState().selectExternalOrder(ORDER_X, MAIN_ROWS, null);
    });
    locationContext = at(null);
    renderPage();

    await waitFor(() => expect(sheetProps).not.toBeNull());
    expect(sheetProps!.canComplete).toBe(false);
    expect(sheetProps!.updatingNotice).toBe(NO_LOCATION);
    expect(sheetProps!.cartReadOnly).toBe(true);
  });

  it("a cart built here (Main at Main) is unchanged: Complete is live", async () => {
    act(() => {
      useWorkbench.getState().selectExternalOrder(ORDER_X, MAIN_ROWS, 1);
    });
    renderPage();
    await waitFor(() => expect(tileButtons().length).toBe(2));
    expect(screen.getByRole("button", { name: "Complete & Fulfill" })).toBeEnabled();
    expect(screen.queryByText(/^Updating this order/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F1-11: a picker confirm while the order is updating
// ---------------------------------------------------------------------------

describe("F1-11 — a picker confirm while the order is updating", () => {
  const UPDATING_INFO = "This order is updating — add items once it's done.";

  it("adds nothing, and says why", async () => {
    act(() => {
      useWorkbench.getState().selectExternalOrder(ORDER_X, MAIN_ROWS, 1);
    });
    const { rerender } = renderPage();
    await waitFor(() => expect(tileButtons().length).toBe(2));

    // The picker opens on Main's rows while the order is built here.
    fireEvent.click(tileButtons()[0]);
    expect(await screen.findByText("Select Quantity")).toBeInTheDocument();

    // The location changes under it: Overflow's stock never arrives, so the
    // order is updating.
    stockReply[2] = () => new Promise<Response>(() => {});
    locationContext = at(OVERFLOW);
    rerender();
    await waitFor(() => expect(screen.getByText("Updating this order for Overflow…")).toBeInTheDocument());
    const before = useWorkbench.getState().orderItems.map((i) => [i.product.id, i.quantity]);

    fireEvent.click(screen.getByRole("button", { name: "1" }));
    expect(toast.info).toHaveBeenCalledWith(UPDATING_INFO);
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(useWorkbench.getState().orderItems.map((i) => [i.product.id, i.quantity])).toEqual(before);
    // The picker closed, as it does on any confirm.
    await waitFor(() => expect(screen.queryByText("Select Quantity")).toBeNull());
  });

  it("not updating: the confirm adds, and the updating sentence is not shown", async () => {
    renderPage();
    await waitFor(() => expect(tileButtons().length).toBe(2));
    fireEvent.click(tileButtons()[0]);
    expect(await screen.findByText("Select Quantity")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "1" }));
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.info).not.toHaveBeenCalledWith(UPDATING_INFO);
    expect(useWorkbench.getState().orderItems).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Facelift FR1-3 (REV 6, GR-2 = OCR-6): no location is not "updating"
// ---------------------------------------------------------------------------

describe("FR1-3 — with no location, the page's notice, the sheet's notice and the picker's refusal say why", () => {
  const NO_LOCATION = "Choose a location to complete this order.";
  const UPDATING_ANY = /^Updating this order for /;
  const UPDATING_INFO = "This order is updating — add items once it's done.";

  // The location ladder's rungs, as the context reports them with nothing selected.
  const RUNGS: Array<[label: string, list: Partial<LocationContext>, sentence: string]> = [
    ["loading", { locations: [], isLoading: true }, "Loading locations…"],
    ["failed, nothing loaded", { locations: [], loadFailed: true }, "Couldn't load locations."],
    ["zero locations", { locations: [] }, "No locations configured."],
    ["loaded, none selected", {}, NO_LOCATION],
  ];

  it.each(RUNGS)("the page's notice (%s): the ladder, never an updating sentence; Complete disabled", async (_label, list, sentence) => {
    act(() => {
      useWorkbench.getState().selectExternalOrder(ORDER_X, MAIN_ROWS, 1);
    });
    locationContext = { ...at(null), ...list };
    renderPage();

    // The cart's notice (the grid states the same rung in its own, larger line).
    const notice = await screen.findByText(sentence, { selector: "p.text-xs" });
    expect(notice).toHaveClass("text-muted-foreground");
    expect(screen.queryByText(UPDATING_ANY)).toBeNull();
    expect(screen.getByRole("button", { name: "Complete & Fulfill" })).toBeDisabled();
  });

  it.each(RUNGS)("the sheet's notice (%s): the ladder; Complete disabled", async (_label, list, sentence) => {
    setWidth(375);
    act(() => {
      useWorkbench.getState().selectExternalOrder(ORDER_X, MAIN_ROWS, 1);
    });
    locationContext = { ...at(null), ...list };
    renderPage();

    await waitFor(() => expect(sheetProps).not.toBeNull());
    expect(sheetProps!.updatingNotice).toBe(sentence);
    expect(sheetProps!.canComplete).toBe(false);
  });

  it.each(RUNGS)("the picker's refusal (%s): the ladder as the toast, never the updating one", async (_label, list, sentence) => {
    act(() => {
      useWorkbench.getState().selectExternalOrder(ORDER_X, MAIN_ROWS, 1);
    });
    const { rerender } = renderPage();
    await waitFor(() => expect(tileButtons().length).toBe(2));
    fireEvent.click(tileButtons()[0]);
    expect(await screen.findByText("Select Quantity")).toBeInTheDocument();

    // The location goes away under the open picker.
    locationContext = { ...at(null), ...list };
    rerender();
    await waitFor(() => expect(screen.getByText(sentence, { selector: "p.text-xs" })).toBeInTheDocument());
    const before = useWorkbench.getState().orderItems.map((i) => [i.product.id, i.quantity]);

    fireEvent.click(screen.getByRole("button", { name: "1" }));
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith(sentence);
    expect(toast.info).not.toHaveBeenCalledWith(UPDATING_INFO);
    expect(useWorkbench.getState().orderItems.map((i) => [i.product.id, i.quantity])).toEqual(before);
  });

  it("with a location, the updating sentences are unchanged", async () => {
    act(() => {
      useWorkbench.getState().selectExternalOrder(ORDER_X, MAIN_ROWS, 1);
    });
    stockReply[2] = () => new Promise<Response>(() => {});
    locationContext = at(OVERFLOW);
    renderPage();
    expect(await screen.findByText("Updating this order for Overflow…")).toBeInTheDocument();
    expect(screen.queryByText(NO_LOCATION)).toBeNull();
  });
});
