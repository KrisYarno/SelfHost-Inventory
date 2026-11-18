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
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";

// recharts is lazy-loaded behind next/dynamic; the sparkline is not under test.
jest.mock("@/components/ui/sparkline", () => ({ Sparkline: () => null }));

type Loc = { id: number; name: string };
let mockLocation: {
  locations: Loc[];
  selectedLocationId: number | null;
  selectedLocation: Loc | null;
  isLoading: boolean;
  setSelectedLocationId: jest.Mock;
  loadFailed: boolean;
  retryLocations: jest.Mock;
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
    loadFailed: false,
    retryLocations: jest.fn(),
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
    // FR1-4: one location's read throws, the other answers — a PARTIAL failure
    // stays per row (every read failing is the card's failure, pinned below).
    mockFetch({
      "/api/inventory/current-fast": (url) =>
        url.searchParams.get("locationId") === "2"
          ? Promise.reject(new Error("network down"))
          : { ok: true, body: { inventory: [{ quantity: 5 }, { quantity: 7 }] } },
    });
    renderPage();

    const card = cardOf("Stock by Location");
    await waitFor(() => expect(within(card).getAllByText("Couldn't load")).toHaveLength(1));
    const backRow = within(card).getByText("Back").closest(".rounded-lg") as HTMLElement;
    expect(within(backRow).getByText("Couldn't load")).toBeInTheDocument();
    expect(within(card).queryByText("No locations configured.")).toBeNull();
    expect(within(card).queryByText("Couldn't load stock by location.")).toBeNull();
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

// ---------------------------------------------------------------------------
// Facelift F0 FR1-3 — a failed locations read is not "no locations"
// ---------------------------------------------------------------------------

describe("FR1-3 — the location list failed to load", () => {
  const failedLocations = () =>
    setLocation({ locations: [], selectedLocationId: null, selectedLocation: null, loadFailed: true });

  it("stock by location: `Couldn't load locations.` + Retry (retryLocations), never `No locations configured.`", () => {
    failedLocations();
    renderPage();
    const card = cardOf("Stock by Location");
    expect(within(card).getByText("Couldn't load locations.")).toBeInTheDocument();
    expect(within(card).queryByText("No locations configured.")).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: "Retry" }));
    expect(mockLocation.retryLocations).toHaveBeenCalledTimes(1);
  });

  it("low stock: `Couldn't load locations.` + Retry (retryLocations), never `Choose a location to see low stock.`", () => {
    failedLocations();
    renderPage();
    const card = cardOf("Below location minimum");
    expect(within(card).getByText("Couldn't load locations.")).toBeInTheDocument();
    expect(within(card).queryByText("Choose a location to see low stock.")).toBeNull();
    expect(within(card).queryByText("All stocked up")).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: "Retry" }));
    expect(mockLocation.retryLocations).toHaveBeenCalledTimes(1);
  });

  it("a restored location id with the list failed: low stock still says the list failed; captions keep their fallback", async () => {
    setLocation({ locations: [], selectedLocationId: 7, selectedLocation: null, loadFailed: true });
    renderPage();
    const card = cardOf("Below location minimum");
    expect(within(card).getByText("Couldn't load locations.")).toBeInTheDocument();
    expect(await screen.findByText("units at the selected location")).toBeInTheDocument();
    expect(screen.getByText("changes at the selected location in the last 7 days")).toBeInTheDocument();
  });

  it("while a retry is loading: skeletons, not the failure sentence", () => {
    setLocation({ locations: [], selectedLocationId: null, selectedLocation: null, loadFailed: true, isLoading: true });
    renderPage();
    expect(screen.queryByText("Couldn't load locations.")).toBeNull();
    expect(cardOf("Below location minimum").querySelector(".animate-pulse")).not.toBeNull();
  });

  it("a failed refresh over a LOADED list keeps the list (no failure sentence)", async () => {
    setLocation({ loadFailed: true });
    renderPage();
    const card = cardOf("Stock by Location");
    expect(await within(card).findByText("Main")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load locations.")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Facelift F0 FR1-4 — every per-location read failed: the card says so once
// ---------------------------------------------------------------------------

describe("FR1-4 — stock by location when every read failed", () => {
  it.each([
    ["refused", () => ({ ok: false })],
    ["thrown", () => Promise.reject(new Error("network down"))],
  ])("every read %s: `Couldn't load stock by location.` + Retry that refetches, and no per-row unknowns", async (_label, responder) => {
    mockFetch({ "/api/inventory/current-fast": responder as Responder });
    renderPage();

    const card = cardOf("Stock by Location");
    expect(await within(card).findByText("Couldn't load stock by location.")).toBeInTheDocument();
    expect(within(card).queryByText("Couldn't load")).toBeNull();
    expect(within(card).queryByText(/units/)).toBeNull();

    const before = callsTo("/api/inventory/current-fast").length;
    fireEvent.click(within(card).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(callsTo("/api/inventory/current-fast").length).toBe(before + 2));
  });
});

// ---------------------------------------------------------------------------
// Facelift F0 FR1-5 — the empty copy only on an answer
// ---------------------------------------------------------------------------

describe("FR1-5 — the activity feed while the read is paused (offline)", () => {
  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it("a paused read is pending: a skeleton, never `No recent activity to show.`", async () => {
    onlineManager.setOnline(false);
    renderPage();
    const card = cardOf("Latest activity, all locations");
    await act(async () => {});
    expect(qc.getQueryState(["dashboard-activity"])?.fetchStatus).toBe("paused");
    expect(within(card).queryByText("No recent activity to show.")).toBeNull();
    expect(card.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("a successful empty answer still reads `No recent activity to show.`", async () => {
    mockFetch({ "/api/reports/activity": () => ({ ok: true, body: { activities: [] } }) });
    renderPage();
    expect(
      await within(cardOf("Latest activity, all locations")).findByText("No recent activity to show."),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Facelift F0 FR1-11 — a failed refresh keeps the data
// ---------------------------------------------------------------------------

describe("FR1-11 — a failed background refresh over loaded data keeps the data", () => {
  /** Refetch `key` against a now-failing route; wait for the error to reach the page. */
  async function failRefresh(key: unknown[], over: Record<string, Responder>) {
    mockFetch(over);
    await act(async () => {
      await qc.refetchQueries({ queryKey: key });
    });
    expect(qc.getQueryState(key)?.status).toBe("error");
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  }

  it("the metrics tiles keep their numbers, with no `Couldn't load the summary.`", async () => {
    renderPage();
    expect(await screen.findByText("340")).toBeInTheDocument();

    await failRefresh(["dashboard-metrics", 1], { "/api/reports/metrics": () => ({ ok: false }) });

    expect(screen.getByText("340")).toBeInTheDocument();
    expect(screen.getByText("Total Products").parentElement).toHaveTextContent("12");
    expect(screen.queryByText("--")).toBeNull();
    expect(screen.queryByText("Couldn't load the summary.")).toBeNull();
  });

  it("the low-stock list keeps its rows, with no `Couldn't load low stock.`", async () => {
    mockFetch({
      "/api/stocker/minimums": () => ({
        ok: true,
        body: {
          items: [
            { productId: 3, productName: "Gadget", locationId: 1, locationName: "Main", currentQuantity: 2, minQuantity: 10, shortage: 8 },
          ],
        },
      }),
    });
    renderPage();
    const card = cardOf("Below location minimum");
    expect(await within(card).findByText("Gadget")).toBeInTheDocument();

    await failRefresh(["dashboard-low-stock", 1], { "/api/stocker/minimums": () => ({ ok: false }) });

    expect(within(card).getByText("Gadget")).toBeInTheDocument();
    expect(within(card).queryByText("Couldn't load low stock.")).toBeNull();
  });

  it("stock by location keeps its rows, with no `Couldn't load stock by location.`", async () => {
    renderPage();
    const card = cardOf("Stock by Location");
    const mainRow = (await within(card).findByText("Main")).closest(".rounded-lg") as HTMLElement;
    await waitFor(() => expect(mainRow).toHaveTextContent("12units"));

    await failRefresh(["dashboard-location-stock", "1,2"], {
      "/api/inventory/current-fast": () => ({ ok: false }),
    });

    const row = within(card).getByText("Main").closest(".rounded-lg") as HTMLElement;
    expect(row).toHaveTextContent("12units");
    expect(within(card).queryByText("Couldn't load stock by location.")).toBeNull();
    expect(within(card).queryByText("Couldn't load")).toBeNull();
  });
});
