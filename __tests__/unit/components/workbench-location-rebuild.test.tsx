/** @jest-environment jsdom */
//
// Facelift F0-1 (plan 2026-11-17-facelift-f0, folds (d) + (e)) — the PAGE's half.
//
// (e) OC1-1: "in stock here" is computed from the products array the page holds
// when the order is selected. After a location switch that array is first the
// OLD location's rows (placeholder data), then the new location's. So:
//   - selection waits while the products query is loading or on placeholder
//     data (the rows are disabled; the page's own handler refuses as well);
//   - a location change while a store order is selected REBUILDS the order once
//     the new location's products have arrived, and says so — including that
//     lines added by hand are gone (the rebuild replaces the cart).
// (d) The phone's cart button shows for an order that is all skipped lines, and
// the sheet gets the same `onItemMapped` the page's own alert gets.

import * as React from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
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

let locationContext: { selectedLocationId: number | null; selectedLocation: { name: string } | null };
jest.mock("@/contexts/location-context", () => ({
  useLocation: () => locationContext,
}));
jest.mock("@/hooks/use-locations", () => ({
  useLocations: () => ({ data: [], isLoading: false }),
}));

/** What the products query answers, per location id. */
type ProductsAnswer = {
  data: unknown[] | undefined;
  isLoading: boolean;
  isPlaceholderData: boolean;
  isSuccess: boolean;
};
let productsByLocation: Record<number, ProductsAnswer>;
jest.mock("@/hooks/use-inventory-products", () => ({
  useInventoryProducts: ({ locationId }: { locationId: number | null }) => ({
    ...(locationId !== null && productsByLocation[locationId]
      ? productsByLocation[locationId]
      : { data: undefined, isLoading: false, isPlaceholderData: false, isSuccess: false }),
    refetch: jest.fn(),
  }),
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
  onOrderSelected: (order: unknown) => void;
  stockLoading?: boolean;
};
let selectorProps: SelectorProps | null;
jest.mock("@/components/workbench/wc-order-selector", () => ({
  WCOrderSelector: (props: SelectorProps) => {
    selectorProps = props;
    return null;
  },
}));

type SheetProps = { onItemMapped?: () => void };
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

const LINE = {
  id: "it-cart",
  orderId: "ord-1",
  externalItemId: null,
  externalProductId: "wc-p-1",
  externalVariantId: null,
  name: "Widget 10mg",
  variantName: null,
  sku: "W-10",
  quantity: 2,
  fulfilledQty: 0,
  price: 10,
  productLinkId: "pl-1",
  isMapped: true,
  productLink: { internalProductId: 501, internalProduct: { id: 501 } },
} as unknown as ExternalItem;

const UNMAPPED_LINE = {
  ...LINE,
  id: "it-unmapped",
  name: "Mystery Peptide",
  isMapped: false,
  productLinkId: null,
  productLink: null,
} as unknown as ExternalItem;

const makeOrder = (items: ExternalItem[]): ExternalOrder =>
  ({
    id: "ord-1",
    companyId: "co-1",
    integrationId: "int-1",
    externalId: "9001",
    orderNumber: "9001",
    total: 1,
    customerName: "Ada L",
    internalStatus: "processing",
    items,
  }) as unknown as ExternalOrder;

/** Location 1 ("Main") has 10 of product 501; location 2 ("Overflow") has none. */
const MAIN_ROWS = [{ id: 501, name: "Widget 10mg", currentQuantity: 10 }] as unknown as ProductWithQuantity[];
const OVERFLOW_ROWS = [{ id: 501, name: "Widget 10mg", currentQuantity: 0 }] as unknown as ProductWithQuantity[];

const settled = (data: unknown[]): ProductsAnswer => ({
  data,
  isLoading: false,
  isPlaceholderData: false,
  isSuccess: true,
});
/** The previous location's rows, shown while the new location's are on their way. */
const placeholder = (data: unknown[]): ProductsAnswer => ({
  data,
  isLoading: false,
  isPlaceholderData: true,
  isSuccess: true,
});

const ORDER_URL = "/api/orders/external/ord-1";
let fetchMock: jest.Mock;
let freshOrder: ExternalOrder;

const orderFetches = () => fetchMock.mock.calls.filter((call) => String(call[0]) === ORDER_URL);

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ui = () => (
    <QueryClientProvider client={queryClient}>
      <WorkbenchPage />
    </QueryClientProvider>
  );
  const view = render(ui());
  return { rerender: () => view.rerender(ui()) };
}

/** FR1-1 (a): built at location 1 ("Main"), where the shell starts in these tests. */
function selectOrder(items: ExternalItem[], rows: ProductWithQuantity[]) {
  freshOrder = makeOrder(items);
  act(() => {
    useWorkbench.getState().selectExternalOrder(freshOrder, rows, 1);
  });
}

const setWidth = (width: number) =>
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });

beforeEach(() => {
  jest.clearAllMocks();
  selectorProps = null;
  sheetProps = null;
  setWidth(1024);
  locationContext = { selectedLocationId: 1, selectedLocation: { name: "Main" } };
  productsByLocation = { 1: settled(MAIN_ROWS) };
  freshOrder = makeOrder([LINE]);
  fetchMock = jest.fn(async (url: unknown) => {
    if (String(url) === ORDER_URL) {
      return { ok: true, json: async () => freshOrder } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  act(() => {
    useWorkbench.getState().clearOrder();
  });
});

afterAll(() => setWidth(1024));

/** Switch the shell's location to Overflow, whose rows are still on their way. */
function switchToOverflow(rerender: () => void) {
  locationContext = { selectedLocationId: 2, selectedLocation: { name: "Overflow" } };
  productsByLocation[2] = placeholder(MAIN_ROWS);
  rerender();
}

/** Overflow's own rows arrive. */
function overflowArrives(rerender: () => void) {
  productsByLocation[2] = settled(OVERFLOW_ROWS);
  rerender();
}

// ---------------------------------------------------------------------------
// (e) — the location-change rebuild
// ---------------------------------------------------------------------------

describe("F0-1 (e) — a location change rebuilds the selected store order", () => {
  it("waits for the new location's products, rebuilds from them, and says hand-added items went", async () => {
    selectOrder([LINE], MAIN_ROWS);
    act(() => {
      useWorkbench
        .getState()
        .addItem({ id: 777, name: "Manual Vial", currentQuantity: 9 } as unknown as ProductWithQuantity, 1, "manual");
    });
    const { rerender } = renderPage();

    switchToOverflow(rerender);
    // Placeholder rows are the OLD location's: nothing is rebuilt from them.
    expect(orderFetches()).toHaveLength(0);
    expect(toast.info).not.toHaveBeenCalled();

    overflowArrives(rerender);
    await waitFor(() => expect(orderFetches()).toHaveLength(1));
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "Location changed to Overflow — order 9001 was rebuilt with this location's stock. Items you added by hand were removed."
      )
    );

    // Rebuilt from Overflow's rows: nothing there, so the line is out of stock
    // HERE (never dropped), and the hand-added line is gone with the old cart.
    const state = useWorkbench.getState();
    expect(state.orderItems).toHaveLength(0);
    expect(state.unmappedExternalItems.map((i) => [i.externalItemId, i.class])).toEqual([
      ["it-cart", "out-of-stock"],
    ]);
  });

  it("with no hand-added lines, the toast stops at the rebuild", async () => {
    selectOrder([LINE], MAIN_ROWS);
    const { rerender } = renderPage();

    switchToOverflow(rerender);
    overflowArrives(rerender);

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "Location changed to Overflow — order 9001 was rebuilt with this location's stock."
      )
    );
    expect(orderFetches()).toHaveLength(1);
  });

  it("rebuilds exactly once per change (later renders do not refetch the order)", async () => {
    selectOrder([LINE], MAIN_ROWS);
    const { rerender } = renderPage();

    switchToOverflow(rerender);
    overflowArrives(rerender);
    await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(1));

    rerender();
    rerender();
    await act(async () => {});
    expect(orderFetches()).toHaveLength(1);
    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  // Orchestrator ruling on F0a deviation #1: a rebuild that fails must not
  // leave the cart built from the PREVIOUS location's stock under the new
  // location's name, and the after-mapping failure copy is untrue here. The
  // order is cleared, and the toast says so.
  const REBUILD_FAILED =
    "Location changed to Overflow — order 9001 couldn't be reloaded, so it was cleared. Select it again.";
  const AFTER_MAPPING = /after mapping/;

  it.each([
    [
      "the read is refused",
      async () => ({ ok: false, json: async () => ({}) }) as unknown as Response,
    ],
    [
      "the read never answers",
      async () => {
        throw new TypeError("Failed to fetch");
      },
    ],
  ])("a failed rebuild (%s) clears the order and says so — never the after-mapping copy", async (_label, answer) => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    selectOrder([LINE], MAIN_ROWS);
    const { rerender } = renderPage();

    fetchMock.mockImplementation(async (url: unknown) =>
      String(url) === ORDER_URL ? answer() : ({ ok: true, json: async () => ({}) } as unknown as Response)
    );
    switchToOverflow(rerender);
    overflowArrives(rerender);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(REBUILD_FAILED));
    const state = useWorkbench.getState();
    expect(state.selectedExternalOrder).toBeNull();
    expect(state.orderItems).toHaveLength(0);
    expect(state.unmappedExternalItems).toHaveLength(0);
    expect(toast.info).not.toHaveBeenCalled();
    for (const call of (toast.error as jest.Mock).mock.calls) {
      expect(String(call[0])).not.toMatch(AFTER_MAPPING);
    }
    consoleError.mockRestore();
  });

  it("does nothing for a manual cart", async () => {
    act(() => {
      useWorkbench.getState().addItem(MAIN_ROWS[0], 1, "manual");
    });
    const { rerender } = renderPage();

    switchToOverflow(rerender);
    overflowArrives(rerender);
    await act(async () => {});

    expect(orderFetches()).toHaveLength(0);
    expect(toast.info).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (e) — the selection gate
// ---------------------------------------------------------------------------

describe("F0-1 (e) — selection is blocked until this location's stock is here", () => {
  // The "From Order" tab is where the selector lives.
  beforeEach(() => {
    act(() => {
      useWorkbench.getState().setOrderSource("wc-order");
    });
  });

  it("on placeholder data the selector is told to wait, and the page refuses a selection", () => {
    const { rerender } = renderPage();
    switchToOverflow(rerender);

    expect(selectorProps?.stockLoading).toBe(true);
    act(() => {
      selectorProps!.onOrderSelected(makeOrder([LINE]));
    });
    expect(useWorkbench.getState().selectedExternalOrder).toBeNull();
  });

  it("on the first load the selector waits too", () => {
    productsByLocation = {
      1: { data: undefined, isLoading: true, isPlaceholderData: false, isSuccess: false },
    };
    renderPage();

    expect(selectorProps?.stockLoading).toBe(true);
  });

  it("once the rows have arrived, a selection builds from them", () => {
    const { rerender } = renderPage();
    switchToOverflow(rerender);
    overflowArrives(rerender);

    expect(selectorProps?.stockLoading).toBe(false);
    act(() => {
      selectorProps!.onOrderSelected(makeOrder([LINE]));
    });
    const state = useWorkbench.getState();
    expect(state.selectedExternalOrder?.orderNumber).toBe("9001");
    // Built from Overflow's rows, where there is none of it.
    expect(state.unmappedExternalItems.map((i) => i.class)).toEqual(["out-of-stock"]);
  });
});

// ---------------------------------------------------------------------------
// (d) — the phone's cart button and sheet wiring
// ---------------------------------------------------------------------------

describe("F0-1 (d) — the phone", () => {
  beforeEach(() => setWidth(375));

  it("the cart button shows for an all-skipped store order", async () => {
    selectOrder([UNMAPPED_LINE], MAIN_ROWS);
    renderPage();

    // The sr-only label (the button's accessible name also carries the badge).
    const label = await screen.findByText("View order (0 items, 1 not deducted)");
    expect(label.closest("button")).toHaveTextContent(/^!/);
  });

  it("a manual cart shows it exactly as today", async () => {
    act(() => {
      useWorkbench.getState().addItem(MAIN_ROWS[0], 1, "manual");
    });
    renderPage();

    const label = await screen.findByText("View cart (1 items)");
    expect(label.closest("button")).toHaveTextContent(/^1View cart/);
  });

  it("a failed refetch AFTER MAPPING keeps its own copy and leaves the order in place", async () => {
    selectOrder([UNMAPPED_LINE], MAIN_ROWS);
    renderPage();
    await waitFor(() => expect(sheetProps).not.toBeNull());
    fetchMock.mockImplementation(async () => ({ ok: false, json: async () => ({}) }) as unknown as Response);

    await act(async () => {
      sheetProps!.onItemMapped?.();
    });
    expect(toast.error).toHaveBeenCalledWith("Could not refresh order after mapping. Please reselect.");
    expect(useWorkbench.getState().selectedExternalOrder?.orderNumber).toBe("9001");
  });

  it("the sheet's onItemMapped is the page's order refetch", async () => {
    selectOrder([UNMAPPED_LINE], MAIN_ROWS);
    renderPage();
    await waitFor(() => expect(sheetProps).not.toBeNull());

    await act(async () => {
      sheetProps!.onItemMapped?.();
    });
    expect(orderFetches()).toHaveLength(1);
  });
});
