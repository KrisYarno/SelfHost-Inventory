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

interface ProductPerformanceData {
  productId: number;
  productName: string;
  currentStock: number;
  stockIn: number;
  stockOut: number;
  net: number;
  trend: 'up' | 'down' | 'stable';
}

interface InventoryItem {
  productId: number;
  quantity: number;
  product: {
    name: string;
  };
}

interface ActivityLog {
  productId: number;
  changeType: string;
  quantityChange: number;
  delta: number;
  logType: string;
}

export function ProductPerformance() {
  const [products, setProducts] = useState<ProductPerformanceData[]>([]);
  const [allProducts, setAllProducts] = useState<ProductPerformanceData[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const { selectedLocationId } = useLocation();
  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const PAGE_SIZE = 20;

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
  }, [loading, loadingMore, hasMore, page]);

  useEffect(() => {
    fetchProductPerformance();
  }, [selectedLocationId]);

  const fetchProductPerformance = async () => {
    try {
      setLoading(true);
      setPage(1);
      setProducts([]);
      setAllProducts([]);
      
      // Fetch current inventory levels with pagination
      const params = new URLSearchParams({
        paginate: 'true',
        page: '1',
        pageSize: '100',
        ...(selectedLocationId && { locationId: selectedLocationId.toString() })
      });
      
      const inventoryResponse = await fetch(`/api/inventory/current-fast?${params}`);
      if (!inventoryResponse.ok) throw new Error("Failed to fetch inventory");
      const inventoryData = await inventoryResponse.json();

      // Fetch recent activity to calculate performance (last 30 days)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const activityResponse = await fetch("/api/inventory/logs?pageSize=5000");
      if (!activityResponse.ok) throw new Error("Failed to fetch activity");
      const activityData = await activityResponse.json();

      // Process data to calculate performance metrics
      const performanceMap = new Map<number, ProductPerformanceData>();

      // Initialize with current inventory
      inventoryData.inventory.forEach((item: InventoryItem) => {
        performanceMap.set(item.productId, {
          productId: item.productId,
          productName: item.product.name,
          currentStock: item.quantity,
          stockIn: 0,
          stockOut: 0,
          net: 0,
          trend: 'stable'
        });
      });

      // Calculate stock movements from logs
      activityData.logs.forEach((log: ActivityLog) => {
        const perf = performanceMap.get(log.productId);
        if (perf) {
          if (log.logType === 'STOCK_IN' && log.delta > 0) {
            perf.stockIn += log.delta;
          } else if (log.logType === 'SALE' && log.delta < 0) {
            perf.stockOut += Math.abs(log.delta);
          } else if (log.logType === 'ADJUSTMENT') {
            if (log.delta > 0) {
              perf.stockIn += log.delta;
            } else {
              perf.stockOut += Math.abs(log.delta);
            }
          }
        }
      });

      // Calculate net and trend
      const performanceArray = Array.from(performanceMap.values()).map(perf => {
        perf.net = perf.stockIn - perf.stockOut;
        if (perf.net > 0) perf.trend = 'up';
        else if (perf.net < 0) perf.trend = 'down';
        else perf.trend = 'stable';
        return perf;
      });

      // Sort by absolute net movement (most active products first)
      performanceArray.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

      setAllProducts(performanceArray);
      setProducts(performanceArray.slice(0, PAGE_SIZE));
      setHasMore(performanceArray.length > PAGE_SIZE);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load performance data");
    } finally {
      setLoading(false);
    }
  };

  const loadMoreProducts = useCallback(() => {
    if (loadingMore || !hasMore) return;

    setLoadingMore(true);
    const nextPage = page + 1;
    const startIndex = page * PAGE_SIZE;
    const endIndex = startIndex + PAGE_SIZE;
    const nextProducts = allProducts.slice(startIndex, endIndex);

    if (nextProducts.length > 0) {
      setProducts(prev => [...prev, ...nextProducts]);
      setPage(nextPage);
      setHasMore(endIndex < allProducts.length);
    } else {
      setHasMore(false);
    }
    setLoadingMore(false);
  }, [page, allProducts, loadingMore, hasMore]);

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

  const chartData = products.slice(0, 10).map(p => ({
    product: p.productName.length > 20 ? p.productName.substring(0, 20) + '...' : p.productName,
    stockIn: p.stockIn,
    stockOut: p.stockOut,
    net: p.net
  }));

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
                <TableHead className="text-right">Stock In</TableHead>
                <TableHead className="text-right">Stock Out</TableHead>
                <TableHead className="text-right">Net Movement</TableHead>
                <TableHead className="text-center">Trend</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((product) => (
                <TableRow key={product.productId}>
                  <TableCell className="font-medium">
                    {product.productName}
                  </TableCell>
                  <TableCell className="text-right">
                    {product.currentStock}
                  </TableCell>
                  <TableCell className="text-right text-green-600">
                    +{product.stockIn}
                  </TableCell>
                  <TableCell className="text-right text-red-600">
                    -{product.stockOut}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    <span className={cn(
                      product.net > 0 && "text-green-600",
                      product.net < 0 && "text-red-600"
                    )}>
                      {product.net > 0 ? '+' : ''}{product.net}
                    </span>
                  </TableCell>
                  <TableCell className="text-center">
                    {product.trend === 'up' ? (
                      <Badge variant="default" className="bg-green-100 text-green-800">
                        <TrendingUp className="h-3 w-3 mr-1" />
                        Up
                      </Badge>
                    ) : product.trend === 'down' ? (
                      <Badge variant="default" className="bg-red-100 text-red-800">
                        <TrendingDown className="h-3 w-3 mr-1" />
                        Down
                      </Badge>
                    ) : (
                      <Badge variant="secondary">
                        <Minus className="h-3 w-3 mr-1" />
                        Stable
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          
          {/* Infinite scroll trigger */}
          {hasMore && (
            <div 
              ref={loadMoreRef} 
              className="flex justify-center p-4"
            >
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
              All {products.length} products loaded
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}