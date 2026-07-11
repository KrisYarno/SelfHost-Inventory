/**
 * @jest-environment jsdom
 *
 * Lane 3 Task 3 (Lane W2-A) — the History tab surface on /analytics/product/[id].
 * Two parts:
 *   1. useProductHistory hook: tab-gated (enabled) fetch + keyset accumulation
 *      across "Load more" (fetchNextPage) with the cursor encoded into ?before=.
 *   2. The page: D-L2 header identity, Performance|History tab sync to ?tab=,
 *      History deep-link, and the D-L4 interaction states.
 */
import React from "react";
import { render, screen, waitFor, renderHook, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TimelineEntry } from "@/lib/history/union-timeline";

// ---- next/navigation (page uses useParams/useRouter/usePathname/useSearchParams)
const replaceMock = jest.fn();
let currentSearch = new URLSearchParams("");
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "42" }),
  useRouter: () => ({ replace: replaceMock, push: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => "/analytics/product/42",
  useSearchParams: () => currentSearch,
}));

// ---- hooks: control both queries deterministically for the page tests.
jest.mock("@/hooks/use-analytics", () => ({
  __esModule: true,
  useProductAnalytics: jest.fn(),
}));
jest.mock("@/hooks/use-product-history", () => ({
  __esModule: true,
  useProductHistory: jest.fn(),
}));

// Heavy chart wrappers are irrelevant to these assertions; stub to keep jsdom light.
jest.mock("@/components/reports/inventory-chart", () => ({
  __esModule: true,
  LineChartComponent: () => <div data-testid="line-chart" />,
  BarChartComponent: () => <div data-testid="bar-chart" />,
}));
jest.mock("@/components/analytics/company-scope-select", () => ({
  __esModule: true,
  CompanyScopeSelect: () => <div data-testid="company-scope" />,
}));

import ProductAnalyticsPage from "@/app/(app)/analytics/product/[id]/page";
import { useProductAnalytics } from "@/hooks/use-analytics";
import { useProductHistory } from "@/hooks/use-product-history";

const analyticsMock = useProductAnalytics as jest.Mock;
const historyMock = useProductHistory as jest.Mock;

// Radix Tabs/pointer polyfills for jsdom.
beforeAll(() => {
  Element.prototype.hasPointerCapture = jest.fn(() => false) as never;
  Element.prototype.setPointerCapture = jest.fn() as never;
  Element.prototype.releasePointerCapture = jest.fn() as never;
  Element.prototype.scrollIntoView = jest.fn() as never;
});

const IDENTITY = {
  productId: 42,
  product: { name: "BPC 5mg", baseName: "BPC", variant: "5mg vial", currentStock: 128 },
  stock: { series: [], mode: "historical (GLOBAL inventory)" },
  sales: { series: [], mode: "historical (your companies)", note: "n" },
};

function analyticsResult(over: Partial<any> = {}) {
  return {
    data: { product: IDENTITY, salesByDay: null },
    isLoading: false,
    isError: false,
    ...over,
  };
}

function historyResult(over: Partial<any> = {}) {
  return {
    data: { entries: [], dataStart: { events: null, ledger: null } },
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: jest.fn(),
    refetch: jest.fn(),
    ...over,
  };
}

const ledgerEntry = (id: number): TimelineEntry => ({
  kind: "ledger",
  ts: "2026-07-01T00:00:00.000Z",
  ledgerRows: [
    {
      id,
      ts: "2026-07-01T00:00:00.000Z",
      delta: -2,
      logType: "SALE",
      reasonCode: null,
      unitCostCents: null,
      locationName: null,
      transferId: null,
      userName: null,
    },
  ],
  orphanKind: "legacy-unlinked",
});

beforeEach(() => {
  jest.clearAllMocks();
  replaceMock.mockReset();
  currentSearch = new URLSearchParams("");
  analyticsMock.mockReturnValue(analyticsResult());
  historyMock.mockReturnValue(historyResult());
});

function renderPage() {
  return render(<ProductAnalyticsPage />);
}

// ===========================================================================
// Page: header identity + tab sync + deep link
// ===========================================================================
describe("page header + tab sync", () => {
  it("renders the D-L2 product-first header (breadcrumb, H1 name, variant · stock)", () => {
    renderPage();
    // Breadcrumb Products link.
    expect(screen.getByRole("link", { name: "Products" })).toHaveAttribute("href", "/products");
    // H1 is the product name.
    expect(screen.getByRole("heading", { level: 1, name: "BPC 5mg" })).toBeInTheDocument();
    // Identity line: variant · current GLOBAL stock.
    expect(screen.getByText("5mg vial")).toBeInTheDocument();
    expect(screen.getByText("128")).toBeInTheDocument();
    expect(screen.getByText(/in stock/i)).toBeInTheDocument();
  });

  it("defaults to the Performance tab (bare URL) and gates the History query off", () => {
    renderPage();
    // History query is created but disabled while Performance is active.
    expect(historyMock).toHaveBeenCalledWith("42", { enabled: false });
    // Performance content (scope controls) is present.
    expect(screen.getByTestId("company-scope")).toBeInTheDocument();
  });

  it("clicking History pushes ?tab=history to the URL", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("tab", { name: "History" }));
    expect(replaceMock).toHaveBeenCalledWith(
      "/analytics/product/42?tab=history",
      expect.objectContaining({ scroll: false }),
    );
  });

  it("clicking Performance clears ?tab (bare URL default) so old links land unchanged", async () => {
    const user = userEvent.setup();
    currentSearch = new URLSearchParams("tab=history");
    renderPage();
    await user.click(screen.getByRole("tab", { name: "Performance" }));
    expect(replaceMock).toHaveBeenCalledWith(
      "/analytics/product/42",
      expect.objectContaining({ scroll: false }),
    );
  });

  it("deep link ?tab=history activates History and enables the query; scope controls hidden", () => {
    currentSearch = new URLSearchParams("tab=history");
    renderPage();
    expect(historyMock).toHaveBeenCalledWith("42", { enabled: true });
    // Sales scope/date controls belong to Performance and are unmounted on History.
    expect(screen.queryByTestId("company-scope")).not.toBeInTheDocument();
  });
});

// ===========================================================================
// Page: History tab D-L4 interaction states
// ===========================================================================
describe("history tab states", () => {
  beforeEach(() => {
    currentSearch = new URLSearchParams("tab=history");
  });

  it("loading => rail-shaped skeleton", () => {
    historyMock.mockReturnValue(historyResult({ isLoading: true, data: undefined }));
    renderPage();
    expect(screen.getByTestId("history-skeleton")).toBeInTheDocument();
  });

  it("empty => 'No recorded history yet.'", () => {
    historyMock.mockReturnValue(historyResult());
    renderPage();
    expect(screen.getByText("No recorded history yet.")).toBeInTheDocument();
  });

  it("error => destructive box + Retry (which calls refetch)", async () => {
    const refetch = jest.fn();
    historyMock.mockReturnValue(historyResult({ isError: true, data: undefined, refetch }));
    const user = userEvent.setup();
    renderPage();
    const retry = screen.getByRole("button", { name: /retry/i });
    await user.click(retry);
    expect(refetch).toHaveBeenCalled();
  });

  it("entries + more pages => renders rows + a Load more button (fetchNextPage)", async () => {
    const fetchNextPage = jest.fn();
    historyMock.mockReturnValue(
      historyResult({
        data: { entries: [ledgerEntry(1), ledgerEntry(2)], dataStart: { events: null, ledger: null } },
        hasNextPage: true,
        fetchNextPage,
      }),
    );
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByTestId("history-timeline")).toBeInTheDocument();
    const loadMore = screen.getByRole("button", { name: /load more/i });
    await user.click(loadMore);
    expect(fetchNextPage).toHaveBeenCalled();
    // No end line while more pages remain.
    expect(screen.queryByText(/beginning of recorded history/i)).not.toBeInTheDocument();
  });

  it("entries + no more pages => end line 'Beginning of recorded history'", () => {
    historyMock.mockReturnValue(
      historyResult({
        data: { entries: [ledgerEntry(1)], dataStart: { events: null, ledger: null } },
        hasNextPage: false,
      }),
    );
    renderPage();
    expect(screen.getByText(/beginning of recorded history/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
  });
});

// ===========================================================================
// Hook: useProductHistory (real implementation) — tab-gating + keyset accumulation
// ===========================================================================
describe("useProductHistory (real hook)", () => {
  // Use the real hook here (the page tests mock it). Re-require to bypass the mock.
  const { useProductHistory: realUseProductHistory } = jest.requireActual(
    "@/hooks/use-product-history",
  );

  function wrapper() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // eslint-disable-next-line react/display-name
    return ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
  }

  afterEach(() => {
    // @ts-expect-error cleanup the per-test fetch stub
    delete global.fetch;
  });

  it("does not fetch while disabled (tab-gated)", async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as never;
    renderHook(() => realUseProductHistory("42", { enabled: false }), { wrapper: wrapper() });
    // Give react-query a tick; a disabled query never calls the queryFn.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accumulates pages across fetchNextPage and encodes the cursor into ?before=", async () => {
    const page1 = {
      entries: [ledgerEntry(1)],
      nextCursor: { ts: "2026-07-01T00:00:00.000Z", lastEventId: 5, lastLedgerId: 9 },
      dataStart: { events: "2026-06-01T00:00:00.000Z", ledger: "2026-05-01T00:00:00.000Z" },
    };
    const page2 = {
      entries: [ledgerEntry(2)],
      nextCursor: null,
      dataStart: { events: "2026-06-01T00:00:00.000Z", ledger: "2026-05-01T00:00:00.000Z" },
    };
    const calls: string[] = [];
    global.fetch = jest.fn(async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        json: async () => (calls.length === 1 ? page1 : page2),
      } as Response;
    }) as never;

    const { result } = renderHook(
      () => realUseProductHistory("42", { enabled: true }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.data?.entries).toHaveLength(1));
    // First page: no cursor in the URL.
    expect(calls[0]).not.toContain("before=");
    expect(result.current.hasNextPage).toBe(true);
    // dataStart threads through from the first page.
    expect(result.current.data?.dataStart.ledger).toBe("2026-05-01T00:00:00.000Z");

    await act(async () => {
      await result.current.fetchNextPage();
    });

    await waitFor(() => expect(result.current.data?.entries).toHaveLength(2));
    // Second page carried the encoded keyset cursor.
    expect(calls[1]).toContain("before=");
    const encoded = new URL(calls[1], "http://t").searchParams.get("before")!;
    const decoded = JSON.parse(
      Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    expect(decoded).toEqual(page1.nextCursor);
    // Pages accumulated (page1 + page2), not replaced.
    expect(result.current.hasNextPage).toBe(false);
  });
});
