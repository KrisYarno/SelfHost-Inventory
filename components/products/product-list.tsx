"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { ProductWithQuantity } from "@/types/product";
import { ProductCard } from "./product-card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDebounce } from "@/hooks/use-debounce";

interface ProductListProps {
  onEdit?: (product: ProductWithQuantity) => void;
  onDelete?: (product: ProductWithQuantity) => void;
  onQuickAdjust?: (product: ProductWithQuantity) => void;
  onStockIn?: (product: ProductWithQuantity) => void;
  isAdmin?: boolean;
  showInventoryActions?: boolean;
  className?: string;
}

export function ProductList({
  onEdit,
  onDelete,
  onQuickAdjust,
  onStockIn,
  isAdmin = false,
  showInventoryActions = false,
  className,
}: ProductListProps) {
  const [products, setProducts] = useState<ProductWithQuantity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [total, setTotal] = useState(0);
  
  const debouncedSearch = useDebounce(search, 300);

  const fetchProducts = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (!showInactive) params.set("isActive", "true");
      params.set("sortBy", "sortOrder");
      params.set("sortOrder", "asc");
      params.set("getTotal", "true"); // Request total quantities across all locations
      
      const response = await fetch(`/api/products?${params}`);
      if (!response.ok) {
        throw new Error("Failed to fetch products");
      }
      
      const data = await response.json();
      setProducts(data.products);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, showInactive]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  // Group products by baseName
  const groupedProducts = useMemo(() => {
    const groups = new Map<string, ProductWithQuantity[]>();
    
    products.forEach(product => {
      const baseName = product.baseName || 'Other';
      const existing = groups.get(baseName) || [];
      groups.set(baseName, [...existing, product]);
    });
    
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [products]);

  if (loading && products.length === 0) {
    return (
      <div className={cn("space-y-4", className)}>
        <div className="flex items-center gap-4">
          <Skeleton className="h-10 flex-1" />
          <Skeleton className="h-10 w-32" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-64" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("space-y-4", className)}>
      {/* Search and filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search products..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 pr-10"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        
        {isAdmin && (
          <Button
            variant={showInactive ? "default" : "outline"}
            size="sm"
            onClick={() => setShowInactive(!showInactive)}
          >
            {showInactive ? "Showing All" : "Active Only"}
          </Button>
        )}
        
        <Badge variant="secondary" className="self-center">
          {total} {total === 1 ? "product" : "products"}
        </Badge>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Products grid */}
      {products.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-muted-foreground">
            {search ? "No products found matching your search" : "No products found"}
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {groupedProducts.map(([baseName, groupProducts]) => (
            <div key={baseName} className="space-y-4">
              <h3 className="text-lg font-semibold">{baseName}</h3>
              <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                {groupProducts.map((product) => (
                  <ProductCard
                    key={product.id}
                    product={product}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onQuickAdjust={onQuickAdjust}
                    onStockIn={onStockIn}
                    isAdmin={isAdmin}
                    showInventoryActions={showInventoryActions}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}