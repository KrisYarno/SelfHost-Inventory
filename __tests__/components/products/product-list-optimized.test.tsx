/** @jest-environment jsdom */
//
// Facelift F0-5 and F0-6 (plan 2026-11-17-facelift-f0 + the REV 2 folds) — the
// products list says how much it is showing, and it follows `?search=`.
//
// F0-5 (interim; server-side filtering and a full export are F2). Before: the
// summary counted the 25 rows on screen as "N products • M categories", the
// stock filter's count read as a catalogue count, the filtered empty state said
// "No products found", and "Export CSV" exported one page as if it were all.
// Now the summary reads `Showing from–to of total products` from the response,
// the filter count is "on this page", and the export says "this page".
//
// F0-6. Before: every global-search result went to the unfiltered /products.
// Now a result links to `/products?search=<name>`, the list seeds its search box
// from that value on first mount (so there is no unfiltered first fetch), and
// re-seeds whenever the value changes while it is mounted. Typing never writes
// the URL; clearing the box with its X drops a present `search` param.
//
// FR2-3 (REV 7): dropping the param is not a navigation — it is a plain
// `history.replaceState(null, "", "/products")` (Next 14.2 keeps
// `useSearchParams` in sync with it), never `router.replace`, which went to the
// server on a keystroke. The drop pins below assert BOTH halves.

import * as React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let mockSearchParams = new URLSearchParams();
const mockRouter = { replace: jest.fn(), push: jest.fn() };
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => mockRouter,
}));

let mockIsMobile = false;
jest.mock("@/hooks/use-is-mobile", () => ({ useIsMobile: () => mockIsMobile }));

jest.mock("@/components/products/product-card", () => ({
  ProductCard: ({ product }: { product: { name: string } }) => <div data-testid="product-row">{product.name}</div>,
}));
jest.mock("@/components/products/product-card-mobile", () => ({
  ProductCardMobile: ({ product }: { product: { name: string } }) => (
    <div data-testid="product-row">{product.name}</div>
  ),
}));
// The phone's filter sheet is the only stock-filter control; a plain stand-in.
jest.mock("@/components/products/mobile-filter-sheet", () => ({
  MobileFilterSheet: ({
    onStockFilterChange,
    onClearFilters,
  }: {
    onStockFilterChange: (f: string) => void;
    onClearFilters: () => void;
  }) => (
    <div>
      <button onClick={() => onStockFilterChange("out-of-stock")}>filter: out of stock</button>
      <button onClick={() => onStockFilterChange("all")}>filter: all</button>
      <button onClick={onClearFilters}>clear filters</button>
    </div>
  ),
}));
const mockExportToCSV = jest.fn();
jest.mock("@/lib/export-utils", () => ({
  exportToCSV: (...args: unknown[]) => mockExportToCSV(...args),
}));
const mockToastSuccess = jest.fn();
jest.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => mockToastSuccess(...a), error: jest.fn() } }));

import { ProductListOptimized } from "@/components/products/product-list-optimized";

type Row = { id: number; name: string; baseName: string; currentQuantity: number; lowStockThreshold: number | null };

/** A catalogue of `total` products; `outOfStock` ids have quantity 0. */
function catalogue(total: number, outOfStock: number[] = []): Row[] {
  return Array.from({ length: total }, (_, i) => ({
    id: i + 1,
    name: `Product ${i + 1}`,
    baseName: `Base ${i + 1}`,
    currentQuantity: outOfStock.includes(i + 1) ? 0 : 50,
    lowStockThreshold: null,
  }));
}

let rows: Row[] = [];
let fetchMock: jest.Mock;
function mockFetch() {
  fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://x");
    if (url.pathname === "/api/settings/low-stock-default") {
      return { ok: true, json: async () => ({ threshold: 10 }) } as Response;
    }
    if (url.pathname === "/api/products/optimized") {
      const page = Number(url.searchParams.get("page") ?? 1);
      const pageSize = Number(url.searchParams.get("pageSize") ?? 25);
      const search = url.searchParams.get("search") ?? "";
      const matching = rows.filter((r) => r.name.includes(search));
      const slice = matching.slice((page - 1) * pageSize, page * pageSize);
      return {
        ok: true,
        json: async () => ({ products: slice, total: matching.length, page, pageSize }),
      } as Response;
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
}

const productCalls = () =>
  fetchMock.mock.calls
    .map(([u]) => new URL(String(u), "http://x"))
    .filter((u) => u.pathname === "/api/products/optimized");

function tree(qc: QueryClient) {
  return (
    <QueryClientProvider client={qc}>
      <ProductListOptimized />
    </QueryClientProvider>
  );
}

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(tree(qc));
  return { ...utils, rerenderList: () => utils.rerender(tree(qc)) };
}

const searchBox = () => screen.getByPlaceholderText(/Search/) as HTMLInputElement;
/** FR2-3: the list's only way to drop the param. A no-op here, so jsdom's URL stays put. */
let replaceStateSpy: jest.SpyInstance;
/** The X inside the search box (it has no name of its own). */
const clearButton = () => searchBox().parentElement!.querySelector("button") as HTMLButtonElement;

beforeEach(() => {
  mockSearchParams = new URLSearchParams();
  mockRouter.replace.mockReset();
  mockRouter.push.mockReset();
  replaceStateSpy = jest.spyOn(window.history, "replaceState").mockImplementation(() => {});
  mockIsMobile = false;
  mockExportToCSV.mockReset();
  mockToastSuccess.mockReset();
  rows = catalogue(60);
  mockFetch();
});

afterEach(() => {
  replaceStateSpy.mockRestore();
});

describe("F0-5 — the summary line", () => {
  it("reads `Showing from–to of total products` from the response, and drops the categories count", async () => {
    renderList();
    expect(await screen.findByText("Showing 1–25 of 60 products")).toBeInTheDocument();
    expect(screen.queryByText(/categories/)).toBeNull();
  });

  it("from and to follow the page actually shown (the last, short page)", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Showing 26–50 of 60 products")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Showing 51–60 of 60 products")).toBeInTheDocument();
  });

  it("is not rendered when total is 0", async () => {
    rows = [];
    renderList();
    await waitFor(() => expect(productCalls().length).toBeGreaterThan(0));
    await screen.findByText("No products found");
    expect(screen.queryByText(/^Showing/)).toBeNull();
  });

  it("is not rendered before data has loaded", () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    renderList();
    expect(screen.queryByText(/^Showing/)).toBeNull();
    expect(screen.queryByText(/products/)).toBeNull();
  });
});

describe("F0-5 — the stock filter is a count of this page", () => {
  beforeEach(() => {
    mockIsMobile = true;
  });

  it("plural: `n of the rowsOnPage products on this page match`", async () => {
    rows = catalogue(60, [2, 5, 9]);
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    fireEvent.click(screen.getByRole("button", { name: "filter: out of stock" }));
    expect(screen.getByText("3 of the 25 products on this page match")).toBeInTheDocument();
    expect(screen.queryByText(/^Showing/)).toBeNull();
  });

  it("singular: `1 of the rowsOnPage products on this page matches`", async () => {
    rows = catalogue(60, [4]);
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    fireEvent.click(screen.getByRole("button", { name: "filter: out of stock" }));
    expect(screen.getByText("1 of the 25 products on this page matches")).toBeInTheDocument();
  });

  it("no match on a page of several: `No products on this page match — try another page or clear the filter.`", async () => {
    rows = catalogue(60);
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    fireEvent.click(screen.getByRole("button", { name: "filter: out of stock" }));
    expect(
      screen.getByText("No products on this page match — try another page or clear the filter."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No products found")).toBeNull();
  });

  it("no match on the only page: `No products match — clear the filter.`", async () => {
    rows = catalogue(10);
    renderList();
    await screen.findByText("Showing 1–10 of 10 products");
    fireEvent.click(screen.getByRole("button", { name: "filter: out of stock" }));
    expect(screen.getByText("No products match — clear the filter.")).toBeInTheDocument();
    expect(screen.queryByText("No products found")).toBeNull();
  });
});

// Facelift F1-13 (plan 2026-11-18-facelift-f1; F0 QA-6.1): a page of ONE row
// whose one row matches read `1 of the 1 products on this page matches`.
describe("F1-13 — the one product on this page", () => {
  beforeEach(() => {
    mockIsMobile = true;
  });

  it("a one-row page whose row matches: `The one product on this page matches`", async () => {
    rows = catalogue(1, [1]);
    renderList();
    await screen.findByText("Showing 1–1 of 1 product");
    fireEvent.click(screen.getByRole("button", { name: "filter: out of stock" }));
    expect(screen.getByText("The one product on this page matches")).toBeInTheDocument();
    expect(screen.queryByText(/of the 1 products/)).toBeNull();
  });

  it("the last page holding one row reads the same", async () => {
    rows = catalogue(26, [26]);
    renderList();
    await screen.findByText("Showing 1–25 of 26 products");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Showing 26–26 of 26 products");
    fireEvent.click(screen.getByRole("button", { name: "filter: out of stock" }));
    expect(screen.getByText("The one product on this page matches")).toBeInTheDocument();
    expect(screen.queryByText(/of the 1 products/)).toBeNull();
  });
});

describe("F0-5 — export says it is this page", () => {
  it("the button reads `Export this page` (and carries that aria-label); the toast names the count", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");

    const button = screen.getByRole("button", { name: "Export this page" });
    expect(button).toHaveAttribute("aria-label", "Export this page");
    expect(button).toHaveTextContent("Export this page");

    fireEvent.click(button);
    expect(mockExportToCSV).toHaveBeenCalledTimes(1);
    expect((mockExportToCSV.mock.calls[0][0] as Row[]).length).toBe(25);
    expect(mockToastSuccess).toHaveBeenCalledWith("Exported 25 products from this page.");
  });

  it("on phones the icon-only button still carries `aria-label=\"Export this page\"`", async () => {
    mockIsMobile = true;
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    expect(screen.getByRole("button", { name: "Export this page" })).toHaveAttribute(
      "aria-label",
      "Export this page",
    );
  });
});

describe("F0-6 — the list follows `?search=`", () => {
  it("seeds the box from `?search=` on first mount: no unfiltered first fetch", async () => {
    rows = [...catalogue(3), { id: 99, name: "Widget A", baseName: "W", currentQuantity: 5, lowStockThreshold: null }];
    mockSearchParams = new URLSearchParams("search=Widget A");
    renderList();

    expect(searchBox().value).toBe("Widget A");
    expect(await screen.findByText("Showing 1–1 of 1 product")).toBeInTheDocument();
    const calls = productCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const u of calls) expect(u.searchParams.get("search")).toBe("Widget A");
  });

  it("changing `?search=` on a mounted list re-seeds the box and returns to page 1", async () => {
    rows = [...catalogue(60), { id: 99, name: "Gadget", baseName: "G", currentQuantity: 5, lowStockThreshold: null }];
    const { rerenderList } = renderList();
    await screen.findByText("Showing 1–25 of 61 products");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Showing 26–50 of 61 products");

    mockSearchParams = new URLSearchParams("search=Gadget");
    rerenderList();

    await waitFor(() => expect(searchBox().value).toBe("Gadget"));
    expect(await screen.findByText("Showing 1–1 of 1 product")).toBeInTheDocument();
    const last = productCalls()[productCalls().length - 1];
    expect(last.searchParams.get("search")).toBe("Gadget");
    expect(last.searchParams.get("page")).toBe("1");
  });

  it("typing does not write the URL", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    fireEvent.change(searchBox(), { target: { value: "Product 1" } });
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it("clearing the box with its X drops a present `search` param", async () => {
    mockSearchParams = new URLSearchParams("search=Product 1");
    renderList();
    await waitFor(() => expect(searchBox().value).toBe("Product 1"));

    fireEvent.click(clearButton());
    expect(searchBox().value).toBe("");
    // FR2-3: by `history.replaceState`, never a router navigation.
    expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/products");
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it("clearing the box with its X leaves the URL alone when there is no `search` param", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    fireEvent.change(searchBox(), { target: { value: "Product" } });
    fireEvent.click(clearButton());
    expect(searchBox().value).toBe("");
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it("the rendered rows are the list's (sanity)", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    expect(within(document.body).getAllByTestId("product-row")).toHaveLength(25);
  });
});

// ---------------------------------------------------------------------------
// Facelift F0 FR1-7 — the products sentences
// ---------------------------------------------------------------------------

describe("FR1-7 — the summary and the export toast", () => {
  it("a page with no rows renders no summary (never `Showing 26–25 of 20 products`)", async () => {
    // A catalogue that shrank under page 2: the answer has a total but no rows.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://x");
      if (url.pathname === "/api/settings/low-stock-default") {
        return { ok: true, json: async () => ({ threshold: 10 }) } as Response;
      }
      return {
        ok: true,
        json: async () => ({ products: [], total: 20, page: 2, pageSize: 25 }),
      } as Response;
    });
    renderList();
    await waitFor(() => expect(productCalls().length).toBeGreaterThan(0));
    await screen.findByText("No products found");
    expect(screen.queryByText(/^Showing/)).toBeNull();
    expect(screen.queryByText(/26–25/)).toBeNull();
  });

  it("a total of one reads `Showing 1–1 of 1 product`", async () => {
    rows = catalogue(1);
    renderList();
    expect(await screen.findByText("Showing 1–1 of 1 product")).toBeInTheDocument();
    expect(screen.queryByText("Showing 1–1 of 1 products")).toBeNull();
  });

  it("exporting one row: `Exported 1 product from this page.`", async () => {
    rows = catalogue(1);
    renderList();
    await screen.findByText("Showing 1–1 of 1 product");
    fireEvent.click(screen.getByRole("button", { name: "Export this page" }));
    expect(mockToastSuccess).toHaveBeenCalledWith("Exported 1 product from this page.");
  });
});

// ---------------------------------------------------------------------------
// Facelift F0 FR1-8 — the list lets go of a `search` param it no longer matches
// ---------------------------------------------------------------------------

describe("FR1-8 — re-seeding from global search", () => {
  it("the first edit away from `?search=` drops the param (never writing the typed text); the box keeps it", async () => {
    mockSearchParams = new URLSearchParams("search=Product 1");
    const { rerenderList } = renderList();
    await waitFor(() => expect(searchBox().value).toBe("Product 1"));

    fireEvent.change(searchBox(), { target: { value: "Product 12" } });
    // FR2-3: typing makes no `router.replace` call; the param goes by
    // `history.replaceState`, once.
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
    expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/products");
    expect(mockRouter.push).not.toHaveBeenCalled();

    // The URL lets go of the param: the box keeps what was typed.
    mockSearchParams = new URLSearchParams();
    rerenderList();
    await act(async () => {});
    expect(searchBox().value).toBe("Product 12");
  });

  it("so a later global-search pick of the SAME product re-seeds the box", async () => {
    mockSearchParams = new URLSearchParams("search=Product 1");
    const { rerenderList } = renderList();
    await waitFor(() => expect(searchBox().value).toBe("Product 1"));

    fireEvent.change(searchBox(), { target: { value: "Prod" } });
    mockSearchParams = new URLSearchParams();
    rerenderList();
    await act(async () => {});
    expect(searchBox().value).toBe("Prod");

    // Global search links here again with the same name.
    mockSearchParams = new URLSearchParams("search=Product 1");
    rerenderList();
    await waitFor(() => expect(searchBox().value).toBe("Product 1"));
  });

  it("clearing the filters drops a present `search` param", async () => {
    mockIsMobile = true;
    mockSearchParams = new URLSearchParams("search=Product 1");
    renderList();
    await waitFor(() => expect(searchBox().value).toBe("Product 1"));

    fireEvent.click(screen.getByRole("button", { name: "clear filters" }));
    expect(searchBox().value).toBe("");
    // FR2-3: by `history.replaceState`, never a router navigation.
    expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/products");
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it("clearing the filters leaves the URL alone when there is no `search` param", async () => {
    mockIsMobile = true;
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    fireEvent.click(screen.getByRole("button", { name: "clear filters" }));
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });
});
