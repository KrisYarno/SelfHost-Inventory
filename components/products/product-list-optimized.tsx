"use client";

import { useState, useEffect, useLayoutEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ProductWithQuantity } from "@/types/product";
import { ProductRow } from "./product-row";
import { ProductGridTile } from "./product-grid-tile";
import { ProductTable } from "./product-table";
// FR1-14: the ONE map of the state words (the badges read it too).
import { STOCK_STATE_WORDS } from "./product-stock";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryState } from "@/components/ui/query-state";
import { Search, X, Download, List, LayoutGrid, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { exportToCSV } from "@/lib/export-utils";
import { useProducts } from "@/hooks/use-products";
import { useDebounce } from "@/hooks/use-debounce";
import { useLocation } from "@/contexts/location-context";

/** Facelift F2-5: the server-side stock filter (`all` = no filter). */
type StockFilter = "all" | "in-stock" | "low" | "out";

const STOCK_FILTERS: Array<{ value: StockFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "in-stock", label: "In stock" },
  { value: "low", label: "Low" },
  { value: "out", label: "Out" },
];

/** F2-5: the count's noun by the filter its answer describes; [singular, plural]. */
const COUNT_NOUNS: Record<StockFilter, [string, string]> = {
  all: ["product", "products"],
  "in-stock": ["product in stock", "products in stock"],
  low: ["low-stock product", "low-stock products"],
  out: ["product out of stock", "products out of stock"],
};

type ProductView = "list" | "grid";
/** F2-8 / A13: where this device remembers the view. */
const VIEW_KEY = "products.view";

const PAGE_SIZE = 25;
/** F2-9 / A6: the export reads the catalogue this many rows at a time. */
const EXPORT_PAGE_SIZE = 500;

/** One page of `/api/products/optimized` as the export reads it. */
interface ExportPage {
  products: ProductWithQuantity[];
  /** FR1-6: how many rows the answer says match; the first page's is the export's yardstick. */
  total: number;
  pageSize: number;
  totalPages: number;
}

// FR1-12: the remembered view is read in the commit, before the browser paints
// (a layout effect), so a remembered Grid is the first frame shown. The server
// renders no effects.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

interface ProductListProps {
  onEdit?: (product: ProductWithQuantity) => void;
  onDelete?: (product: ProductWithQuantity) => void;
  onQuickAdjust: (product: ProductWithQuantity) => void;
  onStockIn: (product: ProductWithQuantity) => void;
  /** F2-9: the admin empty state's `Add Product` (opens the create dialog). */
  onCreate?: () => void;
  isAdmin?: boolean;
  className?: string;
}

export function ProductListOptimized({
  onEdit,
  onDelete,
  onQuickAdjust,
  onStockIn,
  onCreate,
  isAdmin = false,
  className,
}: ProductListProps) {
  // F0-6: the search box follows the `search` URL value (global search links
  // here with `?search=<name>`). The initialiser reads it on first mount, so
  // there is no unfiltered first fetch; the effect below re-seeds it whenever
  // the VALUE changes while the list is mounted. Typing never writes the URL.
  const searchParams = useSearchParams();
  const urlSearch = searchParams?.get("search") ?? "";
  const [search, setSearch] = useState(urlSearch);
  const [page, setPage] = useState(1);
  const [stockFilter, setStockFilter] = useState<StockFilter>("all");
  // F2-8 / A13: "list" on the first render; the remembered choice is read
  // after mount (FR1-12: before the first paint).
  const [view, setView] = useState<ProductView>("list");
  const [exporting, setExporting] = useState(false);
  // A6: the export reads the search the list is showing (the hook's debounce).
  const debouncedSearch = useDebounce(search, 300);
  const { selectedLocation, selectedLocationId, isLoading: locationsLoading } = useLocation();

  // A14: one read, not two: the list waits for the locations read, so its
  // first request already carries the confirmed location. A failed locations
  // read leaves no confirmed location, and the list reads without one.
  const query = useProducts(
    {
      search,
      page,
      pageSize: PAGE_SIZE,
      sortBy: "baseNameNumeric",
      sortOrder: "asc",
      stock: stockFilter,
      hereLocationId: selectedLocationId,
    },
    { enabled: !locationsLoading },
  );
  const { data, isError, isPlaceholderData, refetch } = query;

  // FR1-8: the list drops a `search` param it no longer matches (it never
  // WRITES typed text), so a later global-search pick of the same product
  // changes the URL and re-seeds. Its own drop is not a re-seed: the box keeps
  // what the user typed.
  //
  // FR2-3: dropping the param is not a navigation. `router.replace` went to the
  // server for the route (a request on a keystroke, a scroll jump, and offline a
  // failed transition); Next 14.2 keeps `useSearchParams` in sync with a plain
  // `history.replaceState`, which does none of that.
  const droppingSearchParamRef = useRef(false);
  const dropSearchParam = () => {
    if (!searchParams?.has("search")) return;
    droppingSearchParamRef.current = true;
    window.history.replaceState(null, "", "/products");
  };

  useEffect(() => {
    if (droppingSearchParamRef.current) {
      droppingSearchParamRef.current = false;
      if (urlSearch === "") return;
    }
    setSearch(urlSearch);
    setPage(1);
  }, [urlSearch]);

  // A13 / FR1-12: the remembered view, read once after mount, in the commit
  // (never in the useState initializer). Storage that throws (or holds anything
  // else) leaves the List default.
  useIsomorphicLayoutEffect(() => {
    try {
      const saved = window.localStorage.getItem(VIEW_KEY);
      if (saved === "list" || saved === "grid") setView(saved);
    } catch {
      // No storage: the toggle still works for this session.
    }
  }, []);

  // A5: an answer for a page past the end (the catalogue shrank under it)
  // moves to the last page that exists.
  useEffect(() => {
    if (!data || isPlaceholderData) return;
    if (data.products.length === 0 && data.total > 0 && data.page > 1) {
      setPage(Math.max(1, Math.ceil(data.total / data.pageSize)));
    }
  }, [data, isPlaceholderData]);

  const chooseView = (next: ProductView) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // No storage: the choice lasts for this session.
    }
  };

  const clearSearch = () => {
    setSearch("");
    setPage(1);
    // Clearing the box drops a `search` param, so the URL never re-seeds a box
    // the user just emptied.
    dropSearchParam();
  };

  // F2-5: a filter change starts at page 1 and keeps the search.
  const chooseFilter = (next: StockFilter) => {
    setStockFilter(next);
    setPage(1);
  };

  // F2-9: a page change starts the new page at the top of the shell's scroller.
  const goToPage = (next: number) => {
    setPage(next);
    document.getElementById("main")?.scrollTo({ top: 0 });
  };

  // F2-5 / B5: the count's numbers AND its noun come from ONE answer, so during
  // placeholder data the previous answer's count shows whole.
  const countNouns = data ? COUNT_NOUNS[data.stock] : undefined;
  const countText =
    data && countNouns && data.products.length > 0
      ? `Showing ${(data.page - 1) * data.pageSize + 1}–${(data.page - 1) * data.pageSize + data.products.length} of ${data.total} ${data.total === 1 ? countNouns[0] : countNouns[1]}`
      : "";
  const caption = selectedLocation
    ? `Totals cover all locations. “Here” is ${selectedLocation.name}.`
    : "Totals cover all locations.";
  // FR1-10: the paging line is the answer's own page of its own count (`data`
  // is the answer QueryState hands the rows below).
  const pageCount = data && data.pageSize > 0 ? Math.ceil(data.total / data.pageSize) : 0;
  // F2-9: an answer that says the catalogue (or the match) is empty has
  // nothing to export.
  const exportHidden = data !== undefined && !isPlaceholderData && data.total === 0;
  // FR1-10: every sentence (and the export) describes the ANSWER on screen: its
  // own search and filter, never the box or the buttons, which can run ahead of
  // it. Before any answer there is nothing on screen to describe, and the
  // export reads what the list is reading.
  const answerSearch = data ? data.search : debouncedSearch;
  const answerStock = data ? data.stock : stockFilter;

  // F2-9 (FL-B-2, A6): every product matching the search and the filter, read
  // 500 at a time: page 1, then EXACTLY pages 2..totalPages of that first
  // answer, stopping early on a short or empty page. Rows are de-duplicated by
  // id; the file and the toast count the rows actually gathered (FR1-6: and
  // say so when that is fewer than the first answer's total).
  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    // The location the `At` column is named for is the one its values were read for.
    const location = selectedLocation;
    const search = answerSearch;
    const stock = answerStock;
    const readPage = async (n: number): Promise<ExportPage> => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      params.set("sortBy", "baseNameNumeric");
      params.set("sortOrder", "asc");
      params.set("page", String(n));
      params.set("pageSize", String(EXPORT_PAGE_SIZE));
      if (stock !== "all") params.set("stock", stock);
      if (location) params.set("hereLocationId", String(location.id));
      const response = await fetch(`/api/products/optimized?${params}`);
      if (!response.ok) throw new Error("Failed to export products");
      return response.json();
    };
    try {
      const gathered = new Map<number, ProductWithQuantity>();
      const keep = (products: ProductWithQuantity[]) => {
        for (const product of products) {
          if (!gathered.has(product.id)) gathered.set(product.id, product);
        }
      };
      const first = await readPage(1);
      keep(first.products);
      if (first.products.length >= first.pageSize) {
        for (let n = 2; n <= first.totalPages; n++) {
          const next = await readPage(n);
          keep(next.products);
          if (next.products.length < first.pageSize) break;
        }
      }
      const rows = Array.from(gathered.values()).map((product) => ({
        name: product.name,
        baseName: product.baseName,
        variant: product.variant,
        // Raw numbers: a null total or here is an empty cell, never 0.
        totalQuantity: product.totalQuantity,
        hereQuantity: product.hereQuantity,
        stockState: product.stockState ? STOCK_STATE_WORDS[product.stockState] : undefined,
        lowStockThreshold: product.lowStockThreshold,
        costPrice: product.costPrice,
        retailPrice: product.retailPrice,
      }));
      const n = rows.length;
      // FR1-6: nothing gathered is no file (never `Exported 0 products.`).
      if (n === 0) {
        toast.info("No products to export.");
        return;
      }
      exportToCSV(
        rows,
        [
          { key: "name", label: "Product Name" },
          { key: "baseName", label: "Category" },
          { key: "variant", label: "Variant" },
          { key: "totalQuantity", label: "Total (all locations)" },
          ...(location ? [{ key: "hereQuantity", label: `At ${location.name}` }] : []),
          { key: "stockState", label: "Stock state" },
          { key: "lowStockThreshold", label: "Low Stock Threshold" },
          { key: "costPrice", label: "Cost Price" },
          { key: "retailPrice", label: "Retail Price" },
        ],
        `products-${new Date().toISOString().split("T")[0]}.csv`
      );
      // FR1-6: fewer rows than the first answer said match means the catalogue
      // changed while the pages were read: the file is written, and says so.
      if (n < first.total) {
        toast.warning(
          `Exported ${n} of ${first.total} products. The list changed during the export — export again for a complete file.`
        );
      } else {
        toast.success(`Exported ${n} ${n === 1 ? "product" : "products"}.`);
      }
    } catch (error) {
      console.error("Error exporting products:", error);
      toast.error("Couldn't export products. Try again.");
    } finally {
      setExporting(false);
    }
  };

  const tileGrid = "grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5";
  const rowFrame = "lg:hidden rounded-lg border bg-surface divide-y";

  // F2-9 / A11: 8 rows of h-14 in the list frame (and the table's own rows at
  // lg), or 8 tiles in the grid. B13: also while the read waits for locations.
  const skeleton =
    view === "list" ? (
      <>
        <div className={rowFrame}>
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-14 rounded-none" />
          ))}
        </div>
        <div className="hidden lg:block space-y-1">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      </>
    ) : (
      <div className={tileGrid}>
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="min-h-28 rounded-lg" />
        ))}
      </div>
    );

  // F2-9 / A24: a search or a filter that matches nothing, or a catalogue with
  // nothing in it yet. Each button clears ONLY its own part. FR1-10: said of the
  // answer's own search and filter, so a box just cleared never reads `No
  // products yet.` before its answer arrives.
  const empty =
    answerSearch !== "" || answerStock !== "all" ? (
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
        <p className="text-sm text-muted-foreground">No products match.</p>
        {answerStock !== "all" && (
          <Button variant="outline" size="sm" onClick={() => chooseFilter("all")}>
            Show all stock
          </Button>
        )}
      </div>
    ) : (
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
        <p className="text-sm text-muted-foreground">No products yet.</p>
        {isAdmin && onCreate && (
          <Button size="sm" onClick={onCreate}>
            <Plus className="h-4 w-4" />
            Add Product
          </Button>
        )}
      </div>
    );

  const actions = {
    isAdmin,
    onAdjust: onQuickAdjust,
    onStockIn,
    onEdit: isAdmin ? onEdit : undefined,
    onDelete: isAdmin ? onDelete : undefined,
  };

  return (
    <div className={cn("space-y-3", className)}>
      {/* F2-5 / A22: lines 1-2 are the sticky tool bar (opaque, above the rows). */}
      <div className="sticky top-0 z-20 bg-background border-b py-2 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              enterKeyHint="search"
              aria-label="Search products"
              placeholder="Search products..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
                // FR1-8: the first edit that leaves the URL's value behind drops it.
                if (e.target.value !== urlSearch) dropSearchParam();
              }}
              className="pl-10 pr-10 max-md:h-11"
            />
            {search && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearSearch}
                aria-label="Clear search"
                className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 p-0 max-md:min-h-0 max-md:min-w-0"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
          <div role="group" aria-label="View" className="flex shrink-0 gap-1">
            <Button
              variant={view === "list" ? "secondary" : "outline"}
              size="icon"
              aria-label="List view"
              aria-pressed={view === "list"}
              onClick={() => chooseView("list")}
            >
              <List className="h-4 w-4" />
            </Button>
            <Button
              variant={view === "grid" ? "secondary" : "outline"}
              size="icon"
              aria-label="Grid view"
              aria-pressed={view === "grid"}
              onClick={() => chooseView("grid")}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
          </div>
          {!exportHidden && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={exporting || isPlaceholderData}
              className="shrink-0"
              aria-label="Export CSV"
            >
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline">{exporting ? "Exporting…" : "Export"}</span>
            </Button>
          )}
        </div>
        <div role="group" aria-label="Stock filter" className="flex flex-wrap gap-2">
          {STOCK_FILTERS.map(({ value, label }) => (
            <Button
              key={value}
              variant={stockFilter === value ? "default" : "outline"}
              size="sm"
              aria-pressed={stockFilter === value}
              onClick={() => chooseFilter(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      {/* F2-5 line 3 (A22, A23): in normal flow above the list. Only the count is live. */}
      <div className="text-xs text-muted-foreground">
        <span aria-live="polite">{countText}</span>
        {countText && " · "}
        <span>{caption}</span>
        {isError && data !== undefined && (
          <>
            {" · "}
            <span>Couldn&apos;t refresh. Showing the last loaded list.</span>{" "}
            <Button variant="link" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </>
        )}
      </div>

      <QueryState
        query={query}
        skeleton={skeleton}
        idle={skeleton}
        isEmpty={(d) => d.total === 0}
        empty={empty}
        errorText="Couldn't load products."
      >
        {(d) => (
          <>
            {d.products.length > 0 && (
              <div
                aria-busy={isPlaceholderData ? "true" : undefined}
                className={cn(isPlaceholderData && "opacity-60")}
              >
                {view === "list" ? (
                  <>
                    <div className={rowFrame}>
                      {d.products.map((product) => (
                        <ProductRow
                          key={product.id}
                          product={product}
                          hereLocationId={d.hereLocationId}
                          selectedLocationId={selectedLocationId}
                          {...actions}
                        />
                      ))}
                    </div>
                    <ProductTable
                      products={d.products}
                      hereLocationId={d.hereLocationId}
                      selectedLocation={selectedLocation}
                      {...actions}
                    />
                  </>
                ) : (
                  <div className={tileGrid}>
                    {d.products.map((product) => (
                      <ProductGridTile
                        key={product.id}
                        product={product}
                        hereLocationId={d.hereLocationId}
                        selectedLocationId={selectedLocationId}
                        {...actions}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* F2-9: paging (no pb-20: the shell already clears the dock).
                FR1-10: while a page, search or filter is in flight the buttons
                wait for its answer. */}
            {pageCount > 1 && (
              <div className="flex items-center justify-center gap-2 pt-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => goToPage(Math.max(1, page - 1))}
                  disabled={page === 1 || isPlaceholderData}
                >
                  Previous
                </Button>
                <span className="px-2 text-sm">{`Page ${d.page} of ${pageCount}`}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => goToPage(page + 1)}
                  disabled={page >= pageCount || isPlaceholderData}
                >
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </QueryState>
    </div>
  );
}
