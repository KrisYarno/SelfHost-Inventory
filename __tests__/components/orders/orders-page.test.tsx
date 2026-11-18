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
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
/** When set, the next orders request hangs until `release()` is called. */
let holdNext = false;
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
  fetchMock = jest.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://x");
    if (url.pathname === "/api/companies/user") {
      return Promise.resolve({
        ok: true,
        json: async () => ({ companies: [{ id: "c1", name: "Co 1" }, { id: "c2", name: "Co 2" }] }),
      } as Response);
    }
    if (url.pathname === "/api/orders/external") {
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

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
