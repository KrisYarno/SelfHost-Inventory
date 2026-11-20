/** @jest-environment jsdom */
//
// Facelift F2 FR1-12 (plan 2026-11-19-facelift-f2, REV 7) — THE LIST SURVIVES
// A TRIP TO DELETED. The Products page keeps the REAL `ProductListOptimized`
// mounted while the deleted view shows (hidden with `hidden`), so the stock
// filter, the page and the search the user set are all still there when they
// come back. Before, the deleted view unmounted the list and every one of them
// was lost.

import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "next-auth/react";

jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));
jest.mock("@/contexts/location-context", () => ({
  useLocation: () => ({
    selectedLocation: { id: 1, name: "Main" },
    selectedLocationId: 1,
    isLoading: false,
    loadFailed: false,
  }),
}));
jest.mock("@/components/products/deleted-products-list", () => ({
  DeletedProductsList: () => <div data-testid="deleted-list" />,
}));
jest.mock("@/components/products/create-product-dialog", () => ({ CreateProductDialog: () => null }));
jest.mock("@/components/products/edit-product-dialog", () => ({ EditProductDialog: () => null }));
jest.mock("@/components/products/delete-product-dialog", () => ({ DeleteProductDialog: () => null }));
jest.mock("@/components/inventory/quick-adjust-dialog", () => ({ QuickAdjustDialog: () => null }));
jest.mock("@/components/inventory/stock-in-dialog", () => ({ StockInDialog: () => null }));

import ProductsPage from "@/app/(app)/products/page";

type Row = { id: number; name: string; baseName: string; stockState: "ok" | "low"; totalQuantity: number };
const ROWS: Row[] = Array.from({ length: 80 }, (_, i) => ({
  id: i + 1,
  name: `Product ${i + 1}`,
  baseName: `Base ${i + 1}`,
  // Every other product is low: 40 low, 40 ok.
  stockState: i % 2 === 0 ? "low" : "ok",
  totalQuantity: i % 2 === 0 ? 3 : 50,
}));

let fetchMock: jest.Mock;
beforeEach(() => {
  (useSession as jest.Mock).mockReturnValue({ data: { user: { id: "1", isAdmin: true } }, status: "authenticated" });
  Object.defineProperty(Element.prototype, "scrollTo", { value: jest.fn(), configurable: true, writable: true });
  fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://x");
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 25);
    const search = url.searchParams.get("search") ?? "";
    const stock = url.searchParams.get("stock") ?? "all";
    let matching = ROWS.filter((r) => r.name.includes(search));
    if (stock === "low") matching = matching.filter((r) => r.stockState === "low");
    const products = matching.slice((page - 1) * pageSize, page * pageSize).map((r) => ({
      ...r,
      variant: null,
      approvalStatus: "APPROVED",
      currentQuantity: r.totalQuantity,
      hereQuantity: r.totalQuantity,
      lowStockThreshold: null,
      costPrice: null,
      retailPrice: null,
    }));
    const body = {
      products,
      total: matching.length,
      page,
      pageSize,
      totalPages: Math.ceil(matching.length / pageSize),
      hereLocationId: Number(url.searchParams.get("hereLocationId")) || null,
      stock,
      search,
    };
    return { ok: true, json: async () => body } as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  delete (Element.prototype as unknown as { scrollTo?: unknown }).scrollTo;
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProductsPage />
    </QueryClientProvider>
  );
}

const header = () => screen.getByRole("banner");
const searchBox = () => screen.getByRole("searchbox", { name: "Search products", hidden: true }) as HTMLInputElement;
const filterButton = (name: string) =>
  within(screen.getByRole("group", { name: "Stock filter", hidden: true })).getByRole("button", { name, hidden: true });
const listRoot = () => searchBox().closest(".space-y-3") as HTMLElement;

describe("FR1-12 — the filter, page and search survive a trip to Deleted and back", () => {
  it("Low + `Product` + page 2 -> Deleted (the list hidden, still mounted) -> back: all three are still set, with no new read", async () => {
    renderPage();
    await screen.findByText("Showing 1–25 of 80 products");

    fireEvent.click(filterButton("Low"));
    await screen.findByText("Showing 1–25 of 40 low-stock products");
    fireEvent.change(searchBox(), { target: { value: "Product" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Showing 26–40 of 40 low-stock products");
    const readsBefore = fetchMock.mock.calls.length;

    const deleted = within(header()).getByRole("button", { name: "Deleted products" });
    fireEvent.click(deleted);
    expect(screen.getByTestId("deleted-list")).toBeInTheDocument();
    expect(listRoot()).toHaveClass("hidden");
    // Still mounted: its state is still there while hidden.
    expect(searchBox().value).toBe("Product");

    fireEvent.click(deleted);
    expect(screen.queryByTestId("deleted-list")).toBeNull();
    expect(listRoot()).not.toHaveClass("hidden");
    expect(searchBox().value).toBe("Product");
    expect(filterButton("Low")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(screen.getByText("Showing 26–40 of 40 low-stock products")).toBeInTheDocument();
    // Nothing was re-read for the trip (the list never remounted).
    expect(fetchMock.mock.calls.length).toBe(readsBefore);
  });
});
