/** @jest-environment jsdom */
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { AnalyticsHub } from "@/components/analytics/analytics-hub";
import type { HubResponse } from "@/lib/analytics/hub";

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
    render(<AnalyticsHub />);
  });
  // Names appear in both the Top-movers card and the table, so match all occurrences.
  expect(screen.getAllByText("Widget Alpha").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Gadget Bravo").length).toBeGreaterThan(0);
  // Revenue is rendered verbatim from the serialized string (table-only at the default
  // units sort, so it is unique here).
  expect(screen.getByText("199.50")).toBeInTheDocument();
});

test("typing in search feeds the hook's filters (debounced search arg)", async () => {
  mockHook.mockReturnValue(hookState({ data: rows }));
  await act(async () => {
    render(<AnalyticsHub />);
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
    render(<AnalyticsHub />);
  });
  expect(screen.getByTestId("analytics-hub-loading")).toBeInTheDocument();
});

test("error state shows an inline message and a Retry that calls refetch", async () => {
  mockHook.mockReturnValue(hookState({ isError: true }));
  await act(async () => {
    render(<AnalyticsHub />);
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
    render(<AnalyticsHub />);
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
    render(<AnalyticsHub />);
  });
  await waitFor(() =>
    expect(screen.getByText(/9 orders unattributed/i)).toBeInTheDocument()
  );
});

test("does NOT render the unattributed note when unattributed === 0", async () => {
  mockHook.mockReturnValue(hookState({ data: rows }));
  await act(async () => {
    render(<AnalyticsHub />);
  });
  // Give the rebuild-state fetch a tick to resolve.
  await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  expect(screen.queryByText(/orders unattributed/i)).not.toBeInTheDocument();
});
