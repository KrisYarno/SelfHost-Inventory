"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, TrendingDown, Minus, Loader2 } from "lucide-react";
import { BarChartComponent } from "./inventory-chart";
import { cn } from "@/lib/utils";
import { useLocation } from "@/contexts/location-context";
import { ProductMovementSummary, TrendDirection } from "@/types/reports";

const PAGE_SIZE = 20;

export function ProductPerformance() {
  const [products, setProducts] = useState<ProductMovementSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [totalProducts, setTotalProducts] = useState(0);
  const { selectedLocationId } = useLocation();
  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const fetchProductPerformance = useCallback(async (pageNum: number, append: boolean = false) => {
    try {
      if (!append) {
        setLoading(true);
        setProducts([]);
      } else {
        setLoadingMore(true);
      }

      // Use new server-side aggregation API
      const params = new URLSearchParams({
        days: "30",
        page: pageNum.toString(),
        pageSize: PAGE_SIZE.toString(),
        sortBy: "activity",
        ...(selectedLocationId && { locationId: selectedLocationId.toString() }),
      });

      const response = await fetch(`/api/reports/product-movement-summary?${params}`);
      if (!response.ok) throw new Error("Failed to fetch product performance");

      const data = await response.json();

      if (append) {
        setProducts((prev) => [...prev, ...data.products]);
      } else {
        setProducts(data.products);
      }

      setTotalProducts(data.pagination.total);
      setHasMore(pageNum < data.pagination.totalPages);
      setPage(pageNum);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load performance data");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [selectedLocationId]);

  const loadMoreProducts = useCallback(() => {
    if (loadingMore || !hasMore) return;
    fetchProductPerformance(page + 1, true);
  }, [page, loadingMore, hasMore, fetchProductPerformance]);

  // Infinite scroll observer
  useEffect(() => {
    if (loading || loadingMore || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMoreProducts();
        }
      },
      { threshold: 0.1 }
    );

    if (loadMoreRef.current) {
      observer.observe(loadMoreRef.current);
    }

    observerRef.current = observer;

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [loading, loadingMore, hasMore, loadMoreProducts]);

  // Initial load and refresh on location change
  useEffect(() => {
    fetchProductPerformance(1, false);
  }, [fetchProductPerformance]);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Product Performance</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <Skeleton className="h-[300px] w-full" />
            <Skeleton className="h-[200px] w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Product Performance</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Error: {error}</p>
        </CardContent>
      </Card>
    );
  }

  const chartData = products.slice(0, 10).map((p) => ({
    product: p.productName.length > 20 ? p.productName.substring(0, 20) + "..." : p.productName,
    stockIn: p.stockIn,
    stockOut: p.stockOut,
    net: p.netMovement,
  }));

  const getTrendBadge = (trend: TrendDirection) => {
    switch (trend) {
      case "up":
        return (
          <Badge
            variant="default"
            className="bg-positive-muted text-positive-foreground border border-positive-border"
          >
            <TrendingUp className="h-3 w-3 mr-1" />
            Up
          </Badge>
        );
      case "down":
        return (
          <Badge
            variant="default"
            className="bg-negative-muted text-negative-foreground border border-negative-border"
          >
            <TrendingDown className="h-3 w-3 mr-1" />
            Down
          </Badge>
        );
      default:
        return (
          <Badge variant="secondary">
            <Minus className="h-3 w-3 mr-1" />
            Stable
          </Badge>
        );
    }
  };

  return (
    <div className="space-y-6">
      <BarChartComponent
        data={chartData}
        title="Top Product Movement"
        description="Stock in vs stock out for most active products"
      />

      <Card>
        <CardHeader>
          <CardTitle>Performance Details</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Current Stock</TableHead>
                <TableHead className="text-right hidden sm:table-cell">Stock In</TableHead>
                <TableHead className="text-right hidden sm:table-cell">Stock Out</TableHead>
                <TableHead className="text-right">Net Movement</TableHead>
                <TableHead className="text-center hidden md:table-cell">Trend</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((product) => (
                <TableRow key={product.productId}>
                  <TableCell className="font-medium">{product.productName}</TableCell>
                  <TableCell className="text-right">{product.currentStock}</TableCell>
                  <TableCell className="text-right text-positive hidden sm:table-cell">+{product.stockIn}</TableCell>
                  <TableCell className="text-right text-negative hidden sm:table-cell">-{product.stockOut}</TableCell>
                  <TableCell className="text-right font-medium">
                    <span
                      className={cn(
                        product.netMovement > 0 && "text-positive",
                        product.netMovement < 0 && "text-negative"
                      )}
                    >
                      {product.netMovement > 0 ? "+" : ""}
                      {product.netMovement}
                    </span>
                  </TableCell>
                  <TableCell className="text-center hidden md:table-cell">{getTrendBadge(product.trend)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Infinite scroll trigger */}
          {hasMore && (
            <div ref={loadMoreRef} className="flex justify-center p-4">
              {loadingMore && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm">Loading more products...</span>
                </div>
              )}
            </div>
          )}

          {!hasMore && products.length > 0 && (
            <div className="text-center p-4 text-sm text-muted-foreground">
              All {products.length} of {totalProducts} products loaded
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
