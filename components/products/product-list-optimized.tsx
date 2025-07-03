"use client";

import { useState, useMemo, useEffect } from "react";
import { ProductWithQuantity } from "@/types/product";
import { ProductCard } from "./product-card";
import { ProductCardMobile } from "./product-card-mobile";
import { MobileFilterSheet, StockFilter } from "./mobile-filter-sheet";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useProducts } from "@/hooks/use-products";

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
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [stockFilter, setStockFilter] = useState<StockFilter>("all");
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const pageSize = 25;
  
  const { data, isLoading, error } = useProducts({
    search,
    page,
    pageSize,
    sortBy: 'name',
    sortOrder: 'asc',
  });

  // Check if mobile on mount and resize
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

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
  };

  const clearFilters = () => {
    setStockFilter("all");
    setSearch("");
    setPage(1);
  };

  const products = data?.products || [];
  const total = data?.total || 0;

  // Apply client-side stock filtering
  const filteredProducts = useMemo(() => {
    return products.filter((product) => {
      switch (stockFilter) {
        case "in-stock":
          return product.currentQuantity > 0;
        case "low-stock":
          return product.currentQuantity > 0 && product.currentQuantity <= 10;
        case "out-of-stock":
          return product.currentQuantity === 0;
        default:
          return true;
      }
    });
  }, [products, stockFilter]);

  // Memoize filtered categories
  const categories = useMemo(() => {
    const categoryMap = new Map<string, number>();
    filteredProducts.forEach((product) => {
      const category = product.baseName || "Uncategorized";
      categoryMap.set(category, (categoryMap.get(category) || 0) + 1);
    });
    return Array.from(categoryMap.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    );
  }, [filteredProducts]);

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
              }}
              className="pl-10 pr-10"
            />
            {search && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearSearch}
                className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 p-0"
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
        </div>
      </div>

      {/* Results Summary */}
      {(search || categories.length > 0 || stockFilter !== "all") && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground px-1 md:px-0">
          <span>
            {filteredProducts.length} {filteredProducts.length === 1 ? "product" : "products"}
            {(search || stockFilter !== "all") && " found"}
          </span>
          {categories.length > 0 && (
            <>
              <span>•</span>
              <span>{categories.length} categories</span>
            </>
          )}
        </div>
      )}

      {/* Product Grid */}
      {isLoading ? (
        <div className={cn(
          "grid gap-3 md:gap-4",
          isMobile ? "grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        )}>
          {[...Array(8)].map((_, i) => (
            <Skeleton key={i} className={isMobile ? "aspect-square" : "h-[180px]"} />
          ))}
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