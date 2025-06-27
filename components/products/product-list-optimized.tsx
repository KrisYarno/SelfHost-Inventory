"use client";

import { useState, useMemo } from "react";
import { ProductWithQuantity } from "@/types/product";
import { ProductCard } from "./product-card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useProducts } from "@/hooks/use-products";
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';

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
  const pageSize = 25;
  
  const { data, isLoading, error } = useProducts({
    search,
    page,
    pageSize,
    sortBy: 'name',
    sortOrder: 'asc',
  });

  const clearSearch = () => {
    setSearch("");
    setPage(1);
  };

  const products = data?.products || [];
  const total = data?.total || 0;

  // Memoize filtered categories
  const categories = useMemo(() => {
    const categoryMap = new Map<string, number>();
    products.forEach((product) => {
      const category = product.baseName || "Uncategorized";
      categoryMap.set(category, (categoryMap.get(category) || 0) + 1);
    });
    return Array.from(categoryMap.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    );
  }, [products]);

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
    <div className={cn("space-y-6", className)}>
      {/* Search */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 pb-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search products..."
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
      </div>

      {/* Results Summary */}
      {(search || categories.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>
            {total} {total === 1 ? "product" : "products"}
            {search && " found"}
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {[...Array(8)].map((_, i) => (
            <Skeleton key={i} className="h-[180px]" />
          ))}
        </div>
      ) : products.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <p className="mb-2 text-lg font-medium">No products found</p>
          <p className="text-sm text-muted-foreground">
            {search
              ? "Try adjusting your search terms"
              : "Add your first product to get started"}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {products.map((product) => (
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
          ))}
        </div>
      )}

      {/* Pagination */}
      {total > pageSize && (
        <div className="flex justify-center gap-2 pt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            Previous
          </Button>
          <span className="flex items-center px-3 text-sm">
            Page {page} of {Math.ceil(total / pageSize)}
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