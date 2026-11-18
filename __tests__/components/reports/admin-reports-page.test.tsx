/** @jest-environment jsdom */
//
// Facelift F0-3 (plan 2026-11-17-facelift-f0, F0-3 + the REV 2 folds) — Admin
// Reports shows no number while loading.
//
// Before: `metrics` is null until the query resolves and every tile coalesced it
// to a number, so the page opened on "Order Now 0", "Health Score 0%",
// "Stockout Risk 0 / Avg 0 days" and a carrying-cost "Not configured" — none of
// them an answer. A failed read stayed there for good. Now: skeletons while the
// query is pending, `--` and ONE `Couldn't load the report.` + Retry on a failed
// read with no data, and today's values (and today's "Not configured" trigger)
// once loaded. The Stockout Risk sub-line no longer says outflow "includes
// transfers" (the shared velocity excludes them) and no longer turns an unknown
// days-of-supply into 0.

import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The page's children each fetch their own data; none is under test here.
jest.mock("@/components/reports/activity-timeline", () => ({ ActivityTimeline: () => null }));
jest.mock("@/components/reports/product-performance", () => ({ ProductPerformance: () => null }));
jest.mock("@/components/reports/user-activity", () => ({ UserActivity: () => null }));
jest.mock("@/components/reports/low-stock-alert", () => ({ LowStockAlert: () => null }));
jest.mock("@/components/reports/inventory-chart", () => ({
  LineChartComponent: () => null,
  ActivityBarChart: () => null,
}));
jest.mock("@/components/reports/reorder-recommendations", () => ({ ReorderRecommendations: () => null }));
jest.mock("@/components/reports/drill-down-modal", () => ({ DrillDownModal: () => null }));
jest.mock("@/components/reports/combined-minimums", () => ({ CombinedMinimumsReport: () => null }));
jest.mock("@/components/ui/date-range-picker", () => ({ DateRangePicker: () => null }));
jest.mock("@/contexts/location-context", () => ({
  useLocation: () => ({ selectedLocationId: 1 }),
}));

import AdminReportsPage from "@/app/(app)/admin/reports/page";

const TILES = ["Order Now", "Health Score", "Monthly Carrying Cost", "Dead Stock Value", "Stockout Risk"];

const LOADED = {
  orderNowCount: 4,
  orderSoonCount: 2,
  reorderHealthScore: 85,
  monthlyCarryingCost: 1234.5,
  totalInventoryCostValue: 59256,
  deadStockValue: 5925.6,
  stockoutRiskCount: 3,
  daysOfSupplyAvg: 12 as number | null,
  lowStockTrend: { value: 5, direction: "up" },
  recentActivityCount: 10,
  totalProducts: 20,
  activeProducts: 20,
  totalStockQuantity: 500,
  totalInventoryRetailValue: 0,
  lowStockProducts: 3,
};

type MetricsReply = "pending" | { ok: false } | { ok: true; metrics: Partial<typeof LOADED> };

let fetchMock: jest.Mock;
function mockFetch(metrics: MetricsReply) {
  fetchMock = jest.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://x");
    if (url.pathname === "/api/reports/metrics") {
      if (metrics === "pending") return new Promise<Response>(() => {});
      if (!metrics.ok) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: "boom" }) } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ metrics: { ...LOADED, ...metrics.metrics } }),
      } as Response);
    }
    // inventory-trends / daily-activity
    return Promise.resolve({ ok: true, json: async () => ({ data: [] }) } as Response);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
}

const metricsCalls = () =>
  fetchMock.mock.calls.filter(([u]) => new URL(String(u), "http://x").pathname === "/api/reports/metrics");

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AdminReportsPage />
    </QueryClientProvider>,
  );
}

const tile = (title: string) => screen.getByText(title).closest(".rounded-2xl") as HTMLElement;

describe("F0-3 — Admin Reports tiles", () => {
  it("while pending: every tile renders skeletons, and the page shows no 0, 0%, $0.00 or `Not configured`", () => {
    mockFetch("pending");
    renderPage();

    for (const title of TILES) {
      const card = tile(title);
      expect(card.querySelectorAll(".animate-pulse").length).toBeGreaterThanOrEqual(2);
      expect(card).not.toHaveTextContent(/\d/);
      expect(card).not.toHaveTextContent("Not configured");
    }
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.queryByText("0%")).toBeNull();
    expect(screen.queryByText(/\$0\.00/)).toBeNull();
    expect(screen.queryByText("Not configured")).toBeNull();
    expect(screen.queryByText(/days of supply/)).toBeNull();
  });

  it("loaded values render as today", async () => {
    mockFetch({ ok: true, metrics: {} });
    renderPage();

    await waitFor(() => expect(within(tile("Order Now")).getByText("4")).toBeInTheDocument());
    expect(within(tile("Order Now")).getByText("2 order soon")).toBeInTheDocument();
    expect(within(tile("Health Score")).getByText("85%")).toBeInTheDocument();
    expect(within(tile("Health Score")).getByText("products in healthy stock")).toBeInTheDocument();
    expect(within(tile("Monthly Carrying Cost")).getByText("$1,234.50")).toBeInTheDocument();
    expect(within(tile("Monthly Carrying Cost")).getByText("$59,256.00 total value")).toBeInTheDocument();
    expect(within(tile("Dead Stock Value")).getByText("$5,925.60")).toBeInTheDocument();
    expect(within(tile("Dead Stock Value")).getByText("10% of inventory")).toBeInTheDocument();
    expect(within(tile("Stockout Risk")).getByText("3")).toBeInTheDocument();
    expect(within(tile("Stockout Risk")).getByText("5%")).toBeInTheDocument();
    expect(document.querySelectorAll(".animate-pulse")).toHaveLength(0);
    expect(screen.queryByText("Couldn't load the report.")).toBeNull();
  });

  it("the Stockout Risk sub-line with a known average: excludes transfers, includes corrections", async () => {
    mockFetch({ ok: true, metrics: { daysOfSupplyAvg: 12 } });
    renderPage();

    expect(
      await screen.findByText(
        "Avg 12 days of supply (outflow-based — excludes transfers, includes corrections) · trend tracks the low-stock count",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/includes transfers/)).toBeNull();
  });

  it("the Stockout Risk sub-line with a null average says unknown, never `Avg 0`", async () => {
    mockFetch({ ok: true, metrics: { daysOfSupplyAvg: null } });
    renderPage();

    expect(
      await screen.findByText("Days of supply unknown (no measured outflow) · trend tracks the low-stock count"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Avg 0 days/)).toBeNull();
  });

  it("`Not configured` keeps today's trigger: a cost value of 0 after load", async () => {
    mockFetch({ ok: true, metrics: { totalInventoryCostValue: 0, deadStockValue: 0 } });
    renderPage();

    await waitFor(() =>
      expect(within(tile("Monthly Carrying Cost")).getByText("Not configured")).toBeInTheDocument(),
    );
    expect(within(tile("Dead Stock Value")).getByText("Not configured")).toBeInTheDocument();
  });

  it("a failed read with no data: `--` in every tile, ONE `Couldn't load the report.` + Retry that refetches", async () => {
    mockFetch({ ok: false });
    renderPage();

    expect(await screen.findByText("Couldn't load the report.")).toBeInTheDocument();
    expect(screen.getAllByText("Couldn't load the report.")).toHaveLength(1);
    for (const title of TILES) {
      const card = tile(title);
      expect(within(card).getByText("--")).toBeInTheDocument();
      expect(card).not.toHaveTextContent(/\d/);
      expect(card).not.toHaveTextContent("Not configured");
      expect(card.querySelector(".animate-pulse")).toBeNull();
    }

    const before = metricsCalls().length;
    const line = screen.getByText("Couldn't load the report.").parentElement as HTMLElement;
    fireEvent.click(within(line).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(metricsCalls().length).toBe(before + 1));
  });
});
