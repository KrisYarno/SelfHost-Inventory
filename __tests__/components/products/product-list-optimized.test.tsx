/** @jest-environment jsdom */
//
// Facelift F2c — the Products list (plan 2026-11-19-facelift-f2: F2-5, F2-9 as
// amended by A4, A5, A6, A7, A11, A12, A13, A14, A22, A23, A24, B1, B5, B11,
// B13; F2-8's containers and view toggle, moved here by REV 5 R3/R4).
//
// A7 — this file was rewritten. As executed:
//   - CARRIED, behaviour unchanged: F0-6 (the box seeds from `?search=`; a URL
//     change re-seeds and resets to page 1; typing never writes the URL; the X
//     drops a present param and leaves a param-less URL alone), FR1-8 (the
//     first edit away from the URL value drops the param ONCE; a later
//     global-search pick re-seeds), FR2-3 (the drop is `history.replaceState`,
//     never `router.replace`), and F0-5's / FR1-7's summary pins that are not
//     filter pins (`Showing from–to of total products`, from/to on the last
//     page, none for total 0, none before data, `1 product` singular).
//   - RETIRED (the server-side filter replaces them): F0-5's "the stock filter
//     is a count of this page" and "export says it is this page" pins, F1-13's
//     "the one product on this page" pins, FR1-7's filter-branch pins, and
//     FR1-7's "Exported 1 product from this page." toast.
//   - RE-MAPPED: FR1-8's "clearing the filters drops a present search param"
//     (and its param-less twin) became "`Show all stock` never touches the URL".
//   - REPLACED: FR1-7's "a page with no rows renders no summary" by A5's pin
//     (page 2, total 20, no rows -> it reads page 1).
//   - The mocks of `product-card`, `product-card-mobile`, `mobile-filter-sheet`
//     and `use-is-mobile` are gone with those imports. B1: `useLocation` is
//     mocked (it throws outside a provider).
//
// Fix round FR1 (plan 2026-11-19-facelift-f2 REV 7), pinned below:
//   - FR1-2: the "here" wiring at list level (a chip switch with the reply held
//     never labels the old location's numbers "here"; the export's `At {name}`
//     names the location whose id it sent).
//   - FR1-6: the export tells the truth (0 rows: no file + `No products to
//     export.`; fewer than the first answer's total: the file + a warning).
//   - FR1-10: every sentence comes from the answer on screen (its `search` and
//     `stock` echoes); paging text is the answer's page; Previous / Next /
//     Export wait while the data is a placeholder. The browser frame where the
//     list's own debounce has landed and the hook's has not is reproduced with
//     `mockHookSearchLag` (the hook reads that search instead of the list's).
//   - FR1-12: a remembered Grid is the first frame (read in a layout effect;
//     pinned in product-list-first-frame.test.tsx with React's mock scheduler).
//   - FR1-14: the CSV's state words are the badges' words (ONE map).
//   AMENDED by FR1 (named in the report): FR1-6's short-file pins (warning, not
//   success); FR1-10's two paging pins now wait for an answer before the next
//   Next (it is disabled on placeholder data); A17's import pin (the list no
//   longer imports the StockState type); the mock route echoes `search`.
//
// FR2-3 (REV 7): dropping the param is not a navigation — it is a plain
// `history.replaceState(null, "", "/products")` (Next 14.2 keeps
// `useSearchParams` in sync with it), never `router.replace`, which went to the
// server on a keystroke. The drop pins below assert BOTH halves.

import * as React from "react";
import fs from "fs";
import path from "path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let mockSearchParams = new URLSearchParams();
const mockRouter = { replace: jest.fn(), push: jest.fn() };
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => mockRouter,
}));

type MockLocation = {
  selectedLocation: { id: number; name: string } | null;
  selectedLocationId: number | null;
  isLoading: boolean;
  loadFailed: boolean;
};
const MAIN = { id: 1, name: "Main" };
let mockLocation: MockLocation;
jest.mock("@/contexts/location-context", () => ({
  useLocation: () => mockLocation,
}));

/**
 * FR1-10: when set, the HOOK reads this search instead of the list's — the
 * browser frame where the list's own debounce timer has fired and the hook's
 * (a separate timer, a separate task) has not. Null: a plain pass-through.
 */
let mockHookSearchLag: string | null = null;
jest.mock("@/hooks/use-products", () => {
  const actual = jest.requireActual("@/hooks/use-products");
  return {
    ...actual,
    useProducts: (filters: { search?: string }, options?: { enabled?: boolean }) =>
      actual.useProducts(mockHookSearchLag === null ? filters : { ...filters, search: mockHookSearchLag }, options),
  };
});

const mockExportToCSV = jest.fn();
jest.mock("@/lib/export-utils", () => ({
  exportToCSV: (...args: unknown[]) => mockExportToCSV(...args),
}));
const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();
// FR1-6: the export also says `info` (nothing to export) and `warning` (a short file).
const mockToastInfo = jest.fn();
const mockToastWarning = jest.fn();
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => mockToastSuccess(...a),
    error: (...a: unknown[]) => mockToastError(...a),
    info: (...a: unknown[]) => mockToastInfo(...a),
    warning: (...a: unknown[]) => mockToastWarning(...a),
  },
}));

import { ProductListOptimized } from "@/components/products/product-list-optimized";
import { STOCK_STATE_WORDS } from "@/components/products/product-stock";

type State = "ok" | "low" | "out" | "below-zero" | "no-record";
type Row = {
  id: number;
  name: string;
  baseName: string;
  variant: string | null;
  approvalStatus: string;
  currentQuantity: number;
  totalQuantity: number | null;
  hereQuantity: number | null;
  stockState: State;
  lowStockThreshold: number | null;
  costPrice: string | null;
  retailPrice: string | null;
};

const TOTAL_FOR: Record<State, number | null> = { ok: 50, low: 3, out: 0, "below-zero": -2, "no-record": null };

function row(id: number, state: State = "ok", over: Partial<Row> = {}): Row {
  return {
    id,
    name: `Product ${id}`,
    baseName: `Base ${id}`,
    variant: null,
    approvalStatus: "APPROVED",
    currentQuantity: 0,
    totalQuantity: TOTAL_FOR[state],
    hereQuantity: TOTAL_FOR[state],
    stockState: state,
    lowStockThreshold: null,
    costPrice: null,
    retailPrice: null,
    ...over,
  };
}

/** `n` products (ids from `start`), all in `state`. */
function catalogue(n: number, state: State = "ok", start = 1): Row[] {
  return Array.from({ length: n }, (_, i) => row(start + i, state));
}

const OUT_STATES: State[] = ["out", "below-zero", "no-record"];

/** The route as F2a built it: search, the stock filter, paging, the echoes (FR1-10: `search` too). */
function serve(url: URL) {
  const page = Number(url.searchParams.get("page") ?? 1);
  const pageSize = Number(url.searchParams.get("pageSize") ?? 25);
  const search = url.searchParams.get("search") ?? "";
  const stock = url.searchParams.get("stock") ?? "all";
  const here = url.searchParams.get("hereLocationId");
  let matching = rows.filter((r) => r.name.includes(search));
  if (stock === "in-stock") matching = matching.filter((r) => (r.totalQuantity ?? 0) > 0);
  if (stock === "low") matching = matching.filter((r) => r.stockState === "low");
  if (stock === "out") matching = matching.filter((r) => OUT_STATES.includes(r.stockState));
  const products = matching
    .slice((page - 1) * pageSize, page * pageSize)
    .map((r) => ({ ...r, hereQuantity: here ? r.hereQuantity : null }));
  return {
    products,
    total: matching.length,
    page,
    pageSize,
    totalPages: Math.ceil(matching.length / pageSize),
    hereLocationId: here ? Number(here) : null,
    stock,
    search,
  };
}

let rows: Row[] = [];
let fetchMock: jest.Mock;
/** Requests matching this wait until `release()`; the answer is computed AFTER. */
let holdIf: ((u: URL) => boolean) | null = null;
let held: Array<() => void> = [];
const release = () => act(async () => {
  const waiting = held;
  held = [];
  waiting.forEach((go) => go());
});
/** Requests matching this answer 500. */
let failIf: ((u: URL) => boolean) | null = null;
/** Rewrites an answer (a shrunk or duplicated page). */
let tweak: ((u: URL, body: ReturnType<typeof serve>) => ReturnType<typeof serve>) | null = null;

function mockFetch() {
  fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://x");
    if (url.pathname !== "/api/products/optimized") throw new Error(`unexpected fetch ${url.pathname}`);
    if (holdIf?.(url)) await new Promise<void>((go) => held.push(go));
    if (failIf?.(url)) return { ok: false, status: 500, json: async () => ({ error: "boom" }) } as Response;
    const body = serve(url);
    return { ok: true, json: async () => (tweak ? tweak(url, body) : body) } as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
}

const productCalls = () =>
  fetchMock.mock.calls
    .map(([u]) => new URL(String(u), "http://x"))
    .filter((u) => u.pathname === "/api/products/optimized");
/** The list's reads (pageSize 25), not the export's. */
const listCalls = () => productCalls().filter((u) => u.searchParams.get("pageSize") === "25");
const exportCalls = () => productCalls().filter((u) => u.searchParams.get("pageSize") === "500");
const lastListCall = () => listCalls()[listCalls().length - 1];

type ListProps = Partial<React.ComponentProps<typeof ProductListOptimized>>;
function tree(qc: QueryClient, props: ListProps) {
  return (
    <QueryClientProvider client={qc}>
      <div id="main">
        <ProductListOptimized onQuickAdjust={jest.fn()} onStockIn={jest.fn()} {...props} />
      </div>
    </QueryClientProvider>
  );
}

function renderList(props: ListProps = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(tree(qc, props));
  return { ...utils, qc, rerenderList: (next: ListProps = props) => utils.rerender(tree(qc, next)) };
}

const searchBox = () => screen.getByRole("searchbox", { name: "Search products" }) as HTMLInputElement;
/** FR2-3: the list's only way to drop the param. A no-op here, so jsdom's URL stays put. */
let replaceStateSpy: jest.SpyInstance;
const clearButton = () => screen.getByRole("button", { name: "Clear search" });
const filterGroup = () => screen.getByRole("group", { name: "Stock filter" });
const filterButton = (name: string) => within(filterGroup()).getByRole("button", { name });
const viewGroup = () => screen.getByRole("group", { name: "View" });
const exportButton = () => screen.getByRole("button", { name: "Export CSV" });
/** The List rows' and Grid tiles' main buttons (the table rows have none). */
const mainButtons = () => screen.queryAllByRole("button", { name: /^Adjust stock for / });
const classesOf = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);
const waitDebounce = () => act(() => new Promise((resolve) => setTimeout(resolve, 400)));

// jsdom has no Element.scrollTo; the list scrolls the shell's #main on a page change.
const scrollToMock = jest.fn();
beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollTo", { value: scrollToMock, configurable: true, writable: true });
});
afterAll(() => {
  delete (Element.prototype as unknown as { scrollTo?: unknown }).scrollTo;
});

beforeEach(() => {
  scrollToMock.mockClear();
  mockSearchParams = new URLSearchParams();
  mockRouter.replace.mockReset();
  mockRouter.push.mockReset();
  replaceStateSpy = jest.spyOn(window.history, "replaceState").mockImplementation(() => {});
  mockLocation = { selectedLocation: MAIN, selectedLocationId: 1, isLoading: false, loadFailed: false };
  mockExportToCSV.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
  mockToastInfo.mockReset();
  mockToastWarning.mockReset();
  holdIf = null;
  held = [];
  failIf = null;
  tweak = null;
  mockHookSearchLag = null;
  rows = catalogue(60);
  window.localStorage.clear();
  mockFetch();
});

afterEach(() => {
  replaceStateSpy.mockRestore();
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// CARRIED: the summary line (F0-5 / FR1-7, not the filter pins)
// ---------------------------------------------------------------------------

describe("carried — the summary line", () => {
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
    await screen.findByText("No products yet.");
    expect(screen.queryByText(/^Showing/)).toBeNull();
  });

  it("is not rendered before data has loaded", () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    renderList();
    expect(screen.queryByText(/^Showing/)).toBeNull();
    expect(screen.queryByText(/products/)).toBeNull();
  });

  it("a total of one reads `Showing 1–1 of 1 product`", async () => {
    rows = catalogue(1);
    renderList();
    expect(await screen.findByText("Showing 1–1 of 1 product")).toBeInTheDocument();
    expect(screen.queryByText("Showing 1–1 of 1 products")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CARRIED: F0-6, FR1-8, FR2-3 — the list follows `?search=`
// ---------------------------------------------------------------------------

describe("F0-6 — the list follows `?search=` (carried)", () => {
  it("seeds the box from `?search=` on first mount: no unfiltered first fetch", async () => {
    rows = [...catalogue(3), row(99, "ok", { name: "Widget A", baseName: "W" })];
    mockSearchParams = new URLSearchParams("search=Widget A");
    renderList();

    expect(searchBox().value).toBe("Widget A");
    expect(await screen.findByText("Showing 1–1 of 1 product")).toBeInTheDocument();
    const calls = productCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const u of calls) expect(u.searchParams.get("search")).toBe("Widget A");
  });

  it("changing `?search=` on a mounted list re-seeds the box and returns to page 1", async () => {
    rows = [...catalogue(60), row(99, "ok", { name: "Gadget", baseName: "G" })];
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
    await waitDebounce();
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
    expect(mainButtons()).toHaveLength(25);
  });
});

describe("FR1-8 — re-seeding from global search (carried)", () => {
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
});

// RE-MAPPED (A7): "clearing the filters drops a present search param" and its
// param-less twin. The filter no longer clears the search, so its reset never
// touches the URL.
describe("A7 re-map — `Show all stock` never touches the URL", () => {
  it("with a `search` param: the filter resets, the box and the param stay", async () => {
    mockSearchParams = new URLSearchParams("search=Product 1");
    renderList();
    await screen.findByText(/^Showing 1–/);
    fireEvent.click(filterButton("Low"));
    fireEvent.click(await screen.findByRole("button", { name: "Show all stock" }));

    expect(searchBox().value).toBe("Product 1");
    expect(filterButton("All")).toHaveAttribute("aria-pressed", "true");
    expect(replaceStateSpy).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it("with no `search` param: no URL write either", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    fireEvent.click(filterButton("Out"));
    fireEvent.click(await screen.findByRole("button", { name: "Show all stock" }));
    expect(replaceStateSpy).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F2-5 — the tool row
// ---------------------------------------------------------------------------

describe("F2-5 — line 1: search, the view toggle, export", () => {
  it("the search input: type=search, enterKeyHint=search, aria-label, the unchanged placeholder, 44 px on phones", async () => {
    renderList();
    const box = searchBox();
    expect(box).toHaveAttribute("type", "search");
    expect(box).toHaveAttribute("enterkeyhint", "search");
    expect(box).toHaveAttribute("aria-label", "Search products");
    expect(box).toHaveAttribute("placeholder", "Search products...");
    expect(classesOf(box)).toContain("max-md:h-11");
  });

  it("A4: the X shows only with text, is named `Clear search`, and KEEPS the F1 opt-out", async () => {
    renderList();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    fireEvent.change(searchBox(), { target: { value: "Pro" } });
    expect(classesOf(clearButton())).toEqual(
      expect.arrayContaining(["absolute", "max-md:min-h-0", "max-md:min-w-0", "h-7", "w-7"]),
    );
  });

  it("the view toggle: role=group `View`, List view (List icon) and Grid view (LayoutGrid icon), aria-pressed, secondary when pressed", async () => {
    renderList();
    const list = within(viewGroup()).getByRole("button", { name: "List view" });
    const grid = within(viewGroup()).getByRole("button", { name: "Grid view" });
    expect(list.querySelector("svg.lucide-list")).not.toBeNull();
    expect(grid.querySelector("svg.lucide-layout-grid")).not.toBeNull();
    expect(list).toHaveAttribute("aria-pressed", "true");
    expect(grid).toHaveAttribute("aria-pressed", "false");
    expect(classesOf(list)).toContain("bg-secondary");
    expect(classesOf(grid)).toContain("border-input"); // outline
    expect(classesOf(grid)).not.toContain("bg-secondary");
  });

  it("Export: aria-label `Export CSV`, the Download icon, the text `Export` from sm up", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    const button = exportButton();
    expect(button.querySelector("svg.lucide-download")).not.toBeNull();
    const text = within(button).getByText("Export");
    expect(classesOf(text)).toEqual(expect.arrayContaining(["hidden", "sm:inline"]));
    expect(screen.queryByRole("button", { name: "Export this page" })).toBeNull();
  });
});

describe("F2-5 / A12 — line 2: the stock filter", () => {
  it("role=group `Stock filter` (no radiogroup / radio), All, In stock, Low, Out with aria-pressed; the checked one default, the rest outline, size sm", async () => {
    renderList();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    const buttons = within(filterGroup()).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["All", "In stock", "Low", "Out"]);
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false", "false", "false"]);
    expect(classesOf(buttons[0])).toContain("bg-primary");
    for (const b of buttons.slice(1)) expect(classesOf(b)).toContain("border-input");
    for (const b of buttons) expect(classesOf(b)).toEqual(expect.arrayContaining(["h-8", "max-md:min-h-11"]));
  });

  it("is visible with no phone sheet: no Filters button anywhere", () => {
    renderList();
    expect(screen.queryByRole("button", { name: /filters/i })).toBeNull();
  });

  it("a filter is sent to the API, resets to page 1 and KEEPS the search", async () => {
    rows = [...catalogue(40, "low"), ...catalogue(20, "ok", 41)];
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    fireEvent.change(searchBox(), { target: { value: "Product" } });
    await waitDebounce();
    // FR1-10: Next waits for the search's answer (it is disabled on placeholder data).
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Showing 26–50 of 60 products");

    fireEvent.click(filterButton("Low"));
    expect(await screen.findByText("Showing 1–25 of 40 low-stock products")).toBeInTheDocument();
    const last = lastListCall();
    expect(last.searchParams.get("stock")).toBe("low");
    expect(last.searchParams.get("page")).toBe("1");
    expect(last.searchParams.get("search")).toBe("Product");
    expect(searchBox().value).toBe("Product");
    expect(filterButton("Low")).toHaveAttribute("aria-pressed", "true");
    expect(filterButton("All")).toHaveAttribute("aria-pressed", "false");
  });

  it("each filter sends its value; All sends no `stock` param", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    expect(lastListCall().searchParams.has("stock")).toBe(false);
    for (const [label, value] of [["In stock", "in-stock"], ["Low", "low"], ["Out", "out"]] as const) {
      fireEvent.click(filterButton(label));
      await waitFor(() => expect(lastListCall().searchParams.get("stock")).toBe(value));
    }
    fireEvent.click(filterButton("All"));
    await waitFor(() => expect(lastListCall().searchParams.has("stock")).toBe(false));
  });
});

describe("F2-5 — line 3: the count nouns (by the answer's own filter)", () => {
  // [filter, the matching rows' state, the non-matching rows' state (none for All), singular, plural]
  const CASES: Array<[string, State, State | null, string, string]> = [
    ["All", "ok", null, "product", "products"],
    ["In stock", "ok", "out", "product in stock", "products in stock"],
    ["Low", "low", "ok", "low-stock product", "low-stock products"],
    ["Out", "out", "ok", "product out of stock", "products out of stock"],
  ];

  it.each(CASES)("%s: the singular noun for total 1, the plural for 2", async (label, state, other, singular, plural) => {
    for (const [n, noun] of [[1, singular], [2, plural]] as const) {
      rows = [...catalogue(n, state), ...(other ? catalogue(2, other, 100) : [])];
      const { unmount } = renderList();
      await screen.findByText(/^Showing 1–/);
      fireEvent.click(filterButton(label));
      expect(await screen.findByText(`Showing 1–${n} of ${n} ${noun}`)).toBeInTheDocument();
      unmount();
    }
  });

  it("`out` counts below-zero and no-record rows too (nothing usable on hand)", async () => {
    rows = [row(1, "out"), row(2, "below-zero"), row(3, "no-record"), row(4, "ok")];
    renderList();
    await screen.findByText("Showing 1–4 of 4 products");
    fireEvent.click(filterButton("Out"));
    expect(await screen.findByText("Showing 1–3 of 3 products out of stock")).toBeInTheDocument();
  });

  it("B5: a filter change with the reply held shows the OLD total with the OLD noun, never the new noun with the old total", async () => {
    rows = [...catalogue(3, "low"), ...catalogue(57, "ok", 4)];
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    holdIf = (u) => u.searchParams.get("stock") === "low";
    fireEvent.click(filterButton("Low"));
    await waitFor(() => expect(held).toHaveLength(1));

    expect(screen.getByText("Showing 1–25 of 60 products")).toBeInTheDocument();
    expect(screen.queryByText(/low-stock/)).toBeNull();
    await release();
    expect(await screen.findByText("Showing 1–3 of 3 low-stock products")).toBeInTheDocument();
    expect(screen.queryByText(/of 60/)).toBeNull();
  });
});

describe("F2-5 / A22 — line 3: the caption, the joiner, aria-live", () => {
  it("with a confirmed location: the count, ` · `, and `Totals cover all locations. “Here” is Main.`", async () => {
    renderList();
    const count = await screen.findByText("Showing 1–25 of 60 products");
    expect(count.parentElement!.textContent).toBe(
      "Showing 1–25 of 60 products · Totals cover all locations. “Here” is Main.",
    );
    expect(count.parentElement).toHaveClass("text-xs", "text-muted-foreground");
  });

  it("with none: `Totals cover all locations.`", async () => {
    mockLocation = { selectedLocation: null, selectedLocationId: null, isLoading: false, loadFailed: true };
    renderList();
    const count = await screen.findByText("Showing 1–25 of 60 products");
    expect(count.parentElement!.textContent).toBe("Showing 1–25 of 60 products · Totals cover all locations.");
  });

  it("the caption shows alone (no joiner) before an answer", () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    renderList();
    const caption = screen.getByText("Totals cover all locations. “Here” is Main.");
    expect(caption.parentElement!.textContent).toBe("Totals cover all locations. “Here” is Main.");
  });

  it("aria-live=polite is on the COUNT span only", async () => {
    const { container } = renderList();
    const count = await screen.findByText("Showing 1–25 of 60 products");
    const live = container.querySelectorAll("[aria-live]");
    expect(live).toHaveLength(1);
    expect(live[0]).toBe(count);
    expect(count).toHaveAttribute("aria-live", "polite");
  });
});

describe("F2-5 / A22 — the sticky bar", () => {
  it("lines 1-2 are one opaque sticky bar (sticky top-0 z-20 bg-background, bottom border); line 3 is outside it", async () => {
    renderList();
    const count = await screen.findByText("Showing 1–25 of 60 products");
    const bar = searchBox().closest(".sticky") as HTMLElement;
    expect(bar).not.toBeNull();
    expect(classesOf(bar)).toEqual(expect.arrayContaining(["sticky", "top-0", "z-20", "bg-background", "border-b"]));
    expect(classesOf(bar).some((c) => c.startsWith("bg-background/") || c.startsWith("backdrop-blur"))).toBe(false);
    expect(bar).toContainElement(viewGroup());
    expect(bar).toContainElement(filterGroup());
    expect(bar).toContainElement(exportButton());
    expect(bar).not.toContainElement(count);
    // Line 3 is in normal flow (nothing between it and the list root sticks) and
    // sits above the rows.
    const root = bar.parentElement as HTMLElement;
    for (let el: HTMLElement | null = count; el && el !== root; el = el.parentElement) {
      expect(classesOf(el).filter((c) => /^(sticky|fixed|absolute)$/.test(c))).toEqual([]);
    }
    const frame = root.querySelector(".lg\\:hidden.divide-y") as HTMLElement;
    expect(count.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("F2-5 — removed: the dead scroll listener, useIsMobile, the cards and the sheet", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "components/products/product-list-optimized.tsx"), "utf8");

  it("no window scroll listener and no isScrolled", () => {
    expect(src).not.toMatch(/addEventListener\(\s*['"]scroll/);
    expect(src).not.toMatch(/isScrolled/);
  });

  it("no useIsMobile: the layout is chosen by CSS", () => {
    expect(src).not.toMatch(/use-is-mobile|useIsMobile/);
  });

  it("no ProductCard, ProductCardMobile or MobileFilterSheet", () => {
    expect(src).not.toMatch(/product-card(-mobile)?["']/);
    expect(src).not.toMatch(/\bProductCard(Mobile)?\b/);
    expect(src).not.toMatch(/MobileFilterSheet|mobile-filter-sheet/);
  });

  it("A17: the stock-threshold module is never VALUE-imported (FR1-14 removed the list's type import with its local map)", () => {
    const imports = src.split(/\r?\n/).filter((l) => l.includes("@/lib/stock-threshold"));
    for (const line of imports) expect(line).toMatch(/^import type /);
    expect(src).not.toMatch(/^import (?!type )[^;]*["']@\/lib\/stock-threshold["']/m);
  });

  it("the file keeps its CRLF line endings", () => {
    expect(src.split("\n").length).toBeGreaterThan(100);
    expect(src.split("\n").slice(0, -1).every((l) => l.endsWith("\r"))).toBe(true);
  });
});

// F2-11: the retired cards are gone. Their tests' behaviours are carried by the
// F2b pins: pending review is indicated (product-row / product-grid-tile /
// product-table tests, "Pending review"), and the Analytics and History links
// (product-actions-menu test, "Analytics links to /analytics/product/{id}").
describe("F2-11 — the retired cards", () => {
  const ROOT = process.cwd();
  const sources = (dir: string): string[] =>
    fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) return sources(rel);
      return /\.(tsx?|jsx?)$/.test(e.name) ? [rel] : [];
    });

  it("product-card.tsx and product-card-mobile.tsx (and their tests) are deleted", () => {
    for (const rel of [
      "components/products/product-card.tsx",
      "components/products/product-card-mobile.tsx",
      "__tests__/components/products/pending-glow.test.tsx",
      "__tests__/components/product-card-analytics-link.test.tsx",
    ]) {
      expect(fs.existsSync(path.join(ROOT, rel))).toBe(false);
    }
  });

  it("nothing in app/, components/ or hooks/ imports them", () => {
    const importers = [...sources("app"), ...sources("components"), ...sources("hooks")].filter((rel) =>
      // (`components/inventory/variant-product-card` is another component.)
      /from\s+["'](?:@\/components\/products\/|\.\/)product-card(-mobile)?["']/.test(
        fs.readFileSync(path.join(ROOT, rel), "utf8"),
      ),
    );
    expect(importers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F2-8 containers and the view toggle (REV 5 R3/R4; A13)
// ---------------------------------------------------------------------------

const rowFrame = (container: HTMLElement) =>
  container.querySelector(".lg\\:hidden.rounded-lg.border.bg-surface.divide-y") as HTMLElement | null;
const tileGrid = (container: HTMLElement) =>
  container.querySelector(".grid.grid-cols-2.gap-2.sm\\:grid-cols-3.lg\\:grid-cols-4.xl\\:grid-cols-5") as HTMLElement | null;

describe("F2-8 — the List view's containers", () => {
  it("the rows sit in ONE bordered bg-surface rounded-lg divide-y frame, lg:hidden; the table is beside it", async () => {
    const { container } = renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    const frame = rowFrame(container)!;
    expect(frame).not.toBeNull();
    expect(within(frame).getAllByRole("button", { name: /^Adjust stock for / })).toHaveLength(25);
    const table = screen.getByRole("table");
    expect(table).toHaveClass("hidden", "lg:table");
    expect(frame).not.toContainElement(table);
    expect(tileGrid(container)).toBeNull();
  });

  it("the table and the rows get the answer's echo and the confirmed location (the Here column)", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    expect(screen.getByRole("columnheader", { name: "Here (Main)" })).toBeInTheDocument();
    expect(screen.getAllByText("50 here").length).toBeGreaterThan(0);
  });

  it("no confirmed location: no here line and no Here column", async () => {
    mockLocation = { selectedLocation: null, selectedLocationId: null, isLoading: false, loadFailed: false };
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    expect(screen.queryByRole("columnheader", { name: /^Here/ })).toBeNull();
    expect(screen.queryByText(/ here$/)).toBeNull();
  });
});

describe("A13 — the view choice", () => {
  it("List is the default", async () => {
    const { container } = renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    expect(rowFrame(container)).not.toBeNull();
    expect(tileGrid(container)).toBeNull();
  });

  it("the FIRST render is List even with Grid remembered (storage is read in an effect, after commit)", async () => {
    // Read in a useState initializer, storage would be asked DURING the first
    // render, before any frame is in the document; read in a mount effect, the
    // List's frame is already committed when it is asked.
    let frameCommittedAtRead: boolean | null = null;
    jest.spyOn(Storage.prototype, "getItem").mockImplementation((key: string) => {
      if (key === "products.view") frameCommittedAtRead = rowFrame(document.body) !== null;
      return key === "products.view" ? "grid" : null;
    });
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const { container } = renderList();
    await act(async () => {});
    expect(frameCommittedAtRead).toBe(true);
    expect(tileGrid(container)).not.toBeNull();
  });

  it("a remembered Grid is restored after mount", async () => {
    window.localStorage.setItem("products.view", "grid");
    const { container } = renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    const grid = tileGrid(container)!;
    expect(grid).not.toBeNull();
    expect(within(grid).getAllByRole("button", { name: /^Adjust stock for / })).toHaveLength(25);
    expect(rowFrame(container)).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(within(viewGroup()).getByRole("button", { name: "Grid view" })).toHaveAttribute("aria-pressed", "true");
  });

  it("anything else remembered leaves List", async () => {
    window.localStorage.setItem("products.view", "tiles");
    const { container } = renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    expect(rowFrame(container)).not.toBeNull();
  });

  it("the toggle switches the view and writes the choice", async () => {
    const { container } = renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    fireEvent.click(within(viewGroup()).getByRole("button", { name: "Grid view" }));
    expect(window.localStorage.getItem("products.view")).toBe("grid");
    expect(tileGrid(container)).not.toBeNull();
    expect(within(viewGroup()).getByRole("button", { name: "Grid view" })).toHaveAttribute("aria-pressed", "true");
    expect(classesOf(within(viewGroup()).getByRole("button", { name: "Grid view" }))).toContain("bg-secondary");
    expect(within(viewGroup()).getByRole("button", { name: "List view" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(within(viewGroup()).getByRole("button", { name: "List view" }));
    expect(window.localStorage.getItem("products.view")).toBe("list");
    expect(rowFrame(container)).not.toBeNull();
  });

  it("storage that throws still renders the list, and the toggle still works for the session", async () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { container } = renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    expect(rowFrame(container)).not.toBeNull();
    fireEvent.click(within(viewGroup()).getByRole("button", { name: "Grid view" }));
    expect(tileGrid(container)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A14 / B13 — one read, not two; never a blank list
// ---------------------------------------------------------------------------

describe("A14 / B13 — the list waits for the locations read", () => {
  it("while locations load: no products request, and the skeleton (not a blank)", async () => {
    mockLocation = { selectedLocation: null, selectedLocationId: null, isLoading: true, loadFailed: false };
    const { container } = renderList();
    await act(async () => {});
    expect(productCalls()).toHaveLength(0);
    const frame = rowFrame(container)!;
    expect(frame).not.toBeNull();
    expect(frame.children).toHaveLength(8);
  });

  it("then ONE read, already carrying the confirmed location", async () => {
    mockLocation = { selectedLocation: null, selectedLocationId: null, isLoading: true, loadFailed: false };
    const { rerenderList } = renderList();
    await act(async () => {});
    mockLocation = { selectedLocation: MAIN, selectedLocationId: 1, isLoading: false, loadFailed: false };
    rerenderList();
    await screen.findByText("Showing 1–25 of 60 products");
    expect(productCalls()).toHaveLength(1);
    expect(productCalls()[0].searchParams.get("hereLocationId")).toBe("1");
  });

  it("a failed locations read: the list reads without `hereLocationId`", async () => {
    mockLocation = { selectedLocation: null, selectedLocationId: null, isLoading: false, loadFailed: true };
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    for (const u of productCalls()) expect(u.searchParams.has("hereLocationId")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F2-9 / A11 — states
// ---------------------------------------------------------------------------

describe("F2-9 / A11 — loading", () => {
  it("List: 8 h-14 skeleton rows inside the list frame, and the table's own skeleton rows (hidden lg:block), in role=status", () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    renderList();
    const status = screen.getByRole("status");
    const frame = rowFrame(status)!;
    expect(frame).not.toBeNull();
    expect(frame.children).toHaveLength(8);
    for (const s of Array.from(frame.children)) expect(s).toHaveClass("h-14");
    const tableSkeleton = status.querySelector(".hidden.lg\\:block") as HTMLElement;
    expect(tableSkeleton).not.toBeNull();
    expect(tableSkeleton.children).toHaveLength(8);
    // The tool row stays above it.
    expect(searchBox()).toBeInTheDocument();
  });

  it("Grid: 8 skeleton tiles in the grid", async () => {
    window.localStorage.setItem("products.view", "grid");
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    renderList();
    await act(async () => {});
    const grid = tileGrid(screen.getByRole("status"))!;
    expect(grid).not.toBeNull();
    expect(grid.children).toHaveLength(8);
  });
});

describe("F2-9 / A11 — a failed read", () => {
  it("with no data: role=alert `Couldn't load products.` under the tool row; Retry reads again (no reload)", async () => {
    failIf = () => true;
    renderList();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load products.");
    expect(screen.queryByText("Error loading products")).toBeNull();
    expect(searchBox()).toBeInTheDocument();
    expect(filterGroup()).toBeInTheDocument();

    const before = productCalls().length;
    failIf = null;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Showing 1–25 of 60 products")).toBeInTheDocument();
    expect(productCalls().length).toBe(before + 1);
  });

  it("A23: a failed refresh keeps the rows and says so, with a link Retry that reads again", async () => {
    const { qc } = renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    failIf = () => true;
    await act(async () => {
      await qc.refetchQueries();
    });

    const notice = await screen.findByText("Couldn't refresh. Showing the last loaded list.");
    expect(mainButtons()).toHaveLength(25);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Showing 1–25 of 60 products")).toBeInTheDocument();
    const retry = within(notice.parentElement!).getByRole("button", { name: "Retry" });
    expect(classesOf(retry)).toContain("underline-offset-4"); // variant="link"

    const before = productCalls().length;
    failIf = null;
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByText("Couldn't refresh. Showing the last loaded list.")).toBeNull());
    expect(productCalls().length).toBe(before + 1);
  });
});

// Fix round FR2-3 (plan 2026-11-19-facelift-f2 REV 12; Q/A QA-3): a failed page
// change keeps a way back. A read that failed with no data on page > 1 shows,
// after `Couldn't load products.`, an outline sm `Back to page {page - 1}` that
// sets the page to page - 1.
describe("REV 12 FR2-3 — a failed page change keeps a way back", () => {
  const onPage = (n: number) => (u: URL) => u.searchParams.get("page") === String(n);

  it("Next answers 500: after `Couldn't load products.`, an outline sm `Back to page 1`; pressing it reads page 1 and shows its rows", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    failIf = onPage(2);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    const alert = await screen.findByRole("alert");
    const text = within(alert).getByText("Couldn't load products.");
    const back = within(alert).getByRole("button", { name: "Back to page 1" });
    expect(text.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(classesOf(back)).toContain("border-input"); // variant="outline"
    expect(classesOf(back)).toContain("h-8"); // size="sm"
    expect(mainButtons()).toHaveLength(0);

    const before = listCalls().length;
    fireEvent.click(back);
    expect(await screen.findByText("Showing 1–25 of 60 products")).toBeInTheDocument();
    await waitFor(() => expect(listCalls().length).toBe(before + 1));
    expect(lastListCall().searchParams.get("page")).toBe("1");
    expect(mainButtons()).toHaveLength(25);
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("from page 2, Next to page 3 answers 500: `Back to page 2`, which reads page 2 and shows rows 26–50", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Showing 26–50 of 60 products");
    failIf = onPage(3);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).queryByRole("button", { name: "Back to page 1" })).toBeNull();
    const before = listCalls().length;
    fireEvent.click(within(alert).getByRole("button", { name: "Back to page 2" }));
    expect(await screen.findByText("Showing 26–50 of 60 products")).toBeInTheDocument();
    await waitFor(() => expect(listCalls().length).toBe(before + 1));
    expect(lastListCall().searchParams.get("page")).toBe("2");
    expect(mainButtons()).toHaveLength(25);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failed read on page 1 offers no `Back to page` button (Retry only)", async () => {
    failIf = () => true;
    renderList();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load products.");
    expect(within(alert).queryByRole("button", { name: /^Back to page/ })).toBeNull();
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("F2-9 — placeholder data", () => {
  it("a new search: the rows container is aria-busy and opacity-60 until the answer", async () => {
    const { container } = renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    const busy = () => container.querySelector('[aria-busy="true"]');
    expect(busy()).toBeNull();

    holdIf = () => true;
    fireEvent.change(searchBox(), { target: { value: "Product 1" } });
    await waitDebounce();
    expect(busy()).not.toBeNull();
    expect(busy()).toHaveClass("opacity-60");
    expect(busy()).toContainElement(rowFrame(container));
    // The previous count stays whole (A22).
    expect(screen.getByText("Showing 1–25 of 60 products")).toBeInTheDocument();

    holdIf = null;
    await release();
    await screen.findByText("Showing 1–11 of 11 products");
    expect(busy()).toBeNull();
  });
});

describe("F2-9 / A24 / B11 — empty, said only about an answer", () => {
  const REMOVED = [
    /Add your first product to get started/,
    /Try adjusting your filters/,
    /on this page/,
    /No products found/,
    /The one product/,
  ];
  const noRemovedStrings = () => {
    for (const re of REMOVED) expect(screen.queryByText(re)).toBeNull();
  };

  it("a search that matches nothing: `No products match.`, no extra button (the input's X is the one Clear search)", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    fireEvent.change(searchBox(), { target: { value: "zzz" } });
    expect(await screen.findByText("No products match.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show all stock" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Clear search" })).toHaveLength(1);
    noRemovedStrings();
  });

  it("a filter that matches nothing: `No products match.` + `Show all stock`, which clears ONLY the filter", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    fireEvent.click(filterButton("Low"));
    expect(await screen.findByText("No products match.")).toBeInTheDocument();
    noRemovedStrings();
    fireEvent.click(screen.getByRole("button", { name: "Show all stock" }));
    expect(await screen.findByText("Showing 1–25 of 60 products")).toBeInTheDocument();
    expect(lastListCall().searchParams.has("stock")).toBe(false);
  });

  it("A24: a search AND a filter: `No products match.` with ONLY `Show all stock`; it keeps the search", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    fireEvent.change(searchBox(), { target: { value: "Product 1" } });
    await waitDebounce();
    fireEvent.click(filterButton("Out"));
    expect(await screen.findByText("No products match.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Clear search" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Show all stock" }));
    expect(await screen.findByText("Showing 1–11 of 11 products")).toBeInTheDocument();
    expect(searchBox().value).toBe("Product 1");
    expect(lastListCall().searchParams.get("search")).toBe("Product 1");
  });

  it("neither, admin: `No products yet.` + `Add Product`, which calls onCreate", async () => {
    rows = [];
    const onCreate = jest.fn();
    renderList({ isAdmin: true, onCreate });
    expect(await screen.findByText("No products yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Product" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    noRemovedStrings();
  });

  it("neither, member: `No products yet.` and no button", async () => {
    rows = [];
    renderList({ isAdmin: false, onCreate: jest.fn() });
    expect(await screen.findByText("No products yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Product" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show all stock" })).toBeNull();
  });

  it("placeholder data is never empty: a held reply for an empty filter keeps the rows (busy)", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    holdIf = () => true;
    fireEvent.click(filterButton("Low"));
    await waitFor(() => expect(held).toHaveLength(1));
    expect(screen.queryByText("No products match.")).toBeNull();
    expect(mainButtons()).toHaveLength(25);
    holdIf = null;
    await release();
    expect(await screen.findByText("No products match.")).toBeInTheDocument();
  });
});

describe("A5 — an out-of-range page", () => {
  it("page 2, total 20, no rows (the catalogue shrank under it) -> it reads page 1", async () => {
    const { qc } = renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Showing 26–50 of 60 products");

    rows = catalogue(20);
    await act(async () => {
      await qc.invalidateQueries();
    });

    expect(await screen.findByText("Showing 1–20 of 20 products")).toBeInTheDocument();
    expect(lastListCall().searchParams.get("page")).toBe("1");
    expect(screen.queryByText(/26–25/)).toBeNull();
    expect(screen.queryByText("No products match.")).toBeNull();
  });

  it("a later page that exists is where it lands (total 30 -> page 2)", async () => {
    rows = catalogue(80);
    const { qc } = renderList();
    await screen.findByText("Showing 1–25 of 80 products");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    // FR1-10: the second Next waits for page 2's answer (disabled on placeholder data).
    await screen.findByText("Showing 26–50 of 80 products");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Showing 51–75 of 80 products");

    rows = catalogue(30);
    await act(async () => {
      await qc.invalidateQueries();
    });
    expect(await screen.findByText("Showing 26–30 of 30 products")).toBeInTheDocument();
    expect(lastListCall().searchParams.get("page")).toBe("2");
  });
});

describe("F2-9 — paging", () => {
  it("shown when pageCount > 1: outline Previous, `Page {page} of {pageCount}`, outline Next; no pb-20", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    const prev = screen.getByRole("button", { name: "Previous" });
    const next = screen.getByRole("button", { name: "Next" });
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    expect(classesOf(prev)).toContain("border-input");
    expect(classesOf(next)).toContain("border-input");
    expect(prev).toBeDisabled();
    expect(next).toBeEnabled();
    expect(classesOf(prev.parentElement!)).not.toContain("pb-20");
    expect(screen.queryByText("Prev")).toBeNull();
  });

  it("not shown for one page", async () => {
    rows = catalogue(25);
    renderList();
    await screen.findByText("Showing 1–25 of 25 products");
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.queryByText(/^Page /)).toBeNull();
  });

  it("a page change scrolls the shell's #main to the top (Next and Previous)", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    const main = document.getElementById("main");
    expect(scrollToMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(scrollToMock).toHaveBeenCalledTimes(1);
    expect(scrollToMock).toHaveBeenCalledWith({ top: 0 });
    expect(scrollToMock.mock.contexts[0]).toBe(main);
    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(scrollToMock).toHaveBeenCalledTimes(2);
    expect(scrollToMock.mock.contexts[1]).toBe(main);
    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument();
  });

  it("a filter or search change does not scroll", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    fireEvent.click(filterButton("Low"));
    fireEvent.change(searchBox(), { target: { value: "Pro" } });
    expect(scrollToMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F2-9 / A6 — export: the whole match, not the page
// ---------------------------------------------------------------------------

type Column = { key: string; label: string };
const exported = () => {
  expect(mockExportToCSV).toHaveBeenCalledTimes(1);
  const [data, columns, filename] = mockExportToCSV.mock.calls[0] as [Record<string, unknown>[], Column[], string];
  return { data, columns, filename };
};

/** Every toast the export said (FR1-6 adds info and warning). */
const exportToasts = () =>
  mockToastSuccess.mock.calls.length +
  mockToastError.mock.calls.length +
  mockToastInfo.mock.calls.length +
  mockToastWarning.mock.calls.length;

async function clickExport() {
  await screen.findByText(/^Showing 1–/);
  fireEvent.click(exportButton());
  await waitFor(() => expect(exportToasts()).toBe(1));
}

describe("F2-9 / A6 — export reads every matching product", () => {
  it("total 501 -> exactly 2 requests (page 1 and 2 at pageSize=500) with the list's params plus hereLocationId", async () => {
    rows = catalogue(501);
    renderList();
    await clickExport();
    const calls = exportCalls();
    expect(calls.map((u) => u.searchParams.get("page"))).toEqual(["1", "2"]);
    for (const u of calls) {
      expect(u.searchParams.get("sortBy")).toBe("baseNameNumeric");
      expect(u.searchParams.get("sortOrder")).toBe("asc");
      expect(u.searchParams.get("hereLocationId")).toBe("1");
      expect(u.searchParams.has("stock")).toBe(false);
    }
    expect(exported().data).toHaveLength(501);
    expect(mockToastSuccess).toHaveBeenCalledWith("Exported 501 products.");
  });

  it("a short page 2 -> no third request, even when page 1 said 3 pages", async () => {
    rows = catalogue(1200);
    tweak = (u, body) =>
      u.searchParams.get("pageSize") === "500" && u.searchParams.get("page") === "2"
        ? { ...body, products: body.products.slice(0, 100) }
        : body;
    renderList();
    await clickExport();
    expect(exportCalls().map((u) => u.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(exported().data).toHaveLength(600);
    // FR1-6: 600 gathered of the first answer's 1200: the file is written, and says so.
    expect(mockToastWarning).toHaveBeenCalledWith(
      "Exported 600 of 1200 products. The list changed during the export — export again for a complete file.",
    );
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it("a short page 1 -> one request", async () => {
    rows = catalogue(1200);
    tweak = (u, body) =>
      u.searchParams.get("pageSize") === "500" ? { ...body, products: body.products.slice(0, 499) } : body;
    renderList();
    await clickExport();
    expect(exportCalls()).toHaveLength(1);
    // FR1-6: 499 of 1200.
    expect(exported().data).toHaveLength(499);
    expect(mockToastWarning).toHaveBeenCalledWith(
      "Exported 499 of 1200 products. The list changed during the export — export again for a complete file.",
    );
  });

  it("reads EXACTLY pages 2..totalPages of the first answer (1500 -> 3 requests)", async () => {
    rows = catalogue(1500);
    renderList();
    await clickExport();
    expect(exportCalls().map((u) => u.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(mockToastSuccess).toHaveBeenCalledWith("Exported 1500 products.");
  });

  it("a duplicate id is written once, and the toast counts the rows written", async () => {
    rows = catalogue(501);
    tweak = (u, body) =>
      u.searchParams.get("pageSize") === "500" && u.searchParams.get("page") === "2"
        ? { ...body, products: [{ ...body.products[0], id: 1 }] }
        : body;
    renderList();
    await clickExport();
    const { data } = exported();
    expect(data).toHaveLength(500);
    expect(new Set(data.map((r) => r.name)).size).toBe(500);
    expect(data.filter((r) => r.name === "Product 1")).toHaveLength(1);
    // FR1-6: the rows written (500) are fewer than the first answer's 501.
    expect(mockToastWarning).toHaveBeenCalledWith(
      "Exported 500 of 501 products. The list changed during the export — export again for a complete file.",
    );
  });

  it("the export uses the DEBOUNCED search the list is showing, and the stock filter", async () => {
    rows = [...catalogue(30, "low"), ...catalogue(30, "ok", 31)];
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    fireEvent.change(searchBox(), { target: { value: "Product 1" } });
    await waitDebounce();
    fireEvent.click(filterButton("Low"));
    await screen.findByText(/low-stock products$/);
    // Typed, not yet debounced: the list still shows "Product 1".
    fireEvent.change(searchBox(), { target: { value: "Product 2" } });
    fireEvent.click(exportButton());
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    const [u] = exportCalls();
    expect(u.searchParams.get("search")).toBe("Product 1");
    expect(u.searchParams.get("stock")).toBe("low");
    expect(exported().data.map((r) => r.name)).toEqual(
      rows.filter((r) => r.name.includes("Product 1") && r.stockState === "low").map((r) => r.name),
    );
  });
});

describe("F2-9 — the export's columns", () => {
  it("with a confirmed location: Product Name, Category, Variant, Total (all locations), At Main, Stock state, Low Stock Threshold, Cost Price, Retail Price", async () => {
    rows = catalogue(2);
    renderList();
    await clickExport();
    const { columns, filename } = exported();
    expect(columns.map((c) => c.label)).toEqual([
      "Product Name",
      "Category",
      "Variant",
      "Total (all locations)",
      "At Main",
      "Stock state",
      "Low Stock Threshold",
      "Cost Price",
      "Retail Price",
    ]);
    expect(filename).toMatch(/^products-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("with no confirmed location: no `At` column, and no hereLocationId sent", async () => {
    mockLocation = { selectedLocation: null, selectedLocationId: null, isLoading: false, loadFailed: true };
    rows = catalogue(2);
    renderList();
    await clickExport();
    expect(exported().columns.map((c) => c.label)).toEqual([
      "Product Name",
      "Category",
      "Variant",
      "Total (all locations)",
      "Stock state",
      "Low Stock Threshold",
      "Cost Price",
      "Retail Price",
    ]);
    expect(exportCalls()[0].searchParams.has("hereLocationId")).toBe(false);
  });

  it("the cells, through the real escaper: raw numbers (negative stays numeric), null -> empty, the state word or OK", async () => {
    const { escapeCSVCell } = jest.requireActual("@/lib/csv") as typeof import("@/lib/csv");
    rows = [
      row(1, "ok", { name: "Alpha", baseName: "Alpha", variant: "5mg", lowStockThreshold: 4, costPrice: "12.5", retailPrice: "30" }),
      row(2, "below-zero", { name: "Beta", baseName: "Beta", hereQuantity: -3, totalQuantity: -2 }),
      row(3, "no-record", { name: "Gamma", baseName: "Gamma" }),
      row(4, "low", { name: "Delta", baseName: "Delta", hereQuantity: null }),
      row(5, "out", { name: "Eps", baseName: "Eps" }),
    ];
    renderList();
    await clickExport();
    const { data, columns } = exported();
    const lines = data.map((r) => columns.map((c) => escapeCSVCell(r[c.key])).join(","));
    expect(lines).toEqual([
      "Alpha,Alpha,5mg,50,50,OK,4,12.5,30",
      "Beta,Beta,,-2,-3,Below zero,,,",
      "Gamma,Gamma,,,,No record,,,",
      "Delta,Delta,,3,,Low,,,",
      "Eps,Eps,,0,0,Out,,,",
    ]);
  });
});

describe("F2-9 — the export's toasts, disabled state and visibility", () => {
  it("one row: `Exported 1 product.`", async () => {
    rows = catalogue(1);
    renderList();
    await clickExport();
    expect(mockToastSuccess).toHaveBeenCalledWith("Exported 1 product.");
  });

  it("a failed read: `Couldn't export products. Try again.` and no file", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    failIf = (u) => u.searchParams.get("pageSize") === "500";
    renderList();
    await clickExport();
    expect(mockToastError).toHaveBeenCalledWith("Couldn't export products. Try again.");
    expect(mockExportToCSV).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it("a failed page 2: the same failure toast, and no partial file", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    rows = catalogue(501);
    failIf = (u) => u.searchParams.get("pageSize") === "500" && u.searchParams.get("page") === "2";
    renderList();
    await clickExport();
    expect(mockToastError).toHaveBeenCalledWith("Couldn't export products. Try again.");
    expect(mockExportToCSV).not.toHaveBeenCalled();
  });

  it("while exporting: disabled, with the visible text `Exporting…`", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    holdIf = (u) => u.searchParams.get("pageSize") === "500";
    fireEvent.click(exportButton());
    await waitFor(() => expect(held).toHaveLength(1));
    expect(exportButton()).toBeDisabled();
    expect(within(exportButton()).getByText("Exporting…")).toHaveClass("hidden", "sm:inline");
    holdIf = null;
    await release();
    await waitFor(() => expect(exportButton()).toBeEnabled());
    expect(within(exportButton()).getByText("Export")).toBeInTheDocument();
  });

  it("hidden when a successful answer has total 0; shown again with rows", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    expect(exportButton()).toBeInTheDocument();
    fireEvent.change(searchBox(), { target: { value: "zzz" } });
    await screen.findByText("No products match.");
    expect(screen.queryByRole("button", { name: "Export CSV" })).toBeNull();
    fireEvent.click(clearButton());
    await screen.findByText("Showing 1–25 of 60 products");
    expect(exportButton()).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Fix round FR1 (REV 7)
// ---------------------------------------------------------------------------

const BACK = { id: 2, name: "Back" };
const confirmBack = () => {
  mockLocation = { selectedLocation: BACK, selectedLocationId: 2, isLoading: false, loadFailed: false };
};
/** Back's rows read 7 here (Main's read their total, 50). */
const backReadsSeven = (u: URL, body: ReturnType<typeof serve>) =>
  u.searchParams.get("hereLocationId") === "2"
    ? { ...body, products: body.products.map((p) => ({ ...p, hereQuantity: 7 })) }
    : body;

describe("FR1-2 — the here wiring, at list level", () => {
  it("Main confirmed, then the chip switches to Back with the reply HELD: no `here` line, no `Here (` header, the caption already says Back; after release, `7 here` and `Here (Back)`", async () => {
    tweak = backReadsSeven;
    const { rerenderList } = renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    expect(screen.getAllByText("50 here").length).toBeGreaterThan(0);
    expect(screen.getByRole("columnheader", { name: "Here (Main)" })).toBeInTheDocument();

    holdIf = (u) => u.searchParams.get("hereLocationId") === "2";
    confirmBack();
    rerenderList();
    await waitFor(() => expect(held).toHaveLength(1));

    // Main's numbers are still on screen (placeholder) — never labelled "here".
    expect(mainButtons()).toHaveLength(25);
    expect(screen.queryByText(/ here$/)).toBeNull();
    expect(screen.queryByRole("columnheader", { name: /^Here \(/ })).toBeNull();
    expect(screen.getByText("Totals cover all locations. “Here” is Back.")).toBeInTheDocument();

    holdIf = null;
    await release();
    expect((await screen.findAllByText("7 here")).length).toBeGreaterThan(0);
    expect(screen.getByRole("columnheader", { name: "Here (Back)" })).toBeInTheDocument();
    expect(screen.queryByText("50 here")).toBeNull();
    expect(lastListCall().searchParams.get("hereLocationId")).toBe("2");
  });

  it("the export's `At {name}` names the location whose id it SENT as hereLocationId", async () => {
    tweak = backReadsSeven;
    rows = catalogue(3);
    const { rerenderList } = renderList();
    await screen.findByText("Showing 1–3 of 3 products");
    confirmBack();
    rerenderList();
    expect((await screen.findAllByText("7 here")).length).toBeGreaterThan(0);
    await clickExport();
    const sent = exportCalls().map((u) => u.searchParams.get("hereLocationId"));
    expect(sent).toEqual(["2"]);
    const { columns, data } = exported();
    expect(columns.map((c) => c.label)).toContain("At Back");
    expect(columns.map((c) => c.label)).not.toContain("At Main");
    expect(data.map((r) => r.hereQuantity)).toEqual([7, 7, 7]);
  });
});

describe("FR1-6 — the export tells the truth", () => {
  it("0 rows gathered: NO file, and `toast.info(\"No products to export.\")` (never `Exported 0 products.`)", async () => {
    rows = catalogue(3);
    tweak = (u, body) =>
      u.searchParams.get("pageSize") === "500" ? { ...body, products: [], total: 0, totalPages: 0 } : body;
    renderList();
    await clickExport();
    expect(mockExportToCSV).not.toHaveBeenCalled();
    expect(mockToastInfo).toHaveBeenCalledTimes(1);
    expect(mockToastInfo).toHaveBeenCalledWith("No products to export.");
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastWarning).not.toHaveBeenCalled();
  });

  it("0 rows gathered though the first answer said 5: still no file and `No products to export.`", async () => {
    rows = catalogue(5);
    tweak = (u, body) => (u.searchParams.get("pageSize") === "500" ? { ...body, products: [] } : body);
    renderList();
    await clickExport();
    expect(mockExportToCSV).not.toHaveBeenCalled();
    expect(mockToastInfo).toHaveBeenCalledWith("No products to export.");
  });

  it("gathered < the first answer's total: the file is written, and the warning says n of total", async () => {
    rows = catalogue(3);
    tweak = (u, body) =>
      u.searchParams.get("pageSize") === "500" ? { ...body, products: body.products.slice(0, 2) } : body;
    renderList();
    await clickExport();
    expect(exported().data).toHaveLength(2);
    expect(mockToastWarning).toHaveBeenCalledWith(
      "Exported 2 of 3 products. The list changed during the export — export again for a complete file.",
    );
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it("otherwise: today's `Exported {n} {product|products}.` (all gathered; or more than the first total)", async () => {
    rows = catalogue(4);
    renderList();
    await clickExport();
    expect(mockToastSuccess).toHaveBeenCalledWith("Exported 4 products.");
    expect(mockToastWarning).not.toHaveBeenCalled();
    expect(mockToastInfo).not.toHaveBeenCalled();
  });

  it("more rows than the first answer's total (the list grew): the plain success", async () => {
    rows = catalogue(4);
    tweak = (u, body) => (u.searchParams.get("pageSize") === "500" ? { ...body, total: 3 } : body);
    renderList();
    await clickExport();
    expect(exported().data).toHaveLength(4);
    expect(mockToastSuccess).toHaveBeenCalledWith("Exported 4 products.");
  });
});

describe("FR1-10 — every sentence comes from the answer on screen", () => {
  it("clearing a search that matched nothing never reads `No products yet.` — not in the frame where the box's debounce has landed and the answer has not", async () => {
    const { rerenderList } = renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    fireEvent.change(searchBox(), { target: { value: "zzz" } });
    expect(await screen.findByText("No products match.")).toBeInTheDocument();

    // The X, then the list's own debounce lands while the hook's has not.
    mockHookSearchLag = "zzz";
    fireEvent.click(clearButton());
    await waitDebounce();
    expect(searchBox().value).toBe("");
    expect(screen.queryByText("No products yet.")).toBeNull();
    expect(screen.getByText("No products match.")).toBeInTheDocument();

    // The hook's lands: the answer for no search arrives.
    mockHookSearchLag = null;
    rerenderList();
    expect(await screen.findByText("Showing 1–25 of 60 products")).toBeInTheDocument();
    expect(screen.queryByText("No products yet.")).toBeNull();
  });

  it("the empty state's buttons follow the answer's filter: `Show all stock` only when the ANSWER is filtered", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    fireEvent.click(filterButton("Low"));
    expect(await screen.findByText("No products match.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show all stock" })).toBeInTheDocument();
  });

  it("mid-flight paging shows the ANSWER's page: Next with the reply held still reads `Page 1 of 3`", async () => {
    renderList();
    await screen.findByText("Page 1 of 3");
    holdIf = (u) => u.searchParams.get("page") === "2";
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(held).toHaveLength(1));
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    expect(screen.queryByText("Page 2 of 3")).toBeNull();
    expect(screen.getByText("Showing 1–25 of 60 products")).toBeInTheDocument();
    holdIf = null;
    await release();
    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
    expect(screen.getByText("Showing 26–50 of 60 products")).toBeInTheDocument();
  });

  it("Previous, Next and Export are DISABLED while the data is a placeholder, and come back with the answer", async () => {
    renderList();
    await screen.findByText("Page 1 of 3");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Page 2 of 3");
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    expect(exportButton()).toBeEnabled();

    // A page in flight (page 3 held): all three wait, Previous included (page 3 is not page 1).
    holdIf = () => true;
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(held).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(exportButton()).toBeDisabled();
    // A click on a disabled Previous / Next does not page.
    const before = listCalls().length;
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(listCalls().length).toBe(before);
    holdIf = null;
    await release();
    expect(await screen.findByText("Page 3 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();

    // A filter in flight: the same.
    holdIf = () => true;
    fireEvent.click(filterButton("In stock"));
    await waitFor(() => expect(held).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(exportButton()).toBeDisabled();

    holdIf = null;
    await release();
    expect(await screen.findByText("Showing 1–25 of 60 products in stock")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    expect(exportButton()).toBeEnabled();
  });

  it("the export's params come from the answer on screen, not from a box that ran ahead of it", async () => {
    renderList();
    await screen.findByText("Showing 1–25 of 60 products");
    fireEvent.change(searchBox(), { target: { value: "Product 1" } });
    expect(await screen.findByText("Showing 1–11 of 11 products")).toBeInTheDocument();
    fireEvent.click(filterButton("In stock"));
    expect(await screen.findByText("Showing 1–11 of 11 products in stock")).toBeInTheDocument();

    // The box runs ahead: the list's own debounce lands, the answer has not.
    mockHookSearchLag = "Product 1";
    fireEvent.change(searchBox(), { target: { value: "Product 2" } });
    await waitDebounce();
    fireEvent.click(exportButton());
    await waitFor(() => expect(exportToasts()).toBe(1));
    const [u] = exportCalls();
    expect(u.searchParams.get("search")).toBe("Product 1");
    expect(u.searchParams.get("stock")).toBe("in-stock");
    expect(exported().data).toHaveLength(11);
  });
});

// FR1-12's first-frame pin lives in product-list-first-frame.test.tsx: it needs
// React's mock scheduler to make the paint boundary visible in jsdom.

describe("FR1-14 — the CSV's state words are the badges' words", () => {
  it("each exported `Stock state` equals STOCK_STATE_WORDS, the map the badges render", async () => {
    const states: State[] = ["ok", "low", "out", "below-zero", "no-record"];
    rows = states.map((st, i) => row(i + 1, st));
    renderList();
    await clickExport();
    expect(exported().data.map((r) => r.stockState)).toEqual(states.map((st) => STOCK_STATE_WORDS[st]));
    for (const st of states.filter((x) => x !== "ok")) {
      expect(screen.getAllByText(STOCK_STATE_WORDS[st], { exact: true }).length).toBeGreaterThan(0);
    }
  });
});
