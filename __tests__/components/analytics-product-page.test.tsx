/** @jest-environment jsdom */
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import ProductAnalyticsPage from "@/app/(app)/analytics/product/[id]/page";

// The page reads the product id from the route via useParams().
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "42" }),
}));

// The page renders the memberships-only company scope selector. Stub the hook so the
// selector renders its default option without a real /api/companies/user fetch.
jest.mock("@/hooks/use-external-orders", () => ({
  useUserCompanies: () => ({ data: { companies: [] }, isLoading: false, error: null }),
}));

// recharts ResponsiveContainer has no measurable size in jsdom; stub the chart wrappers
// to testable placeholders so we assert the page WIRES charts (structure-first) rather
// than pixel-rendering. The real wrappers are covered by their own usage.
jest.mock("@/components/reports/inventory-chart", () => ({
  LineChartComponent: ({ title }: { title?: string }) => (
    <div data-testid="line-chart">{title}</div>
  ),
  BarChartComponent: ({ title }: { title?: string }) => (
    <div data-testid="bar-chart">{title}</div>
  ),
}));

// Sparkline also relies on ResponsiveContainer; stub to a placeholder.
jest.mock("@/components/ui/sparkline", () => ({
  Sparkline: () => <div data-testid="sparkline" />,
}));

// T9: export surface. Mock the export utils so we assert the page WIRES them
// (chart PNG via exportChartAsImage, series CSV via exportToCSV) without invoking
// html2canvas / triggering a real browser download in jsdom.
jest.mock("@/lib/export-utils", () => ({
  exportToCSV: jest.fn(),
  exportChartAsImage: jest.fn(),
  generateExportFilename: jest.fn(
    (prefix: string, ext: string) => `${prefix}.${ext}`,
  ),
}));
import {
  exportToCSV,
  exportChartAsImage,
  generateExportFilename,
} from "@/lib/export-utils";

const NOTE =
  "revenue = direct (non-bundle) sales only; bundle units are included, bundle revenue is not represented";

// Route fetch by URL. The page hits TWO endpoints:
//   /api/analytics/product/<id>  -> { productId, stock:{series,mode}, sales:{series,mode,note} }
//   /api/analytics/sales?...     -> { series, groupBy, mode, note } (day grain, for the chart)
function installFetch(opts: {
  product: unknown;
  sales?: unknown;
  productOk?: boolean;
}) {
  global.fetch = jest.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.startsWith("/api/analytics/product/")) {
      return {
        ok: opts.productOk ?? true,
        json: async () => opts.product,
      } as unknown as Response;
    }
    if (u.startsWith("/api/analytics/sales")) {
      return {
        ok: true,
        json: async () => opts.sales ?? { series: [], groupBy: "day", mode: "x", note: NOTE },
      } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.clearAllMocks();
});

it("renders the stock chart, the company scope selector, and date-range inputs", async () => {
  installFetch({
    product: {
      productId: 42,
      stock: {
        series: [
          { dayKey: "2026-06-01", locationId: 3, quantity: 120 },
          { dayKey: "2026-06-02", locationId: 3, quantity: 100 },
        ],
        mode: "historical (GLOBAL inventory)",
      },
      sales: { series: [], mode: "historical (your companies)", note: NOTE },
    },
  });

  render(<ProductAnalyticsPage />);

  // The stock series is rendered as a recharts line chart (via the wrapper), not a table.
  await waitFor(() => expect(screen.getByTestId("line-chart")).toBeInTheDocument());

  // Company scope selector (memberships-only) is present.
  expect(screen.getByText("All my companies")).toBeInTheDocument();

  // Date-range control: two date inputs (from / to).
  const dateInputs = document.querySelectorAll('input[type="date"]');
  expect(dateInputs.length).toBe(2);
});

it("renders a sales chart and the verbatim bundle-revenue note when sales exist", async () => {
  installFetch({
    product: {
      productId: 42,
      stock: { series: [], mode: "historical (GLOBAL inventory)" },
      sales: {
        series: [
          {
            productId: 42,
            _sum: { orderedQty: 10, fulfilledQty: 8, revenue: "199.50", orderCount: 4 },
          },
        ],
        mode: "historical (your companies)",
        note: NOTE,
      },
    },
    sales: {
      series: [{ dayKey: "2026-06-01", _sum: { orderedQty: 10, revenue: "199.50" } }],
      groupBy: "day",
      mode: "historical",
      note: NOTE,
    },
  });

  render(<ProductAnalyticsPage />);

  await waitFor(() => expect(screen.getByTestId("bar-chart")).toBeInTheDocument());
  // The bundle-revenue note must stay visible so revenue isn't misread.
  expect(screen.getByText(NOTE)).toBeInTheDocument();
});

it("does NOT render a 'Fulfilled' column/metric (structurally 0), and notes its omission", async () => {
  installFetch({
    product: {
      productId: 42,
      stock: {
        series: [{ dayKey: "2026-06-01", locationId: 3, quantity: 120 }],
        mode: "historical (GLOBAL inventory)",
      },
      sales: {
        series: [
          {
            productId: 42,
            _sum: { orderedQty: 10, fulfilledQty: 8, revenue: "199.50", orderCount: 4 },
          },
        ],
        mode: "historical (your companies)",
        note: NOTE,
      },
    },
  });

  render(<ProductAnalyticsPage />);

  await waitFor(() => expect(screen.getByTestId("line-chart")).toBeInTheDocument());
  // The Fulfilled column/metric is hidden entirely; only the omission note may mention it.
  expect(screen.queryByText(/^fulfilled units$/i)).not.toBeInTheDocument();
  expect(screen.getByText(/fulfilled units are not yet populated/i)).toBeInTheDocument();
});

it("renders the stock-trend sparkline when the stock series has >= 2 days", async () => {
  installFetch({
    product: {
      productId: 42,
      stock: {
        series: [
          { dayKey: "2026-06-01", locationId: 3, quantity: 120 },
          { dayKey: "2026-06-02", locationId: 3, quantity: 90 },
        ],
        mode: "historical (GLOBAL inventory)",
      },
      sales: { series: [], mode: "historical (your companies)", note: NOTE },
    },
  });

  render(<ProductAnalyticsPage />);

  await waitFor(() => expect(screen.getByTestId("sparkline")).toBeInTheDocument());
});

it("exports the stock chart as a PNG via exportChartAsImage when data is present", async () => {
  installFetch({
    product: {
      productId: 42,
      stock: {
        series: [
          { dayKey: "2026-06-01", locationId: 3, quantity: 120 },
          { dayKey: "2026-06-02", locationId: 3, quantity: 100 },
        ],
        mode: "historical (GLOBAL inventory)",
      },
      sales: { series: [], mode: "historical (your companies)", note: NOTE },
    },
  });

  render(<ProductAnalyticsPage />);

  await waitFor(() => expect(screen.getByTestId("line-chart")).toBeInTheDocument());

  const pngButton = screen.getByRole("button", { name: /export chart/i });
  await act(async () => {
    fireEvent.click(pngButton);
  });

  expect(generateExportFilename).toHaveBeenCalledWith("product-analytics", "png");
  expect(exportChartAsImage).toHaveBeenCalledTimes(1);
  // First arg must be the chart DOM element (the wrapping div the ref is attached to).
  const el = (exportChartAsImage as jest.Mock).mock.calls[0][0];
  expect(el).toBeInstanceOf(HTMLElement);
});

it("exports the stock + sales series as a CSV via exportToCSV when data is present", async () => {
  installFetch({
    product: {
      productId: 42,
      stock: {
        series: [
          { dayKey: "2026-06-01", locationId: 3, quantity: 120 },
          { dayKey: "2026-06-02", locationId: 3, quantity: 100 },
        ],
        mode: "historical (GLOBAL inventory)",
      },
      sales: { series: [], mode: "historical (your companies)", note: NOTE },
    },
    sales: {
      series: [{ dayKey: "2026-06-01", _sum: { orderedQty: 4, revenue: "10.00" } }],
      groupBy: "day",
      mode: "historical",
      note: NOTE,
    },
  });

  render(<ProductAnalyticsPage />);

  await waitFor(() => expect(screen.getByTestId("line-chart")).toBeInTheDocument());

  const csvButton = screen.getByRole("button", { name: /export csv/i });
  await act(async () => {
    fireEvent.click(csvButton);
  });

  expect(generateExportFilename).toHaveBeenCalledWith("product-analytics", "csv");
  expect(exportToCSV).toHaveBeenCalledTimes(1);
  // The exported rows must include the per-day stock series (date + quantity).
  const rows = (exportToCSV as jest.Mock).mock.calls[0][0] as Array<Record<string, unknown>>;
  expect(Array.isArray(rows)).toBe(true);
  expect(rows.length).toBeGreaterThan(0);
});

it("renders the empty state when both series are empty", async () => {
  installFetch({
    product: {
      productId: 42,
      stock: { series: [], mode: "historical (GLOBAL inventory)" },
      sales: { series: [], mode: "historical (your companies)", note: NOTE },
    },
  });

  render(<ProductAnalyticsPage />);

  await waitFor(() =>
    expect(screen.getByText(/no analytics yet/i)).toBeInTheDocument(),
  );
});

it("renders an error state when the per-product fetch fails", async () => {
  installFetch({
    product: {},
    productOk: false,
  });

  render(<ProductAnalyticsPage />);

  await waitFor(() =>
    expect(screen.getByText(/could not load analytics/i)).toBeInTheDocument(),
  );
});
