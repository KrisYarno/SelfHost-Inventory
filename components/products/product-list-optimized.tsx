"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ProductWithQuantity } from "@/types/product";
import { ProductCard } from "./product-card";
import { ProductCardMobile } from "./product-card-mobile";
import { MobileFilterSheet, StockFilter } from "./mobile-filter-sheet";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, X, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { exportToCSV } from "@/lib/export-utils";
import { useProducts } from "@/hooks/use-products";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { effectiveLowStockThreshold, isLowStock } from "@/lib/stock-threshold";
import { useLowStockDefault } from "@/hooks/use-low-stock-default";

interface ProductListProps {
  onEdit?: (product: ProductWithQuantity) => void;
  onDelete?: (product: ProductWithQuantity) => void;
  onQuickAdjust?: (product: ProductWithQuantity) => void;
  onStockIn?: (product: ProductWithQuantity) => void;
  isAdmin?: boolean;
  showInventoryActions?: boolean;
  className?: string;
}

export function ProductListOptimized({
  onEdit,
  onDelete,
  onQuickAdjust,
  onStockIn,
  isAdmin = false,
  showInventoryActions = false,
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
  const [isScrolled, setIsScrolled] = useState(false);
  const isMobile = useIsMobile();
  const lowStockDefault = useLowStockDefault();
  const pageSize = 25;
  
  const { data, isLoading, error } = useProducts({
    search,
    page,
    pageSize,
    sortBy: 'baseNameNumeric',
    sortOrder: 'asc',
  });

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

  // Handle scroll for collapsing search bar on mobile
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const clearSearch = () => {
    setSearch("");
    setPage(1);
    // Clearing the box drops a `search` param, so the URL never re-seeds a box
    // the user just emptied.
    dropSearchParam();
  };

  const clearFilters = () => {
    setStockFilter("all");
    setSearch("");
    setPage(1);
    dropSearchParam();
  };

  const total = data?.total || 0;
  // F0-5: the list shows ONE page; every count says so. `from`/`to` come from
  // the RESPONSE's page and pageSize, and the page's own row count.
  const rowsOnPage = data?.products.length ?? 0;
  const from = data ? (data.page - 1) * data.pageSize + 1 : 0;
  const to = data ? (data.page - 1) * data.pageSize + rowsOnPage : 0;
  const pageCount = data && data.pageSize > 0 ? Math.ceil(data.total / data.pageSize) : 0;

  // Apply client-side stock filtering
  const filteredProducts = useMemo(() => {
    const products = data?.products ?? [];
    return products.filter((product) => {
      switch (stockFilter) {
        case "in-stock":
          return product.currentQuantity > 0;
        case "low-stock":
          return isLowStock(
            product.currentQuantity,
            effectiveLowStockThreshold(product.lowStockThreshold, lowStockDefault)
          );
        case "out-of-stock":
          return product.currentQuantity === 0;
        default:
          return true;
      }
    });
  }, [data?.products, stockFilter, lowStockDefault]);

  const handleExportCSV = () => {
    if (filteredProducts.length === 0) return;
    exportToCSV(
      filteredProducts,
      [
        { key: "name", label: "Product Name" },
        { key: "baseName", label: "Category" },
        { key: "variant", label: "Variant" },
        { key: "currentQuantity", label: "Quantity" },
        { key: "lowStockThreshold", label: "Low Stock Threshold" },
        { key: "costPrice", label: "Cost Price" },
        { key: "retailPrice", label: "Retail Price" },
      ],
      `products-${new Date().toISOString().split("T")[0]}.csv`
    );
    const n = filteredProducts.length;
    toast.success(`Exported ${n} ${n === 1 ? "product" : "products"} from this page.`);
  };

  const activeFilterCount = stockFilter !== "all" ? 1 : 0;

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-destructive">Error loading products</p>
        <Button onClick={() => window.location.reload()} className="mt-4">
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className={cn("space-y-4 md:space-y-6", className)}>
      {/* Search and Filters */}
      <div className={cn(
        "sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60",
        "transition-all duration-300",
        isMobile && isScrolled ? "py-2" : "pb-4"
      )}>
        <div className="flex gap-2">
          <div className={cn(
            "relative flex-1 transition-all duration-300",
            isMobile && isScrolled && "max-w-[200px]"
          )}>
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={isMobile && isScrolled ? "Search..." : "Search products..."}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
                // FR1-8: the first edit that leaves the URL's value behind drops it.
                if (e.target.value !== urlSearch) dropSearchParam();
              }}
              className="pl-10 pr-10"
            />
            {search && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearSearch}
                className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 p-0 max-md:min-h-0 max-md:min-w-0"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
          {isMobile && (
            <MobileFilterSheet
              stockFilter={stockFilter}
              onStockFilterChange={setStockFilter}
              onClearFilters={clearFilters}
              activeFilterCount={activeFilterCount}
            />
          )}
          {filteredProducts.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCSV}
              className="shrink-0"
              aria-label="Export this page"
            >
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline ml-1">Export this page</span>
            </Button>
          )}
        </div>
      </div>

      {/* Results Summary — this page out of the response's total; with a stock
          filter on, how many of THIS page's rows match (the filter is
          client-side, over one page). */}
      {/* FR1-7: only when this page has rows — never "Showing 26–25 of 20". */}
      {rowsOnPage > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground px-1 md:px-0">
          <span>
            {stockFilter === "all"
              ? `Showing ${from}–${to} of ${total} ${total === 1 ? "product" : "products"}`
              : rowsOnPage === 1 && filteredProducts.length === 1
                ? // F1-13 (F0 QA-6.1): never "1 of the 1 products".
                  "The one product on this page matches"
                : filteredProducts.length === 1
                  ? `1 of the ${rowsOnPage} products on this page matches`
                  : `${filteredProducts.length} of the ${rowsOnPage} products on this page match`}
          </span>
        </div>
      )}

      {/* Product Grid */}
      {isLoading ? (
        <div className={cn(
          "grid gap-3 md:gap-4",
          isMobile ? "grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        )}>
          {[...Array(8)].map((_, i) => (
            <Skeleton key={i} className={isMobile ? "aspect-[3/4] sm:aspect-square" : "h-[180px]"} />
          ))}
        </div>
      ) : rowsOnPage > 0 && filteredProducts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {pageCount > 1
              ? "No products on this page match — try another page or clear the filter."
              : "No products match — clear the filter."}
          </p>
        </div>
      ) : filteredProducts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <p className="mb-2 text-lg font-medium">No products found</p>
          <p className="text-sm text-muted-foreground">
            {search || stockFilter !== "all"
              ? "Try adjusting your filters"
              : "Add your first product to get started"}
          </p>
        </div>
      ) : (
        <div className={cn(
          "grid gap-3 md:gap-4",
          isMobile ? "grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        )}>
          {filteredProducts.map((product) => (
            isMobile ? (
              <ProductCardMobile
                key={product.id}
                product={product}
                onClick={(p) => {
                  if (showInventoryActions && onQuickAdjust) {
                    onQuickAdjust(p);
                  } else if (isAdmin && onEdit) {
                    onEdit(p);
                  }
                }}
              />
            ) : (
              <ProductCard
                key={product.id}
                product={product}
                onEdit={isAdmin ? () => onEdit?.(product) : undefined}
                onDelete={isAdmin ? () => onDelete?.(product) : undefined}
                onQuickAdjust={
                  showInventoryActions ? () => onQuickAdjust?.(product) : undefined
                }
                onStockIn={
                  showInventoryActions ? () => onStockIn?.(product) : undefined
                }
                isAdmin={isAdmin}
                showInventoryActions={showInventoryActions}
              />
            )
          ))}
        </div>
      )}

      {/* Pagination */}
      {total > pageSize && (
        <div className="flex justify-center gap-2 pt-4 pb-20 md:pb-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            {isMobile ? "Prev" : "Previous"}
          </Button>
          <span className="flex items-center px-2 md:px-3 text-sm">
            {isMobile ? `${page}/${Math.ceil(total / pageSize)}` : `Page ${page} of ${Math.ceil(total / pageSize)}`}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(p => p + 1)}
            disabled={page >= Math.ceil(total / pageSize)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
