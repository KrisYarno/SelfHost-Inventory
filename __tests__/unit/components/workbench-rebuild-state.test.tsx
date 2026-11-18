/** @jest-environment jsdom */
//
// Facelift F0 FR1-1 (plan 2026-11-17-facelift-f0, REV 5) — the workbench's cart
// always describes the location it will deduct from. CRITICAL: this cart feeds
// the fulfil and deduct requests.
//
// Before (F0a): the page noticed a location CHANGE with a ref, so an order the
// store kept from another page (the order outlives the page; the location can
// change anywhere) was never rebuilt; "stock arrived" counted a cached
// location's rows while they were still being re-read; Complete stayed live
// while the cart described another location; a failed stock read left the
// order waiting forever; and a rebuild's order read that resolved after the
// operator had moved on (cleared, picked another order, switched to Manual)
// replaced their cart, or cleared it.
//
// Now: `builtAtLocationId` is recorded on the order and the rebuild is a STATE
// (`builtAtLocationId !== selectedLocationId`); stock has arrived only when this
// location's own rows are here and no read is in flight; Complete waits, and
// says why; a failed stock read clears the order; and the order read is
// latest-wins — a stale answer does nothing at all.
//
// These pins drive the REAL products hook on a REAL QueryClient (GR-12): what
// "placeholder", "cached" and "fetching" mean here is react-query's, not a mock's.

import * as React from "react";
import { render, screen, act, waitFor, within, fireEvent } from "@testing-library/react";
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
const BACK: Loc = { id: 3, name: "Back" };
let locationContext: { selectedLocationId: number | null; selectedLocation: Loc | null };
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

let dialogOpen: boolean;
jest.mock("@/components/workbench/complete-order-dialog", () => ({
  CompleteOrderDialog: ({ open }: { open: boolean }) => {
    dialogOpen = open;
    return null;
  },
}));
jest.mock("@/components/workbench/order-queue", () => ({ OrderQueue: () => null }));
jest.mock("@/components/products/product-map-dialog", () => ({ ProductMapDialog: () => null }));

type SelectorProps = {
  onOrderSelected: (order: unknown) => void;
  onClear: () => void;
  stockLoading?: boolean;
  stockFailed?: boolean;
  noLocation?: boolean;
  onRetryStock?: () => unknown;
};
let selectorProps: SelectorProps | null;
jest.mock("@/components/workbench/wc-order-selector", () => ({
  WCOrderSelector: (props: SelectorProps) => {
    selectorProps = props;
    return null;
  },
}));

type SheetProps = {
  canComplete: boolean;
  updatingNotice?: string | null;
  cartReadOnly?: boolean;
  onCompleteOrder: () => void;
  onItemMapped?: () => void;
};
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
import { queryClient as appQueryClient } from "@/lib/query-client";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type ExternalItem = NonNullable<ExternalOrder["items"]>[number];

const lineFor = (orderId: string, id: string, productId: number, quantity: number, name: string) =>
  ({
    id,
    orderId,
    externalItemId: null,
    externalProductId: `wc-${id}`,
    externalVariantId: null,
    name,
    variantName: null,
    sku: null,
    quantity,
    fulfilledQty: 0,
    price: 10,
    productLinkId: `pl-${id}`,
    isMapped: true,
    productLink: { internalProductId: productId, internalProduct: { id: productId } },
  }) as unknown as ExternalItem;

const makeOrder = (id: string, orderNumber: string, items: ExternalItem[]): ExternalOrder =>
  ({
    id,
    companyId: "co-1",
    integrationId: "int-1",
    externalId: orderNumber,
    orderNumber,
    total: 1,
    customerName: "Ada L",
    internalStatus: "processing",
    items,
  }) as unknown as ExternalOrder;

/** Order X needs 2 of product 501; order Y needs 1 of product 502. */
const ORDER_X = makeOrder("ord-x", "9001", [lineFor("ord-x", "x-1", 501, 2, "Widget 10mg")]);
const ORDER_Y = makeOrder("ord-y", "9002", [lineFor("ord-y", "y-1", 502, 1, "Gadget 5mg")]);

const CATALOGUE = [
  { id: 501, name: "Widget 10mg" },
  { id: 502, name: "Gadget 5mg" },
];
/** Main has 10 of 501 and 4 of 502; Overflow has 5 of 501 and 3 of 502; Back has 1 of 501. */
const STOCK: Record<number, { productId: number; quantity: number; version: number }[]> = {
  1: [
    { productId: 501, quantity: 10, version: 1 },
    { productId: 502, quantity: 4, version: 1 },
  ],
  2: [
    { productId: 501, quantity: 5, version: 1 },
    { productId: 502, quantity: 3, version: 1 },
  ],
  3: [{ productId: 501, quantity: 1, version: 1 }],
};
const MAIN_ROWS = [
  { id: 501, name: "Widget 10mg", currentQuantity: 10 },
  { id: 502, name: "Gadget 5mg", currentQuantity: 4 },
] as unknown as ProductWithQuantity[];

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const refused = () =>
  ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }) as unknown as Response;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Harness: a router over fetch, so each test can answer, hold or refuse a read.
// ---------------------------------------------------------------------------

let stockReply: Record<number, () => Promise<Response>>;
let orderReply: Record<string, () => Promise<Response>>;
let fetchMock: jest.Mock;

const stockFetches = (locationId: number) =>
  fetchMock.mock.calls.filter(
    ([u]) => String(u) === `/api/inventory/current-fast?locationId=${locationId}`
  );
const orderFetches = (id = "ord-x") =>
  fetchMock.mock.calls.filter(([u]) => String(u) === `/api/orders/external/${id}`);

let qc: QueryClient;
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
function renderPage(client: QueryClient = newClient()) {
  qc = client;
  const ui = () => (
    <QueryClientProvider client={qc}>
      <WorkbenchPage />
    </QueryClientProvider>
  );
  const view = render(ui());
  return { rerender: () => view.rerender(ui()), unmount: () => view.unmount() };
}

const setWidth = (width: number) =>
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });

function moveTo(loc: Loc, rerender: () => void) {
  locationContext = { selectedLocationId: loc.id, selectedLocation: loc };
  rerender();
}

const completeButton = () => screen.getByRole("button", { name: "Complete & Fulfill" });
const UPDATING_OVERFLOW = "Updating this order for Overflow…";
const REBUILT_OVERFLOW = "Location changed to Overflow — order 9001 was rebuilt with this location's stock.";
const CLEARED_OVERFLOW =
  "Location changed to Overflow — order 9001 couldn't be reloaded, so it was cleared. Select it again.";

/** Built at Main, from Main's rows. */
function selectXAtMain() {
  act(() => {
    useWorkbench.getState().selectExternalOrder(ORDER_X, MAIN_ROWS, 1);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  selectorProps = null;
  sheetProps = null;
  dialogOpen = false;
  setWidth(1024);
  locationContext = { selectedLocationId: 1, selectedLocation: MAIN };
  stockReply = {
    1: async () => ok({ inventory: STOCK[1] }),
    2: async () => ok({ inventory: STOCK[2] }),
    3: async () => ok({ inventory: STOCK[3] }),
  };
  orderReply = {
    "ord-x": async () => ok(ORDER_X),
    "ord-y": async () => ok(ORDER_Y),
  };
  fetchMock = jest.fn(async (input: unknown) => {
    const url = new URL(String(input), "http://x");
    if (url.pathname === "/api/products") return ok({ products: CATALOGUE });
    if (url.pathname === "/api/inventory/current-fast") {
      return stockReply[Number(url.searchParams.get("locationId"))]();
    }
    if (url.pathname.startsWith("/api/orders/external/")) {
      return orderReply[url.pathname.split("/").pop() as string]();
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
// (a) + (b) + (d): the rebuild is a state, and Complete waits for it
// ---------------------------------------------------------------------------

describe("FR1-1 — an order built at another location is rebuilt, even on mount", () => {
  it("mounting with an order built at Main while the shell says Overflow: exactly one rebuild, Complete disabled until it lands", async () => {
    selectXAtMain();
    locationContext = { selectedLocationId: 2, selectedLocation: OVERFLOW };
    const stock = deferred<Response>();
    stockReply[2] = () => stock.promise;
    const order = deferred<Response>();
    orderReply["ord-x"] = () => order.promise;
    const { rerender } = renderPage();

    // Overflow's stock is still on its way: nothing is rebuilt, nothing completes.
    await waitFor(() => expect(stockFetches(2)).toHaveLength(1));
    expect(orderFetches()).toHaveLength(0);
    expect(completeButton()).toBeDisabled();
    expect(screen.getByText(UPDATING_OVERFLOW)).toBeInTheDocument();

    // The stock arrives: ONE rebuild goes out, and Complete still waits for it.
    await act(async () => stock.resolve(ok({ inventory: STOCK[2] })));
    await waitFor(() => expect(orderFetches()).toHaveLength(1));
    rerender();
    await act(async () => {});
    expect(orderFetches()).toHaveLength(1);
    expect(completeButton()).toBeDisabled();
    expect(screen.getByText(UPDATING_OVERFLOW)).toBeInTheDocument();

    await act(async () => order.resolve(ok(ORDER_X)));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(REBUILT_OVERFLOW));
    const state = useWorkbench.getState();
    expect(state.selectedExternalOrder?.builtAtLocationId).toBe(2);
    expect(state.selectedExternalOrder?.builtCartCount).toBe(1);
    // Built from Overflow's rows (5 of 501 there).
    expect(state.orderItems.map((i) => [i.product.id, i.product.currentQuantity, i.quantity])).toEqual([
      [501, 5, 2],
    ]);
    await waitFor(() => expect(completeButton()).toBeEnabled());
    expect(screen.queryByText(UPDATING_OVERFLOW)).toBeNull();

    rerender();
    rerender();
    await act(async () => {});
    expect(orderFetches()).toHaveLength(1);
    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  it("while it waits, Complete refuses even when asked directly (the phone sheet's handler)", async () => {
    setWidth(375);
    selectXAtMain();
    locationContext = { selectedLocationId: 2, selectedLocation: OVERFLOW };
    stockReply[2] = () => new Promise<Response>(() => {});
    renderPage();

    await waitFor(() => expect(sheetProps).not.toBeNull());
    expect(sheetProps!.canComplete).toBe(false);
    expect(sheetProps!.updatingNotice).toBe(UPDATING_OVERFLOW);
    act(() => {
      sheetProps!.onCompleteOrder();
    });
    expect(dialogOpen).toBe(false);
  });

  it("the phone sheet gets Complete back, and loses the notice, once the rebuild lands", async () => {
    setWidth(375);
    selectXAtMain();
    locationContext = { selectedLocationId: 2, selectedLocation: OVERFLOW };
    renderPage();

    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(REBUILT_OVERFLOW));
    await waitFor(() => expect(sheetProps!.canComplete).toBe(true));
    expect(sheetProps!.updatingNotice).toBeNull();
    act(() => {
      sheetProps!.onCompleteOrder();
    });
    expect(dialogOpen).toBe(true);
  });

  it("an order built HERE is left alone: no rebuild, Complete live, no notice", async () => {
    selectXAtMain();
    renderPage();

    await waitFor(() => expect(stockFetches(1).length).toBeGreaterThan(0));
    await act(async () => {});
    expect(orderFetches()).toHaveLength(0);
    expect(completeButton()).toBeEnabled();
    expect(screen.queryByText(/^Updating this order/)).toBeNull();
  });
});

describe("FR1-1 (a)/(f) — the location changes AGAIN while a rebuild's order read is out", () => {
  it("the read lands on rows that are not the new location's: the order is never stamped with it, and its own rebuild speaks", async () => {
    selectXAtMain();
    const firstRead = deferred<Response>();
    const reads = [firstRead.promise];
    orderReply["ord-x"] = () => reads.shift() ?? Promise.resolve(ok(ORDER_X));
    const { rerender } = renderPage();
    await waitFor(() => expect(stockFetches(1).length).toBeGreaterThan(0));

    moveTo(OVERFLOW, rerender);
    await waitFor(() => expect(orderFetches()).toHaveLength(1));

    // On to Back, whose rows are still on their way (Overflow's are shown as placeholder).
    const backStock = deferred<Response>();
    stockReply[3] = () => backStock.promise;
    moveTo(BACK, rerender);
    await waitFor(() => expect(stockFetches(3)).toHaveLength(1));

    await act(async () => firstRead.resolve(ok(ORDER_X)));
    await act(async () => {});
    // Built from rows that are not Back's: never stamped Back, still pending.
    const mid = useWorkbench.getState().selectedExternalOrder;
    expect(mid?.builtAtLocationId).not.toBe(3);
    expect(mid?.builtAtLocationId).not.toBe(2);
    expect(toast.info).not.toHaveBeenCalled();
    expect(completeButton()).toBeDisabled();
    expect(screen.getByText("Updating this order for Back…")).toBeInTheDocument();

    await act(async () => backStock.resolve(ok({ inventory: STOCK[3] })));
    await waitFor(() => expect(orderFetches()).toHaveLength(2));
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "Location changed to Back — order 9001 was rebuilt with this location's stock."
      )
    );
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(useWorkbench.getState().selectedExternalOrder?.builtAtLocationId).toBe(3);
    // Back has 1 of 501: the line is capped there, from Back's own rows.
    expect(useWorkbench.getState().orderItems.map((i) => [i.product.currentQuantity, i.quantity])).toEqual([[1, 1]]);
  });
});

// ---------------------------------------------------------------------------
// (c): a failed stock read clears the order
// ---------------------------------------------------------------------------

describe("FR1-1 (c) — the new location's stock read fails with nothing loaded", () => {
  it("the order is cleared and the failure toast says so; no order read goes out", async () => {
    selectXAtMain();
    const { rerender } = renderPage();
    await waitFor(() => expect(stockFetches(1).length).toBeGreaterThan(0));

    stockReply[2] = async () => refused();
    moveTo(OVERFLOW, rerender);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(CLEARED_OVERFLOW));
    const state = useWorkbench.getState();
    expect(state.selectedExternalOrder).toBeNull();
    expect(state.orderItems).toHaveLength(0);
    expect(state.unmappedExternalItems).toHaveLength(0);
    expect(orderFetches()).toHaveLength(0);
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// (c), the orchestrator's ruling on interpretation 5: the read ENDS in error
// with nothing in flight — with or without cached rows — and the order is
// cleared. Never an "Updating this order…" line standing over no read at all.
// ---------------------------------------------------------------------------

describe("FR1-1 (c), ruled — a cached location's re-read fails", () => {
  it("the products query ends in error over its cached rows: cleared + the failure toast, no order read", async () => {
    selectXAtMain();
    const { rerender } = renderPage();
    await waitFor(() => expect(stockFetches(1).length).toBeGreaterThan(0));

    // To Overflow (rebuilt there), so Main's rows are cached and the order is not Main's.
    moveTo(OVERFLOW, rerender);
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(REBUILT_OVERFLOW));
    await waitFor(() => expect(useWorkbench.getState().selectedExternalOrder?.builtAtLocationId).toBe(2));
    const ordersBefore = orderFetches().length;

    // Back to Main: its cached rows are re-read, and the re-read fails.
    stockReply[1] = async () => refused();
    moveTo(MAIN, rerender);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Location changed to Main — order 9001 couldn't be reloaded, so it was cleared. Select it again."
      )
    );
    const mainKey = ["inventory-products", 1, "baseNameNumeric", "asc"];
    expect(qc.getQueryState(mainKey)?.status).toBe("error");
    expect(qc.getQueryState(mainKey)?.data).toBeDefined();
    const state = useWorkbench.getState();
    expect(state.selectedExternalOrder).toBeNull();
    expect(state.orderItems).toHaveLength(0);
    expect(state.unmappedExternalItems).toHaveLength(0);
    expect(orderFetches()).toHaveLength(ordersBefore);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/^Updating this order/)).toBeNull();
  });
});

describe("FR1-1 (c), ruled — an errored read that is being read AGAIN is not a failure yet", () => {
  it("mounting on a location whose cached rows are in error and being re-read: wait, then rebuild on success (no clear)", async () => {
    // Overflow's rows are cached, and their last refresh failed: error WITH data.
    const client = newClient();
    const overflowKey = ["inventory-products", 2, "baseNameNumeric", "asc"];
    client.setQueryData(overflowKey, MAIN_ROWS);
    await client
      .fetchQuery({ queryKey: overflowKey, queryFn: () => Promise.reject(new Error("boom")), staleTime: 0 })
      .catch(() => {});
    expect(client.getQueryState(overflowKey)?.status).toBe("error");

    selectXAtMain();
    locationContext = { selectedLocationId: 2, selectedLocation: OVERFLOW };
    const reread = deferred<Response>();
    stockReply[2] = () => reread.promise;
    renderPage(client);

    // The page re-reads Overflow on mount: an error with a read in flight waits.
    await waitFor(() => expect(stockFetches(2)).toHaveLength(1));
    await act(async () => {});
    expect(qc.getQueryState(overflowKey)?.status).toBe("error");
    expect(useWorkbench.getState().selectedExternalOrder?.id).toBe("ord-x");
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByText(UPDATING_OVERFLOW)).toBeInTheDocument();

    await act(async () => reread.resolve(ok({ inventory: STOCK[2] })));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(REBUILT_OVERFLOW));
    expect(useWorkbench.getState().selectedExternalOrder?.builtAtLocationId).toBe(2);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (b): a cached location's rows are not "arrived" while they are re-read
// ---------------------------------------------------------------------------

describe("FR1-1 (b) — a cached location re-visited", () => {
  it("no rebuild until its rows have been re-read (!isFetching)", async () => {
    selectXAtMain();
    const { rerender } = renderPage();
    await waitFor(() => expect(stockFetches(1).length).toBeGreaterThan(0));

    // To Overflow and back: the order is rebuilt at Overflow, and Main's rows
    // stay in the cache.
    moveTo(OVERFLOW, rerender);
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(REBUILT_OVERFLOW));
    await waitFor(() => expect(useWorkbench.getState().selectedExternalOrder?.builtAtLocationId).toBe(2));
    const ordersBefore = orderFetches().length;

    const reread = deferred<Response>();
    stockReply[1] = () => reread.promise;
    moveTo(MAIN, rerender);

    // Main's cached rows are on screen, but they are being re-read: wait.
    await waitFor(() => expect(stockFetches(1).length).toBeGreaterThan(1));
    await act(async () => {});
    expect(orderFetches()).toHaveLength(ordersBefore);
    expect(completeButton()).toBeDisabled();
    expect(screen.getByText("Updating this order for Main…")).toBeInTheDocument();

    await act(async () => reread.resolve(ok({ inventory: STOCK[1] })));
    await waitFor(() => expect(orderFetches()).toHaveLength(ordersBefore + 1));
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "Location changed to Main — order 9001 was rebuilt with this location's stock."
      )
    );
    expect(useWorkbench.getState().selectedExternalOrder?.builtAtLocationId).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (f): latest wins — a stale order read does NOTHING
// ---------------------------------------------------------------------------

describe("FR1-1 (f) — a rebuild's order read that resolves after the operator moved on", () => {
  /** Rebuild X at Overflow with its order read HELD; returns the release. */
  async function rebuildHeld() {
    selectXAtMain();
    const held = deferred<Response>();
    orderReply["ord-x"] = () => held.promise;
    const { rerender } = renderPage();
    await waitFor(() => expect(stockFetches(1).length).toBeGreaterThan(0));
    moveTo(OVERFLOW, rerender);
    await waitFor(() => expect(orderFetches()).toHaveLength(1));
    return { held, rerender };
  }

  it.each([
    ["success", () => ok(ORDER_X)],
    ["failure", () => refused()],
  ])("clear, select Y, release with %s: Y stays, no toast, no clear", async (_label, answer) => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    const { held } = await rebuildHeld();

    act(() => {
      selectorProps!.onClear();
    });
    expect(useWorkbench.getState().selectedExternalOrder).toBeNull();
    await waitFor(() => expect(selectorProps).not.toBeNull());
    act(() => {
      selectorProps!.onOrderSelected(ORDER_Y);
    });
    const y = useWorkbench.getState();
    expect(y.selectedExternalOrder?.id).toBe("ord-y");
    expect(y.selectedExternalOrder?.builtAtLocationId).toBe(2);
    // Y does not wait on X's stale read.
    await waitFor(() => expect(completeButton()).toBeEnabled());

    await act(async () => held.resolve(answer()));
    await act(async () => {});

    const after = useWorkbench.getState();
    expect(after.selectedExternalOrder?.id).toBe("ord-y");
    expect(after.orderItems.map((i) => i.fulfillmentItemId)).toEqual(["y-1"]);
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(completeButton()).toBeEnabled();
    consoleError.mockRestore();
  });

  it("the read that THROWS after the operator moved on is just as silent", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    const { held } = await rebuildHeld();

    act(() => {
      selectorProps!.onClear();
    });
    act(() => {
      selectorProps!.onOrderSelected(ORDER_Y);
    });
    await act(async () => held.reject(new TypeError("Failed to fetch")));
    await act(async () => {});

    expect(useWorkbench.getState().selectedExternalOrder?.id).toBe("ord-y");
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it.each([
    ["success", () => ok(ORDER_X)],
    ["failure", () => refused()],
  ])("switch to Manual and add a hand line, release with %s: the hand line stays, no toast", async (_label, answer) => {
    const { held } = await rebuildHeld();

    act(() => {
      useWorkbench.getState().setOrderSource("manual");
      useWorkbench
        .getState()
        .addItem({ id: 777, name: "Manual Vial", currentQuantity: 9 } as unknown as ProductWithQuantity, 1, "manual");
    });

    await act(async () => held.resolve(answer()));
    await act(async () => {});

    const after = useWorkbench.getState();
    expect(after.selectedExternalOrder).toBeNull();
    expect(after.orderSource).toBe("manual");
    expect(after.orderItems.map((i) => [i.product.id, i.quantity, i.source])).toEqual([[777, 1, "manual"]]);
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("two after-mapping reads: the older one, resolving last, does not overwrite the newer", async () => {
    setWidth(375);
    selectXAtMain();
    renderPage();
    await waitFor(() => expect(sheetProps).not.toBeNull());
    await waitFor(() => expect(stockFetches(1).length).toBeGreaterThan(0));

    const older = deferred<Response>();
    const newer = deferred<Response>();
    const queue = [older, newer];
    orderReply["ord-x"] = () => queue.shift()!.promise;

    await act(async () => {
      void sheetProps!.onItemMapped?.();
    });
    await act(async () => {
      void sheetProps!.onItemMapped?.();
    });
    expect(orderFetches()).toHaveLength(2);

    // The newer answer: the line is now 3. The older one still says 2.
    const NEWER_X = makeOrder("ord-x", "9001", [lineFor("ord-x", "x-1", 501, 3, "Widget 10mg")]);
    await act(async () => newer.resolve(ok(NEWER_X)));
    await waitFor(() => expect(useWorkbench.getState().orderItems[0]?.quantity).toBe(3));

    await act(async () => older.resolve(ok(ORDER_X)));
    await act(async () => {});
    expect(useWorkbench.getState().orderItems[0]?.quantity).toBe(3);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (e): selection is refused unless stock arrived
// ---------------------------------------------------------------------------

describe("FR1-1 (e) — the order rows and the page's selection gate", () => {
  beforeEach(() => {
    act(() => {
      useWorkbench.getState().setOrderSource("wc-order");
    });
  });

  it("a failed stock read with nothing loaded: the rows are told it failed, and the page refuses a selection", async () => {
    stockReply[1] = async () => refused();
    renderPage();

    await waitFor(() => expect(selectorProps?.stockFailed).toBe(true));
    expect(selectorProps?.stockLoading).toBe(false);
    act(() => {
      selectorProps!.onOrderSelected(ORDER_X);
    });
    expect(useWorkbench.getState().selectedExternalOrder).toBeNull();
  });

  it("while this location's rows are being re-read, the rows wait and the page refuses a selection", async () => {
    renderPage();
    await waitFor(() => expect(selectorProps?.stockLoading).toBe(false));

    const reread = deferred<Response>();
    stockReply[1] = () => reread.promise;
    await act(async () => {
      void qc.refetchQueries({ queryKey: ["inventory-products"] });
    });
    await waitFor(() => expect(selectorProps?.stockLoading).toBe(true));
    act(() => {
      selectorProps!.onOrderSelected(ORDER_X);
    });
    expect(useWorkbench.getState().selectedExternalOrder).toBeNull();

    await act(async () => reread.resolve(ok({ inventory: STOCK[1] })));
    await waitFor(() => expect(selectorProps?.stockLoading).toBe(false));
    act(() => {
      selectorProps!.onOrderSelected(ORDER_X);
    });
    expect(useWorkbench.getState().selectedExternalOrder?.builtAtLocationId).toBe(1);
  });
});

// ===========================================================================
// Facelift F0 FR2 (plan 2026-11-17-facelift-f0, REV 7) — staleness is scoped
// to the SELECTION, not the order id (F0-QA-1 = F0-FD1-2, FD1-1).
//
// FR1's latest-wins guard compared the ORDER ID. So a clear-and-reselect of
// the SAME order, or a read issued by a page instance that has since
// unmounted, was not stale: Complete stayed blocked on a cart just built here
// (A1); a late failure cleared the good re-selection (A2); a late success put
// back a quantity the packer lowered (A3: a packer who packed 1 could deduct
// 2); and an old page's read cleared the new page's order (B1). Now every
// order read captures the store's `selectionSeq` and is stale once it moves,
// or once its page has unmounted; a flip-back to the cart's own location
// invalidates the read in flight; and the cart is read-only while it updates.
// ===========================================================================

describe("FR2-1 — a clear-and-reselect of the SAME order is a new selection", () => {
  /** X built at Main, then rebuilt at Overflow with the rebuild's order read HELD. */
  async function rebuildHeldAtOverflow() {
    selectXAtMain();
    const held = deferred<Response>();
    const reads = [held.promise];
    orderReply["ord-x"] = () => reads.shift() ?? Promise.resolve(ok(ORDER_X));
    const { rerender } = renderPage();
    await waitFor(() => expect(stockFetches(1).length).toBeGreaterThan(0));
    moveTo(OVERFLOW, rerender);
    await waitFor(() => expect(orderFetches()).toHaveLength(1));
    expect(completeButton()).toBeDisabled();
    return { held };
  }

  /** The operator clears X, goes back to the From Order tab and picks X again, at Overflow. */
  async function clearAndReselectX() {
    act(() => {
      selectorProps!.onClear();
    });
    act(() => {
      useWorkbench.getState().setOrderSource("wc-order");
    });
    await waitFor(() => expect(selectorProps?.stockLoading).toBe(false));
    act(() => {
      selectorProps!.onOrderSelected(ORDER_X);
    });
    const state = useWorkbench.getState();
    expect(state.selectedExternalOrder?.id).toBe("ord-x");
    expect(state.selectedExternalOrder?.builtAtLocationId).toBe(2);
  }

  it("A1: Complete is live at once on the cart just built here — it does not wait on the stale read", async () => {
    await rebuildHeldAtOverflow();
    await clearAndReselectX();
    await act(async () => {});

    // The old read is still out, and holds nothing up.
    expect(completeButton()).toBeEnabled();
    expect(screen.queryByText(UPDATING_OVERFLOW)).toBeNull();
  });

  it("A2: a late FAILURE of the old read does not clear the good re-selection", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    const { held } = await rebuildHeldAtOverflow();
    await clearAndReselectX();

    await act(async () => held.resolve(refused()));
    await act(async () => {});

    const after = useWorkbench.getState();
    expect(after.selectedExternalOrder?.id).toBe("ord-x");
    expect(after.selectedExternalOrder?.builtAtLocationId).toBe(2);
    expect(after.orderItems.map((i) => [i.fulfillmentItemId, i.quantity])).toEqual([["x-1", 2]]);
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    expect(completeButton()).toBeEnabled();
    consoleError.mockRestore();
  });

  it("A3: a late SUCCESS does not put back a quantity the packer lowered", async () => {
    const { held } = await rebuildHeldAtOverflow();
    await clearAndReselectX();

    // The packer packed 1 of the 2.
    act(() => {
      useWorkbench.getState().updateItemQuantity(501, 1, "x-1");
    });
    expect(useWorkbench.getState().orderItems[0]?.quantity).toBe(1);

    await act(async () => held.resolve(ok(ORDER_X)));
    await act(async () => {});

    // Still 1: the deduction says what was packed, not what the stale read built.
    expect(useWorkbench.getState().orderItems.map((i) => [i.fulfillmentItemId, i.quantity])).toEqual([
      ["x-1", 1],
    ]);
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("FR2-1 (B1) — a read issued by a page instance that has unmounted", () => {
  it.each([
    ["failure", () => refused()],
    ["success", () => ok(ORDER_X)],
  ])("its late %s does nothing to the order the next page instance shows", async (_label, answer) => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    // X was built at Main; the shell already says Overflow when the page opens.
    selectXAtMain();
    locationContext = { selectedLocationId: 2, selectedLocation: OVERFLOW };
    const oldRead = deferred<Response>();
    const reads = [oldRead.promise];
    orderReply["ord-x"] = () => reads.shift() ?? Promise.resolve(ok(ORDER_X));

    // The first page instance issues the rebuild's read, then the operator leaves.
    const client = newClient();
    const first = renderPage(client);
    await waitFor(() => expect(orderFetches()).toHaveLength(1));
    first.unmount();

    // The next instance rebuilds the order for itself.
    renderPage(client);
    await waitFor(() => expect(orderFetches()).toHaveLength(2));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(REBUILT_OVERFLOW));
    expect(useWorkbench.getState().selectedExternalOrder?.builtAtLocationId).toBe(2);

    // The old page's read lands now.
    await act(async () => oldRead.resolve(answer()));
    await act(async () => {});

    const after = useWorkbench.getState();
    expect(after.selectedExternalOrder?.id).toBe("ord-x");
    expect(after.selectedExternalOrder?.builtAtLocationId).toBe(2);
    expect(after.orderItems.map((i) => i.fulfillmentItemId)).toEqual(["x-1"]);
    expect(toast.error).not.toHaveBeenCalled();
    // Only the new page's own rebuild spoke.
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(completeButton()).toBeEnabled();
    consoleError.mockRestore();
  });
});

describe("FR2-1 (B1) — the old page's read lands BEFORE the next instance has rebuilt", () => {
  // Nothing has changed the selection yet (the new page is still waiting for
  // Overflow's rows), so only the dead page tells this read apart.
  it.each([
    ["failure", () => refused()],
    ["success", () => ok(ORDER_X)],
  ])("its %s does nothing; the new page then rebuilds for itself", async (_label, answer) => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    selectXAtMain();
    locationContext = { selectedLocationId: 2, selectedLocation: OVERFLOW };
    const oldRead = deferred<Response>();
    const reads = [oldRead.promise];
    orderReply["ord-x"] = () => reads.shift() ?? Promise.resolve(ok(ORDER_X));

    const client = newClient();
    const first = renderPage(client);
    await waitFor(() => expect(orderFetches()).toHaveLength(1));
    first.unmount();

    // The next instance re-reads Overflow's (cached, stale) rows: held.
    const reread = deferred<Response>();
    stockReply[2] = () => reread.promise;
    renderPage(client);
    await waitFor(() => expect(stockFetches(2)).toHaveLength(2));
    const seqBefore = useWorkbench.getState().selectionSeq;

    await act(async () => oldRead.resolve(answer()));
    await act(async () => {});
    // Untouched: still X as built at Main, still waiting, nobody spoke.
    expect(useWorkbench.getState().selectionSeq).toBe(seqBefore);
    expect(useWorkbench.getState().selectedExternalOrder?.builtAtLocationId).toBe(1);
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    expect(screen.getByText(UPDATING_OVERFLOW)).toBeInTheDocument();

    // The new page's own rebuild, once its rows are here.
    await act(async () => reread.resolve(ok({ inventory: STOCK[2] })));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(REBUILT_OVERFLOW));
    expect(orderFetches()).toHaveLength(2);
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(useWorkbench.getState().selectedExternalOrder?.builtAtLocationId).toBe(2);
    consoleError.mockRestore();
  });
});

describe("FR2-1 (FD1-1) — the flip-back: the location returns to the cart's own while a rebuild is out", () => {
  it("the in-flight read is invalidated: it cannot replace the cart the operator now has", async () => {
    selectXAtMain();
    const held = deferred<Response>();
    const reads = [held.promise];
    orderReply["ord-x"] = () => reads.shift() ?? Promise.resolve(ok(ORDER_X));
    const { rerender } = renderPage();
    await waitFor(() => expect(stockFetches(1).length).toBeGreaterThan(0));

    moveTo(OVERFLOW, rerender);
    await waitFor(() => expect(orderFetches()).toHaveLength(1));

    // Back to Main, where the cart was built: nothing needs rebuilding.
    moveTo(MAIN, rerender);
    await act(async () => {});

    // The packer lowers the line to what they packed.
    act(() => {
      useWorkbench.getState().updateItemQuantity(501, 1, "x-1");
    });

    // The read for Overflow lands: it is stale, and does nothing.
    await act(async () => held.resolve(ok(ORDER_X)));
    await act(async () => {});
    const after = useWorkbench.getState();
    expect(after.selectedExternalOrder?.builtAtLocationId).toBe(1);
    expect(after.orderItems.map((i) => [i.fulfillmentItemId, i.product.currentQuantity, i.quantity])).toEqual([
      ["x-1", 10, 1],
    ]);
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("flip back and forward again: a fresh rebuild goes out at once — the invalidated read holds nothing up", async () => {
    selectXAtMain();
    const first = deferred<Response>();
    const second = deferred<Response>();
    const reads = [first.promise, second.promise];
    orderReply["ord-x"] = () => reads.shift() ?? Promise.resolve(ok(ORDER_X));
    const { rerender } = renderPage();
    await waitFor(() => expect(stockFetches(1).length).toBeGreaterThan(0));

    moveTo(OVERFLOW, rerender);
    await waitFor(() => expect(orderFetches()).toHaveLength(1));
    moveTo(MAIN, rerender);
    await act(async () => {});
    // Main's cached rows are re-read; let that settle before going forward again.
    await waitFor(() => expect(stockFetches(1).length).toBeGreaterThan(1));
    await act(async () => {});

    // Forward to Overflow again, its rows cached: a NEW read goes out, while
    // the first (invalidated) one is still unanswered.
    moveTo(OVERFLOW, rerender);
    await waitFor(() => expect(orderFetches()).toHaveLength(2));

    await act(async () => second.resolve(ok(ORDER_X)));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(REBUILT_OVERFLOW));
    expect(useWorkbench.getState().selectedExternalOrder?.builtAtLocationId).toBe(2);

    // The invalidated read lands last: nothing.
    await act(async () => first.resolve(refused()));
    await act(async () => {});
    expect(useWorkbench.getState().selectedExternalOrder?.builtAtLocationId).toBe(2);
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  it("and Complete does not wait on that read: the flip-back gives it back at once", async () => {
    selectXAtMain();
    const held = deferred<Response>();
    const reads = [held.promise];
    orderReply["ord-x"] = () => reads.shift() ?? Promise.resolve(ok(ORDER_X));
    const { rerender } = renderPage();
    await waitFor(() => expect(stockFetches(1).length).toBeGreaterThan(0));

    moveTo(OVERFLOW, rerender);
    await waitFor(() => expect(orderFetches()).toHaveLength(1));
    expect(completeButton()).toBeDisabled();

    moveTo(MAIN, rerender);
    await act(async () => {});
    // The Overflow read is still out, and holds nothing up.
    expect(completeButton()).toBeEnabled();
    expect(screen.queryByText(/^Updating this order/)).toBeNull();
  });
});

describe("FR2-1 — the cart is read-only while the order is updating", () => {
  /** The order row in the desktop cart (an h4 — the product tiles use h3). */
  const cartRowButtons = () => {
    const row = screen.getByRole("heading", { level: 4, name: "Widget 10mg" }).closest("div.rounded-xl");
    return within(row as HTMLElement).getAllByRole("button");
  };
  const tileButtons = () =>
    screen
      .getAllByText(/^Stock: /)
      .map((el) => el.closest("button"))
      .filter((b): b is HTMLButtonElement => b !== null);

  it("the steppers, the quantity editor and the bin are disabled, and a product tile does not open the picker", async () => {
    selectXAtMain();
    const { rerender } = renderPage();
    await waitFor(() => expect(stockFetches(1).length).toBeGreaterThan(0));
    await waitFor(() => expect(tileButtons().length).toBeGreaterThan(0));
    // Built here: the row is live (the + stays enabled: 2 of Main's 10).
    expect(cartRowButtons()).toHaveLength(4);
    for (const button of cartRowButtons()) expect(button).toBeEnabled();

    // To Overflow, whose stock is still on its way: the order is updating.
    const overflowStock = deferred<Response>();
    stockReply[2] = () => overflowStock.promise;
    moveTo(OVERFLOW, rerender);
    await waitFor(() => expect(screen.getByText(UPDATING_OVERFLOW)).toBeInTheDocument());

    const [minus, quantity, plus, bin] = cartRowButtons();
    for (const button of [minus, quantity, plus, bin]) expect(button).toBeDisabled();
    expect(quantity).toHaveTextContent("2");

    fireEvent.click(tileButtons()[0]);
    expect(screen.queryByText("Select Quantity")).toBeNull();

    // The rebuild lands: the cart is editable again.
    await act(async () => overflowStock.resolve(ok({ inventory: STOCK[2] })));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(REBUILT_OVERFLOW));
    await waitFor(() => expect(cartRowButtons()[1]).toBeEnabled());
    expect(cartRowButtons()[0]).toBeEnabled();
    expect(cartRowButtons()[3]).toBeEnabled();
  });

  it("a picker already open when the update begins adds nothing", async () => {
    selectXAtMain();
    const { rerender } = renderPage();
    await waitFor(() => expect(tileButtons().length).toBeGreaterThan(0));

    // The picker opens on Main's rows while the order is built here.
    fireEvent.click(tileButtons()[0]);
    expect(await screen.findByText("Select Quantity")).toBeInTheDocument();

    // The location changes under it (the picker is modal; the change comes from elsewhere).
    stockReply[2] = () => new Promise<Response>(() => {});
    moveTo(OVERFLOW, rerender);
    await waitFor(() => expect(screen.getByText(UPDATING_OVERFLOW)).toBeInTheDocument());
    const before = useWorkbench.getState().orderItems.length;

    fireEvent.click(screen.getByRole("button", { name: "1" }));
    expect(useWorkbench.getState().orderItems).toHaveLength(before);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("the phone's sheet is told the cart is read-only while updating, and not after", async () => {
    setWidth(375);
    selectXAtMain();
    locationContext = { selectedLocationId: 2, selectedLocation: OVERFLOW };
    const stock = deferred<Response>();
    stockReply[2] = () => stock.promise;
    renderPage();

    await waitFor(() => expect(sheetProps?.updatingNotice).toBe(UPDATING_OVERFLOW));
    expect(sheetProps!.cartReadOnly).toBe(true);

    await act(async () => stock.resolve(ok({ inventory: STOCK[2] })));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(REBUILT_OVERFLOW));
    await waitFor(() => expect(sheetProps!.cartReadOnly).toBe(false));
  });
});

// ---------------------------------------------------------------------------
// FR2-5 (QA-2, FD1-3): a failed stock read being read AGAIN is loading
// ---------------------------------------------------------------------------

describe("FR2-5 — the rows' stock-failed state is `productsError && !productsFetching`", () => {
  beforeEach(() => {
    act(() => {
      useWorkbench.getState().setOrderSource("wc-order");
    });
  });

  it("a re-read of rows whose last read FAILED says loading while it is out, and becomes live when it answers", async () => {
    // Main's rows are here; their next read fails, so the query is in error
    // OVER cached rows (react-query keeps `status: "error"` while it re-reads
    // them — with no rows it would be "pending" again, which already read as
    // loading).
    renderPage();
    await waitFor(() => expect(selectorProps?.stockLoading).toBe(false));
    stockReply[1] = async () => refused();
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["inventory-products"] });
    });
    await waitFor(() => expect(selectorProps?.stockFailed).toBe(true));
    expect(selectorProps?.stockLoading).toBe(false);

    // Read again (what the rows' Retry is for): while it is out, it is loading.
    const reread = deferred<Response>();
    stockReply[1] = () => reread.promise;
    await act(async () => {
      void qc.refetchQueries({ queryKey: ["inventory-products"] });
    });
    await waitFor(() => expect(selectorProps?.stockLoading).toBe(true));
    const mainKey = ["inventory-products", 1, "baseNameNumeric", "asc"];
    expect(qc.getQueryState(mainKey)?.status).toBe("error");
    expect(qc.getQueryState(mainKey)?.fetchStatus).toBe("fetching");
    expect(selectorProps?.stockFailed).toBe(false);

    await act(async () => reread.resolve(ok({ inventory: STOCK[1] })));
    await waitFor(() => expect(selectorProps?.stockLoading).toBe(false));
    expect(selectorProps?.stockFailed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FR2-6 (QA-3): no location selected
// ---------------------------------------------------------------------------

describe("FR2-6 — with no location selected the rows are told so", () => {
  beforeEach(() => {
    act(() => {
      useWorkbench.getState().setOrderSource("wc-order");
    });
  });

  it("the selector gets `noLocation`, no stock read goes out, and the page refuses a selection", async () => {
    locationContext = { selectedLocationId: null, selectedLocation: null };
    renderPage();

    await waitFor(() => expect(selectorProps).not.toBeNull());
    expect(selectorProps!.noLocation).toBe(true);
    await act(async () => {});
    expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/inventory/current-fast"))).toHaveLength(0);
    act(() => {
      selectorProps!.onOrderSelected(ORDER_X);
    });
    expect(useWorkbench.getState().selectedExternalOrder).toBeNull();
  });

  it("with a location, `noLocation` is false", async () => {
    renderPage();
    await waitFor(() => expect(selectorProps?.stockLoading).toBe(false));
    expect(selectorProps!.noLocation).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FR2-9 (QA-4): one pin on the app's OWN query defaults
// ---------------------------------------------------------------------------

describe("FR2-9 — on the app's own QueryClient defaults (lib/query-client.ts: staleTime 5 min, retry 1)", () => {
  // Documented, and accepted (REV 7): a location revisited within `staleTime`
  // is FRESH by the app-wide model, so it is not re-read and the order is
  // rebuilt at once from its cached rows. The location the cart describes is
  // right; how old those rows may be is the app-wide staleness model, not this
  // page's.
  it("a cached location revisited within staleTime rebuilds at once from its cached rows, with no re-read", async () => {
    const appDefaults = appQueryClient.getDefaultOptions();
    expect(appDefaults.queries?.staleTime).toBe(5 * 60 * 1000);
    expect(appDefaults.queries?.retry).toBe(1);

    selectXAtMain();
    const { rerender } = renderPage(new QueryClient({ defaultOptions: appDefaults }));
    await waitFor(() => expect(stockFetches(1)).toHaveLength(1));

    moveTo(OVERFLOW, rerender);
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(REBUILT_OVERFLOW));
    await waitFor(() => expect(useWorkbench.getState().selectedExternalOrder?.builtAtLocationId).toBe(2));
    const ordersBefore = orderFetches().length;

    moveTo(MAIN, rerender);
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "Location changed to Main — order 9001 was rebuilt with this location's stock."
      )
    );
    // No re-read of Main: its cached rows were fresh, and the rebuild used them.
    expect(stockFetches(1)).toHaveLength(1);
    expect(orderFetches()).toHaveLength(ordersBefore + 1);
    const state = useWorkbench.getState();
    expect(state.selectedExternalOrder?.builtAtLocationId).toBe(1);
    expect(state.orderItems.map((i) => [i.product.currentQuantity, i.quantity])).toEqual([[10, 2]]);
  });
});

describe("FR2-5 (ruling (a)) — the rows' Retry reads the stock again", () => {
  beforeEach(() => {
    act(() => {
      useWorkbench.getState().setOrderSource("wc-order");
    });
  });

  it("the selector's onRetryStock is the products refetch: it re-reads this location's stock, and the rows come back live", async () => {
    stockReply[1] = async () => refused();
    renderPage();
    await waitFor(() => expect(selectorProps?.stockFailed).toBe(true));
    const before = stockFetches(1).length;

    stockReply[1] = async () => ok({ inventory: STOCK[1] });
    await act(async () => {
      void selectorProps!.onRetryStock?.();
    });
    await waitFor(() => expect(stockFetches(1).length).toBe(before + 1));
    await waitFor(() => expect(selectorProps?.stockFailed).toBe(false));
    expect(selectorProps?.stockLoading).toBe(false);
  });
});
