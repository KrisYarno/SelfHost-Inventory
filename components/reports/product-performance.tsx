"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { BarChartComponent } from "./inventory-chart";
import { cn } from "@/lib/utils";

interface ProductPerformanceData {
  productId: number;
  productName: string;
  currentStock: number;
  stockIn: number;
  stockOut: number;
  net: number;
  trend: 'up' | 'down' | 'stable';
}

export function ProductPerformance() {
  const [products, setProducts] = useState<ProductPerformanceData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchProductPerformance();
  }, []);

  const fetchProductPerformance = async () => {
    try {
      setLoading(true);
      
      // Fetch current inventory levels
      const inventoryResponse = await fetch("/api/inventory/current-fast");
      if (!inventoryResponse.ok) throw new Error("Failed to fetch inventory");
      const inventoryData = await inventoryResponse.json();

      // Fetch recent activity to calculate performance
      const activityResponse = await fetch("/api/inventory/logs?pageSize=1000");
      if (!activityResponse.ok) throw new Error("Failed to fetch activity");
      const activityData = await activityResponse.json();

      // Process data to calculate performance metrics
      const performanceMap = new Map<number, ProductPerformanceData>();

      // Initialize with current inventory
      inventoryData.inventory.forEach((item: any) => {
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
      activityData.logs.forEach((log: any) => {
        const perf = performanceMap.get(log.productId);
        if (perf) {
          if (log.changeType === 'STOCK_IN') {
            perf.stockIn += log.quantityChange;
          } else if (log.changeType === 'SALE') {
            perf.stockOut += Math.abs(log.quantityChange);
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

      setProducts(performanceArray.slice(0, 10)); // Top 10 products
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load performance data");
    } finally {
      setLoading(false);
    }
  };

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

  const chartData = products.map(p => ({
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
        </CardContent>
      </Card>
    </div>
  );
}