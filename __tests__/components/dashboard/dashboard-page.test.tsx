/** @jest-environment jsdom */
//
// Facelift F0-2 (plan 2026-11-17-facelift-f0, F0-2 + the REV 2 folds) — the
// dashboard never turns a failed read into 0 or "All stocked up", and its
// captions say what they count.
//
// Before: a failed per-location read rendered "0 units"; a failed or never-run
// low-stock read rendered the green "All stocked up"; a failed activity read
// rendered "No recent activity to show."; a failed metrics read left four "--"
// with no word and no way to retry. The captions said "across all locations"
// over one location's stock, and "Recent Activity" counted every log ever
// written. Each failed read now says so and offers Retry; the success copy
// renders only on a successful answer.

import * as React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// recharts is lazy-loaded behind next/dynamic; the sparkline is not under test.
jest.mock("@/components/ui/sparkline", () => ({ Sparkline: () => null }));

type Loc = { id: number; name: string };
let mockLocation: {
  locations: Loc[];
  selectedLocationId: number | null;
  selectedLocation: Loc | null;
  isLoading: boolean;
  setSelectedLocationId: jest.Mock;
};
jest.mock("@/contexts/location-context", () => ({ useLocation: () => mockLocation }));

import DashboardPage from "@/app/(app)/dashboard/page";

const MAIN: Loc = { id: 1, name: "Main" };
const BACK: Loc = { id: 2, name: "Back" };

function setLocation(over: Partial<typeof mockLocation> = {}) {
  mockLocation = {
    locations: [MAIN, BACK],
    selectedLocationId: MAIN.id,
    selectedLocation: MAIN,
    isLoading: false,
    setSelectedLocationId: jest.fn(),
    ...over,
  };
}

type Responder = (url: URL) => { ok: boolean; body?: unknown } | Promise<never>;

const METRICS = {
  metrics: {
    totalProducts: 12,
    totalStockQuantity: 340,
    lowStockProducts: 3,
    recentActivityCount: 9,
  },
};

const ACTIVITY_ITEM = {
  id: "a1",
  timestamp: new Date().toISOString(),
  type: "stock_in",
  description: "Received 4 x Widget",
  user: { id: 1, username: "kris" },
};

const DEFAULTS: Record<string, Responder> = {
  "/api/reports/metrics": () => ({ ok: true, body: METRICS }),
  "/api/inventory/current-fast": () => ({ ok: true, body: { inventory: [{ quantity: 5 }, { quantity: 7 }] } }),
  "/api/stocker/minimums": () => ({ ok: true, body: { items: [] } }),
  "/api/reports/activity": () => ({ ok: true, body: { activities: [ACTIVITY_ITEM] } }),
  "/api/reports/inventory-trends": () => ({ ok: true, body: { data: [] } }),
};

let fetchMock: jest.Mock;
function mockFetch(over: Record<string, Responder> = {}) {
  const table = { ...DEFAULTS, ...over };
  fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://x");
    const responder = table[url.pathname];
    if (!responder) throw new Error(`unexpected fetch ${url.pathname}`);
    const reply = await responder(url);
    return {
      ok: reply.ok,
      status: reply.ok ? 200 : 500,
      json: async () => reply.body ?? { error: "boom" },
    } as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
}

const callsTo = (path: string) =>
  fetchMock.mock.calls.filter(([u]) => new URL(String(u), "http://x").pathname === path);

let qc: QueryClient;
function renderPage() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DashboardPage />
    </QueryClientProvider>,
  );
}

/** The card (rounded-2xl) that holds a title. */
const cardOf = (title: string) => screen.getByText(title).closest(".rounded-2xl") as HTMLElement;

beforeEach(() => {
  setLocation();
  mockFetch();
});

describe("F0-2 — stock by location", () => {
  it("a failed per-location read renders `Couldn't load` in muted text, never 0 units", async () => {
    mockFetch({
      "/api/inventory/current-fast": (url) =>
        url.searchParams.get("locationId") === "2"
          ? { ok: false }
          : { ok: true, body: { inventory: [{ quantity: 5 }, { quantity: 7 }] } },
    });
    renderPage();

    const card = cardOf("Stock by Location");
    const backRow = (await within(card).findByText("Back")).closest(".rounded-lg") as HTMLElement;
    await waitFor(() => expect(within(backRow).getByText("Couldn't load")).toBeInTheDocument());
    expect(within(backRow).getByText("Couldn't load")).toHaveClass("text-muted-foreground");
    expect(backRow).not.toHaveTextContent(/\b0\b/);
    expect(backRow).not.toHaveTextContent(/units/);

    const mainRow = within(card).getByText("Main").closest(".rounded-lg") as HTMLElement;
    expect(mainRow).toHaveTextContent("12units");
  });

  it("a per-location read that THROWS gives that row `Couldn't load`; the card never says `No locations configured.`", async () => {
    mockFetch({
      "/api/inventory/current-fast": () => Promise.reject(new Error("network down")),
    });
    renderPage();

    const card = cardOf("Stock by Location");
    await waitFor(() => expect(within(card).getAllByText("Couldn't load")).toHaveLength(2));
    expect(within(card).queryByText("No locations configured.")).toBeNull();
  });

  it("`No locations configured.` renders only when the location list is empty (and loaded)", async () => {
    setLocation({ locations: [], selectedLocationId: null, selectedLocation: null });
    renderPage();
    expect(within(cardOf("Stock by Location")).getByText("No locations configured.")).toBeInTheDocument();
  });

  it("while the location list is still loading, the card shows no `No locations configured.`", () => {
    setLocation({ locations: [], selectedLocationId: null, selectedLocation: null, isLoading: true });
    renderPage();
    expect(within(cardOf("Stock by Location")).queryByText("No locations configured.")).toBeNull();
  });
});

describe("F0-2 — the low-stock card", () => {
  it("is titled `Below location minimum`", () => {
    renderPage();
    expect(screen.getByText("Below location minimum")).toBeInTheDocument();
  });

  it("with no location selected: `Choose a location to see low stock.`, never `All stocked up`", () => {
    setLocation({ selectedLocationId: null, selectedLocation: null });
    renderPage();
    const card = cardOf("Below location minimum");
    expect(within(card).getByText("Choose a location to see low stock.")).toBeInTheDocument();
    expect(within(card).queryByText("All stocked up")).toBeNull();
  });

  it("while the location context is loading: a skeleton, not the no-location sentence nor `All stocked up`", () => {
    setLocation({ locations: [], selectedLocationId: null, selectedLocation: null, isLoading: true });
    renderPage();
    const card = cardOf("Below location minimum");
    expect(within(card).queryByText("Choose a location to see low stock.")).toBeNull();
    expect(within(card).queryByText("All stocked up")).toBeNull();
    expect(card.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("a failed read: `Couldn't load low stock.` + Retry that refetches; never `All stocked up`", async () => {
    mockFetch({ "/api/stocker/minimums": () => ({ ok: false }) });
    renderPage();
    const card = cardOf("Below location minimum");
    expect(await within(card).findByText("Couldn't load low stock.")).toBeInTheDocument();
    expect(within(card).queryByText("All stocked up")).toBeNull();

    const before = callsTo("/api/stocker/minimums").length;
    fireEvent.click(within(card).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(callsTo("/api/stocker/minimums").length).toBe(before + 1));
  });

  it("`All stocked up` renders on a successful EMPTY answer", async () => {
    renderPage();
    const card = cardOf("Below location minimum");
    expect(await within(card).findByText("All stocked up")).toBeInTheDocument();
  });
});

describe("F0-2 — the activity feed", () => {
  it("is titled `Latest activity, all locations`", () => {
    renderPage();
    expect(screen.getByText("Latest activity, all locations")).toBeInTheDocument();
  });

  it("a failed read: `Couldn't load recent activity.` + Retry that refetches; never the empty copy", async () => {
    mockFetch({ "/api/reports/activity": () => ({ ok: false }) });
    renderPage();
    const card = cardOf("Latest activity, all locations");
    expect(await within(card).findByText("Couldn't load recent activity.")).toBeInTheDocument();
    expect(within(card).queryByText("No recent activity to show.")).toBeNull();

    const before = callsTo("/api/reports/activity").length;
    fireEvent.click(within(card).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(callsTo("/api/reports/activity").length).toBe(before + 1));
  });

  it("a failed background refresh over loaded data keeps the data (no error sentence)", async () => {
    renderPage();
    expect(await screen.findByText("Received 4 x Widget")).toBeInTheDocument();

    mockFetch({ "/api/reports/activity": () => ({ ok: false }) });
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["dashboard-activity"] });
    });
    // The query is now in ERROR with its old data; let the observer's
    // (timer-scheduled) notification reach the component before asserting.
    expect(qc.getQueryState(["dashboard-activity"])?.status).toBe("error");
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

    expect(screen.getByText("Received 4 x Widget")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load recent activity.")).toBeNull();
  });
});

describe("F0-2 — the metrics tiles", () => {
  it("a failed read keeps `--` in the tiles and adds ONE `Couldn't load the summary.` + Retry", async () => {
    mockFetch({ "/api/reports/metrics": () => ({ ok: false }) });
    renderPage();
    expect(await screen.findByText("Couldn't load the summary.")).toBeInTheDocument();
    expect(screen.getAllByText("Couldn't load the summary.")).toHaveLength(1);
    expect(screen.getAllByText("--")).toHaveLength(4);
    expect(screen.queryByText("0")).toBeNull();

    const before = callsTo("/api/reports/metrics").length;
    const line = screen.getByText("Couldn't load the summary.").parentElement as HTMLElement;
    fireEvent.click(within(line).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(callsTo("/api/reports/metrics").length).toBe(before + 1));
  });

  it("the metrics request carries startDate = now - 7 days, computed outside the query key", async () => {
    const t0 = Date.now();
    renderPage();
    await waitFor(() => expect(callsTo("/api/reports/metrics").length).toBeGreaterThan(0));

    const url = new URL(String(callsTo("/api/reports/metrics")[0][0]), "http://x");
    const startDate = url.searchParams.get("startDate");
    expect(startDate).not.toBeNull();
    const ageMs = t0 - new Date(startDate as string).getTime();
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    // calendar days (DST may move it by up to an hour); a few seconds of test time
    expect(Math.abs(ageMs - SEVEN_DAYS)).toBeLessThan(60 * 60 * 1000 + 5_000);
    expect(url.searchParams.get("locationId")).toBe("1");

    // The key is exactly [name, location] — no timestamp, so it never churns.
    const keys = qc.getQueryCache().findAll({ queryKey: ["dashboard-metrics"] }).map((q) => q.queryKey);
    expect(keys).toEqual([["dashboard-metrics", 1]]);
  });

  it("with a location: `units at <name>` and `changes at <name> in the last 7 days`", async () => {
    renderPage();
    expect(await screen.findByText("units at Main")).toBeInTheDocument();
    expect(screen.getByText("changes at Main in the last 7 days")).toBeInTheDocument();
    expect(screen.queryByText("units across all locations")).toBeNull();
  });

  it("a selected location whose name is not known yet reads `the selected location`", async () => {
    setLocation({ locations: [], selectedLocationId: 7, selectedLocation: null });
    renderPage();
    expect(await screen.findByText("units at the selected location")).toBeInTheDocument();
    expect(screen.getByText("changes at the selected location in the last 7 days")).toBeInTheDocument();
  });

  it("with no location: `units across all locations` and `changes in the last 7 days, all locations`", async () => {
    setLocation({ selectedLocationId: null, selectedLocation: null });
    renderPage();
    expect(await screen.findByText("units across all locations")).toBeInTheDocument();
    expect(screen.getByText("changes in the last 7 days, all locations")).toBeInTheDocument();
  });

  it("the low-stock tile's caption is unconditional: `in stock, at or below alert level`, never `all stocked`", async () => {
    mockFetch({
      "/api/reports/metrics": () => ({ ok: true, body: { metrics: { ...METRICS.metrics, lowStockProducts: 0 } } }),
    });
    renderPage();
    expect(await screen.findByText("in stock, at or below alert level")).toBeInTheDocument();
    expect(screen.queryByText("all stocked")).toBeNull();
    expect(screen.queryByText("products below threshold")).toBeNull();
  });
});
