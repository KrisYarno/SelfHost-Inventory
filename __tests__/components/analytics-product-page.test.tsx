/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import ProductAnalyticsPage from "@/app/(app)/analytics/product/[id]/page";

// The page reads the product id from the route via useParams().
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "42" }),
}));

// Route fetch by URL. Mirrors the per-product analytics endpoint shape:
// { productId, stock: { series, mode }, sales: { series, mode, note } }.
function installFetch(payload: unknown) {
  global.fetch = jest.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.startsWith("/api/analytics/product/")) {
      return { ok: true, json: async () => payload } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

const NOTE =
  "revenue = direct (non-bundle) sales only; bundle units are included, bundle revenue is not represented";

afterEach(() => {
  jest.clearAllMocks();
});

it("renders the stock + sales sections, a stock row, and the bundle-revenue note", async () => {
  installFetch({
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
  });

  render(<ProductAnalyticsPage />);

  // Stock section + a row from the stock series.
  await waitFor(() =>
    expect(screen.getByText(/stock level over time/i)).toBeInTheDocument(),
  );
  expect(screen.getByText("2026-06-01")).toBeInTheDocument();
  expect(screen.getByText("120")).toBeInTheDocument();

  // Sales section + the bundle-revenue note must be visible so revenue isn't misread.
  // (CardTitle renders as a div, not a heading role, so match by text.)
  expect(screen.getByText(/^sales$/i)).toBeInTheDocument();
  expect(screen.getByText(NOTE)).toBeInTheDocument();
});

it("renders an empty state when both series are empty", async () => {
  installFetch({
    productId: 42,
    stock: { series: [], mode: "historical (GLOBAL inventory)" },
    sales: { series: [], mode: "historical (your companies)", note: NOTE },
  });

  render(<ProductAnalyticsPage />);

  await waitFor(() =>
    expect(screen.getByText(/no analytics yet/i)).toBeInTheDocument(),
  );
});
