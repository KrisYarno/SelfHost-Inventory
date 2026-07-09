/** @jest-environment jsdom */
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AnalyticsHub } from "@/components/analytics/analytics-hub";
import type { HubResponse } from "@/lib/analytics/hub";

// The hub's rebuild-state note now reads via useQuery, so renders need a client. A fresh
// client per render keeps that best-effort fetch isolated from the mocked products hook.
function renderHub() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AnalyticsHub />
    </QueryClientProvider>
  );
}

// The hub composes the data hook + the (separately tested) scope selector. Stub the
// selector to a plain control so this test focuses on the hub's own behavior.
jest.mock("@/components/analytics/company-scope-select", () => ({
  CompanyScopeSelect: ({
    onChange,
  }: {
    value: string | undefined;
    onChange: (id: string | undefined) => void;
  }) => (
    <button data-testid="scope" onClick={() => onChange("c1")}>
      scope
    </button>
  ),
}));

jest.mock("@/hooks/use-analytics-products", () => ({
  useAnalyticsProducts: jest.fn(),
}));
import { useAnalyticsProducts } from "@/hooks/use-analytics-products";
const mockHook = useAnalyticsProducts as jest.Mock;

const refetch = jest.fn();

function hookState(over: Partial<ReturnType<typeof baseState>> = {}) {
  return { ...baseState(), ...over };
}
function baseState() {
  return {
    data: undefined as HubResponse | undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch,
  };
}

const rows: HubResponse = {
  products: [
    {
      productId: 1,
      name: "Widget Alpha",
      currentStock: 12,
      units: 50,
      orderCount: 5,
      revenue: "199.50",
      productStockTrend: { value: 20, direction: "up" },
    },
    {
      productId: 2,
      name: "Gadget Bravo",
      currentStock: 0,
      units: 3,
      orderCount: 1,
      revenue: "0.00",
      productStockTrend: null,
    },
  ],
  total: 2,
  page: 1,
  pageSize: 25,
};

beforeEach(() => {
  jest.clearAllMocks();
  // Default: the rebuild-state note fetch returns 0 unattributed (note hidden).
  global.fetch = jest.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes("/api/analytics/rebuild-state")) {
      return {
        ok: true,
        json: async () => ({ unattributed: 0, lastRunAt: null }),
      } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
});

test("renders a row per product with stock/units/revenue", async () => {
  mockHook.mockReturnValue(hookState({ data: rows }));
  await act(async () => {
    renderHub();
  });
  // Names appear in both the Top-movers card and the table, so match all occurrences.
  expect(screen.getAllByText("Widget Alpha").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Gadget Bravo").length).toBeGreaterThan(0);
  // Revenue is rendered verbatim from the serialized string. Under jsdom there is no real
  // viewport, so BOTH the `hidden md:block` table AND the `md:hidden` mobile card render into
  // the DOM (T4) — so "199.50" appears in the table cell and again in the card. Match all
  // occurrences rather than asserting a single match.
  expect(screen.getAllByText("199.50").length).toBeGreaterThanOrEqual(1);
});

test("typing in search feeds the hook's filters (debounced search arg)", async () => {
  mockHook.mockReturnValue(hookState({ data: rows }));
  await act(async () => {
    renderHub();
  });
  const input = screen.getByPlaceholderText(/search products/i);
  await act(async () => {
    fireEvent.change(input, { target: { value: "alpha" } });
  });
  // The hook is called again with the new search term in its filters object.
  await waitFor(() =>
    expect(mockHook).toHaveBeenCalledWith(
      expect.objectContaining({ search: "alpha" })
    )
  );
});

test("loading state shows skeleton placeholders (no rows yet)", async () => {
  mockHook.mockReturnValue(hookState({ isLoading: true }));
  await act(async () => {
    renderHub();
  });
  expect(screen.getByTestId("analytics-hub-loading")).toBeInTheDocument();
});

test("error state shows an inline message and a Retry that calls refetch", async () => {
  mockHook.mockReturnValue(hookState({ isError: true }));
  await act(async () => {
    renderHub();
  });
  expect(screen.getByText(/could not load analytics/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /retry/i }));
  expect(refetch).toHaveBeenCalled();
});

test("empty state (no products, no search/filter) shows 'No products yet'", async () => {
  mockHook.mockReturnValue(
    hookState({ data: { products: [], total: 0, page: 1, pageSize: 25 } })
  );
  await act(async () => {
    renderHub();
  });
  expect(screen.getByText(/no products yet/i)).toBeInTheDocument();
});

test("renders the single global unattributed note when unattributed > 0", async () => {
  global.fetch = jest.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes("/api/analytics/rebuild-state")) {
      return {
        ok: true,
        json: async () => ({ unattributed: 9, lastRunAt: "2026-06-05T00:00:00.000Z" }),
      } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
  mockHook.mockReturnValue(hookState({ data: rows }));
  await act(async () => {
    renderHub();
  });
  await waitFor(() =>
    expect(screen.getByText(/9 orders unattributed/i)).toBeInTheDocument()
  );
});

test("does NOT render the unattributed note when unattributed === 0", async () => {
  mockHook.mockReturnValue(hookState({ data: rows }));
  await act(async () => {
    renderHub();
  });
  // Give the rebuild-state fetch a tick to resolve.
  await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  expect(screen.queryByText(/orders unattributed/i)).not.toBeInTheDocument();
});

// --- T4: mobile card list (md-breakpoint swap) -------------------------------
// Under jsdom both presentations render (no viewport); scope to the cards container via
// the `analytics-hub-cards` testid so these assert on the mobile card presentation only.

test("mobile cards render a whole-card link per product to /analytics/product/<id>", async () => {
  mockHook.mockReturnValue(hookState({ data: rows }));
  await act(async () => {
    renderHub();
  });
  const cards = screen.getByTestId("analytics-hub-cards");
  const links = within(cards).getAllByRole("link");
  expect(links).toHaveLength(2);
  // The whole card is the link, targeting the per-product page.
  const alpha = within(cards).getByText("Widget Alpha").closest("a");
  expect(alpha).toHaveAttribute("href", "/analytics/product/1");
  const bravo = within(cards).getByText("Gadget Bravo").closest("a");
  expect(bravo).toHaveAttribute("href", "/analytics/product/2");
});

test("mobile cards show a LABELED stock trend (not a bare arrow)", async () => {
  mockHook.mockReturnValue(hookState({ data: rows }));
  await act(async () => {
    renderHub();
  });
  const cards = screen.getByTestId("analytics-hub-cards");
  // One "Stock trend" label per card, so the % is unambiguously the trend.
  expect(within(cards).getAllByText(/stock trend/i)).toHaveLength(2);
});

test("mobile cards render revenue verbatim with a matching title attribute", async () => {
  mockHook.mockReturnValue(hookState({ data: rows }));
  await act(async () => {
    renderHub();
  });
  const cards = screen.getByTestId("analytics-hub-cards");
  // Revenue is shown as-is (never reformatted) and carries title={revenue} for the
  // truncated long-string case.
  const revenue = within(cards).getByText("199.50");
  const dd = revenue.closest("dd");
  expect(dd).toHaveAttribute("title", "199.50");
});

test("mobile cards expose the four metric labels", async () => {
  mockHook.mockReturnValue(hookState({ data: rows }));
  await act(async () => {
    renderHub();
  });
  const cards = screen.getByTestId("analytics-hub-cards");
  const firstCard = within(cards).getByText("Widget Alpha").closest("a") as HTMLElement;
  const card = within(firstCard);
  expect(card.getByText("Current stock")).toBeInTheDocument();
  expect(card.getByText("Units sold")).toBeInTheDocument();
  expect(card.getByText("Orders")).toBeInTheDocument();
  expect(card.getByText("Revenue")).toBeInTheDocument();
});
