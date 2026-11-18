/** @jest-environment jsdom */
//
// Facelift F0-7 (plan 2026-11-17-facelift-f0, F0-7 + the REV 2 folds) — Orders
// "Load More" loads more.
//
// Before: the query was fixed at page 1, pageSize 50, and "Load More" had no
// handler: with more than 50 orders the button appeared and did nothing, and
// older orders were reachable only by search. Now the page keeps a pageSize
// (start 50); "Load More" raises it by 50 while the current list stays on screen
// and the button reads `Loading…` (disabled). The client caps it at 200 (the
// API's pageSize is unbounded), where the button gives way to a sentence — but
// only when there IS more. Any change of company, status, platform or search
// starts again at 50.

import * as React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("next/link", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MockLink = React.forwardRef<HTMLAnchorElement, any>(({ children, href, ...r }, ref) => (
    <a ref={ref} href={typeof href === "string" ? href : "#"} {...r}>
      {children}
    </a>
  ));
  MockLink.displayName = "NextLinkMock";
  return { __esModule: true, default: MockLink };
});
jest.mock("@/hooks/use-csrf", () => ({ useCSRF: () => ({ token: null }) }));
const mockToastError = jest.fn();
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => mockToastError(...a) } }));
jest.mock("@/components/orders/external-order-card", () => ({
  ExternalOrderCard: ({ order }: { order: { orderNumber: string } }) => (
    <div data-testid="order-card">{order.orderNumber}</div>
  ),
}));
jest.mock("@/components/orders/external-order-details-sheet", () => ({
  ExternalOrderDetailsSheet: () => null,
}));
jest.mock("@/components/orders/order-filters", () => ({
  OrderFilters: (p: {
    onCompanyChange: (id: string) => void;
    onStatusChange: (s: string) => void;
    onPlatformChange: (pl: string) => void;
    onSearchChange: (q: string) => void;
  }) => (
    <div>
      <button onClick={() => p.onCompanyChange("c2")}>change company</button>
      <button onClick={() => p.onStatusChange("PENDING")}>change status</button>
      <button onClick={() => p.onPlatformChange("WOOCOMMERCE")}>change platform</button>
      <button onClick={() => p.onSearchChange("10")}>change search</button>
    </div>
  ),
}));

import OrdersPage from "@/app/(app)/orders/page";

const CAP_MESSAGE = "Showing the newest 200 — search or filter to find older orders.";

let totalOrders = 500;
/** When set, every orders request is refused (500). */
let refuseOrders = false;
/** When set, the next orders request hangs until `release()` is called. */
let holdNext = false;
/** F1-7: how `/api/companies/user` answers (`hold` never answers). */
let companiesMode: "ok" | "empty" | "refuse" | "hold" = "ok";
let release: () => void = () => {};
let fetchMock: jest.Mock;

function ordersBody(url: URL) {
  const pageSize = Number(url.searchParams.get("pageSize"));
  const count = Math.min(pageSize, totalOrders);
  return {
    orders: Array.from({ length: count }, (_, i) => ({ id: `o${i + 1}`, orderNumber: `#${i + 1}` })),
    total: totalOrders,
    page: 1,
    pageSize,
    hasMore: totalOrders > pageSize,
  };
}

beforeEach(() => {
  totalOrders = 500;
  holdNext = false;
  refuseOrders = false;
  companiesMode = "ok";
  mockToastError.mockReset();
  fetchMock = jest.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://x");
    if (url.pathname === "/api/companies/user") {
      if (companiesMode === "hold") return new Promise<Response>(() => {});
      if (companiesMode === "refuse") {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: "boom" }) } as Response);
      }
      if (companiesMode === "empty") {
        return Promise.resolve({ ok: true, json: async () => ({ companies: [] }) } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ companies: [{ id: "c1", name: "Co 1" }, { id: "c2", name: "Co 2" }] }),
      } as Response);
    }
    if (url.pathname === "/api/orders/external") {
      if (refuseOrders) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: "boom" }) } as Response);
      }
      const response = { ok: true, json: async () => ordersBody(url) } as Response;
      if (holdNext) {
        holdNext = false;
        return new Promise<Response>((resolve) => {
          release = () => resolve(response);
        });
      }
      return Promise.resolve(response);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

const orderRequests = () =>
  fetchMock.mock.calls
    .map(([u]) => new URL(String(u), "http://x"))
    .filter((u) => u.pathname === "/api/orders/external");
const lastOrderRequest = () => orderRequests()[orderRequests().length - 1];

let qc: QueryClient;
function renderPage() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OrdersPage />
    </QueryClientProvider>,
  );
}

/**
 * `count` cards on screen, the default company chosen, AND no orders read in
 * flight (Refresh is disabled while one is). The page first lists the
 * no-company read, then an effect picks the default company and reads again.
 */
async function loaded(count: number) {
  await waitFor(() => {
    expect(lastOrderRequest().searchParams.get("companyId")).not.toBeNull();
    expect(screen.getAllByTestId("order-card")).toHaveLength(count);
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  });
}

describe("F0-7 — Orders Load More", () => {
  it("starts at pageSize 50; a click requests 50 more and keeps the list while it loads", async () => {
    renderPage();
    await loaded(50);
    expect(lastOrderRequest().searchParams.get("pageSize")).toBe("50");
    expect(screen.getByText("Showing 50 of 500 orders")).toBeInTheDocument();

    holdNext = true;
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));

    await waitFor(() => expect(lastOrderRequest().searchParams.get("pageSize")).toBe("100"));
    const busy = await screen.findByRole("button", { name: "Loading…" });
    expect(busy).toBeDisabled();
    expect(screen.getAllByTestId("order-card")).toHaveLength(50);
    expect(screen.queryByRole("button", { name: "Load More" })).toBeNull();

    release();
    await loaded(100);
    expect(screen.getByRole("button", { name: "Load More" })).toBeEnabled();
    expect(screen.getByText("Showing 100 of 500 orders")).toBeInTheDocument();
  });

  it("at the cap of 200 the button gives way to the sentence", async () => {
    renderPage();
    await loaded(50);
    for (const n of [100, 150, 200]) {
      fireEvent.click(screen.getByRole("button", { name: "Load More" }));
      await loaded(n);
    }
    expect(lastOrderRequest().searchParams.get("pageSize")).toBe("200");
    expect(screen.getByText(CAP_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load More" })).toBeNull();
    expect(screen.getByText("Showing 200 of 500 orders")).toBeInTheDocument();
  });

  it("the last click before the cap still reads `Loading…` until the 200 arrive", async () => {
    renderPage();
    await loaded(50);
    for (const n of [100, 150]) {
      fireEvent.click(screen.getByRole("button", { name: "Load More" }));
      await loaded(n);
    }
    holdNext = true;
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    expect(await screen.findByRole("button", { name: "Loading…" })).toBeDisabled();
    expect(screen.queryByText(CAP_MESSAGE)).toBeNull();

    release();
    expect(await screen.findByText(CAP_MESSAGE)).toBeInTheDocument();
  });

  it("the cap sentence renders only when there IS more", async () => {
    totalOrders = 200;
    renderPage();
    await loaded(50);
    for (const n of [100, 150, 200]) {
      fireEvent.click(screen.getByRole("button", { name: "Load More" }));
      await loaded(n);
    }
    expect(screen.queryByText(CAP_MESSAGE)).toBeNull();
    expect(screen.queryByRole("button", { name: "Load More" })).toBeNull();
  });

  it.each([
    ["company", "change company"],
    ["status", "change status"],
    ["platform", "change platform"],
    ["search", "change search"],
  ])("a change of %s starts again at pageSize 50", async (_what, button) => {
    renderPage();
    await loaded(50);
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    await loaded(100);

    const before = orderRequests().length;
    fireEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() => expect(orderRequests().length).toBeGreaterThan(before));
    // the search is debounced: wait for the request that carries it
    if (button === "change search") {
      await waitFor(() => expect(lastOrderRequest().searchParams.get("search")).toBe("10"));
    }
    for (const u of orderRequests().slice(before)) {
      expect(u.searchParams.get("pageSize")).toBe("50");
    }
  });
});

// ---------------------------------------------------------------------------
// Facelift F0 FR1-9 — the error panel only when nothing is loaded
// ---------------------------------------------------------------------------

describe("FR1-9 — Orders after a failed poll", () => {
  it("a failed poll over loaded rows keeps the rows, with no error panel", async () => {
    renderPage();
    await loaded(50);

    refuseOrders = true;
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["external-orders"], type: "active" });
    });
    const active = qc.getQueryCache().findAll({ queryKey: ["external-orders"], type: "active" });
    expect(active.map((q) => q.state.status)).toEqual(["error"]);
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

    expect(screen.getAllByTestId("order-card")).toHaveLength(50);
    expect(screen.getByText("Showing 50 of 500 orders")).toBeInTheDocument();
    expect(screen.queryByText("Failed to Load Orders")).toBeNull();
    // A failed POLL is not a failed Load More: no Load More toast.
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("a failed first read with nothing loaded still shows the error panel and its Retry", async () => {
    refuseOrders = true;
    renderPage();
    // The no-company read fails first, then the default company's: wait for that.
    await waitFor(() => {
      expect(lastOrderRequest().searchParams.get("companyId")).toBe("c1");
      expect(screen.getByText("Failed to Load Orders")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryAllByTestId("order-card")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Facelift F0 FR1-9, the orchestrator's ruling on the Load More half. Load More
// changes the query key; when the bigger read fails, react-query drops the
// placeholder rows, so the list used to vanish behind the error panel. Now the
// size goes back to what it was (the last SUCCESSFUL list, still cached), the
// operator is told, and Load More is offered again.
// ---------------------------------------------------------------------------

describe("FR1-9 ruling — a failed Load More", () => {
  const activeKeyPageSize = () =>
    (
      qc.getQueryCache().findAll({ queryKey: ["external-orders"], type: "active" })[0]
        ?.queryKey[1] as { pageSize?: number } | undefined
    )?.pageSize;

  it("puts the size back, keeps the previous rows, says so, and offers Load More again", async () => {
    renderPage();
    await loaded(50);

    refuseOrders = true;
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Couldn't load more orders — try again."));
    expect(mockToastError).toHaveBeenCalledTimes(1);

    // The 100-row read was asked for, failed, and the list is back at 50.
    expect(orderRequests().some((u) => u.searchParams.get("pageSize") === "100")).toBe(true);
    expect(activeKeyPageSize()).toBe(50);
    expect(screen.getAllByTestId("order-card")).toHaveLength(50);
    expect(screen.getByText("Showing 50 of 500 orders")).toBeInTheDocument();
    expect(screen.queryByText("Failed to Load Orders")).toBeNull();
    const again = screen.getByRole("button", { name: "Load More" });
    expect(again).toBeEnabled();

    // The next click asks for 100 again (from 50), not 150.
    refuseOrders = false;
    fireEvent.click(again);
    await loaded(100);
    expect(lastOrderRequest().searchParams.get("pageSize")).toBe("100");
    expect(mockToastError).toHaveBeenCalledTimes(1);
  });

  it("a successful Load More says nothing", async () => {
    renderPage();
    await loaded(50);
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    await loaded(100);
    await act(async () => {});
    expect(mockToastError).not.toHaveBeenCalled();
    expect(activeKeyPageSize()).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Facelift F1-6 + F1-7 (plan 2026-11-18-facelift-f1 REV 2) — Orders renders
// through the `Page` frame (wide: today's full width, now with a gutter), and
// its two reads say their states through `QueryState`: error only with no
// data, empty only on an answer. The companies read used to treat a FAILED
// read as "No Companies Found".
// ---------------------------------------------------------------------------

const FRAME_WIDE = "px-4 sm:px-6 py-4 mx-auto max-w-none";
const DESCRIPTION = "Manage external orders from Shopify and WooCommerce";

describe("F1-6 — Orders in the Page frame", () => {
  it("renders through Page (wide) with its unchanged title, description and Refresh (labelled) as the action", async () => {
    renderPage();
    await loaded(50);
    const h1 = screen.getByRole("heading", { level: 1, name: "Orders" });
    expect(h1.getAttribute("class")).toBe("text-h2 sm:text-h1 min-w-0");
    const frame = h1.closest("header")!.parentElement as HTMLElement;
    expect(frame.getAttribute("class")).toBe(FRAME_WIDE);
    const description = screen.getByText(DESCRIPTION);
    expect(description).toHaveClass("hidden", "sm:block");
    const refresh = screen.getByRole("button", { name: "Refresh" });
    expect(refresh).toHaveAttribute("aria-label", "Refresh");
    expect(h1.closest("header")).toContainElement(refresh);
  });
});

describe("F1-7 — the companies read", () => {
  it("loading renders inside Page title=Orders (title only), as a status", async () => {
    companiesMode = "hold";
    renderPage();
    const h1 = await screen.findByRole("heading", { level: 1, name: "Orders" });
    expect(h1.closest("header")!.parentElement!.getAttribute("class")).toBe(FRAME_WIDE);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByText(DESCRIPTION)).toBeNull();
    expect(screen.queryByText("No Companies Found")).toBeNull();
  });

  it("a failed read says `Couldn't load your companies.` with Retry — never `No Companies Found`", async () => {
    companiesMode = "refuse";
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load your companies.");
    expect(screen.queryByText("No Companies Found")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Orders" })).toBeInTheDocument();

    companiesMode = "ok";
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await loaded(50);
    expect(screen.queryByText("Couldn't load your companies.")).toBeNull();
  });

  it("a successful [] says `No Companies Found`, inside Page title=Orders", async () => {
    companiesMode = "empty";
    renderPage();
    expect(await screen.findByText("No Companies Found")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Orders" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("F1-7 — the orders list", () => {
  it("a failed first read is a role=alert panel with the pinned title and text", async () => {
    refuseOrders = true;
    renderPage();
    await waitFor(() => expect(lastOrderRequest().searchParams.get("companyId")).toBe("c1"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to Load Orders");
    expect(alert).toHaveTextContent("Please check your connection and try again");
  });

  it("placeholder [] while the next filter loads is not `No Orders Found`; the empty ANSWER is", async () => {
    totalOrders = 0;
    renderPage();
    await waitFor(() => {
      expect(lastOrderRequest().searchParams.get("companyId")).toBe("c1");
      expect(screen.getByText("No Orders Found")).toBeInTheDocument();
    });

    holdNext = true;
    fireEvent.click(screen.getByRole("button", { name: "change status" }));
    await waitFor(() => expect(lastOrderRequest().searchParams.get("status")).toBe("PENDING"));
    expect(screen.queryByText("No Orders Found")).toBeNull();
    expect(screen.getByText("Showing 0 of 0 orders")).toBeInTheDocument();

    release();
    expect(await screen.findByText("No Orders Found")).toBeInTheDocument();
  });
});
