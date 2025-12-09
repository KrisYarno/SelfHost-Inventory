"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  ReorderRecommendation,
  ReorderSummary,
  StockStatus,
} from "@/types/reports";
import { AlertTriangle, Package, ShoppingCart, TrendingDown, CheckCircle } from "lucide-react";

interface ReorderRecommendationsProps {
  statusFilter?: string;
}

const STATUS_CONFIG: Record<
  StockStatus,
  { label: string; variant: "destructive" | "warning" | "secondary" | "default"; icon: React.ReactNode }
> = {
  CRITICAL: {
    label: "Critical!",
    variant: "destructive",
    icon: <AlertTriangle className="h-3 w-3" />,
  },
  NEED_ORDER: {
    label: "Need Order",
    variant: "warning",
    icon: <ShoppingCart className="h-3 w-3" />,
  },
  RUNNING_LOW: {
    label: "Running Low",
    variant: "secondary",
    icon: <TrendingDown className="h-3 w-3" />,
  },
  OKAY: {
    label: "Okay",
    variant: "default",
    icon: <CheckCircle className="h-3 w-3" />,
  },
};

// Color dot for mobile status indicator
function StatusDot({ status, className }: { status: StockStatus; className?: string }) {
  return (
    <span
      className={cn(
        "h-2 w-2 rounded-full",
        status === "CRITICAL" && "bg-negative",
        status === "NEED_ORDER" && "bg-warning",
        status === "RUNNING_LOW" && "bg-info",
        status === "OKAY" && "bg-positive",
        className
      )}
    />
  );
}

export function ReorderRecommendations({ statusFilter: externalStatusFilter }: ReorderRecommendationsProps) {
  const [recommendations, setRecommendations] = useState<ReorderRecommendation[]>([]);
  const [summary, setSummary] = useState<ReorderSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState(externalStatusFilter || "all");
  const [sortBy, setSortBy] = useState<"alphabetical" | "status">("alphabetical");

  const fetchRecommendations = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams({
        sortBy,
        limit: "100",
        ...(statusFilter !== "all" && { statusFilter }),
      });

      const response = await fetch(`/api/reports/reorder-recommendations?${params}`);
      if (!response.ok) throw new Error("Failed to fetch reorder recommendations");

      const data = await response.json();
      setRecommendations(data.recommendations);
      setSummary(data.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load recommendations");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, sortBy]);

  useEffect(() => {
    fetchRecommendations();
  }, [fetchRecommendations]);

  // Update internal filter when external prop changes
  useEffect(() => {
    if (externalStatusFilter) {
      setStatusFilter(externalStatusFilter);
    }
  }, [externalStatusFilter]);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Reorder Recommendations</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <Skeleton className="h-[60px] w-full" />
            <Skeleton className="h-[400px] w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Reorder Recommendations</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Error: {error}</p>
        </CardContent>
      </Card>
    );
  }

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(value);

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      {summary && (
        <div className="grid gap-4 grid-cols-2 sm:grid-cols-4">
          <Card className={cn(summary.criticalCount > 0 && "border-negative bg-negative-muted/30")}>
            <CardContent className="p-4">
              <div className="text-2xl font-bold">{summary.criticalCount}</div>
              <div className="text-xs text-muted-foreground">Critical!</div>
            </CardContent>
          </Card>
          <Card className={cn(summary.needOrderCount > 0 && "border-warning bg-warning-muted/30")}>
            <CardContent className="p-4">
              <div className="text-2xl font-bold">{summary.needOrderCount}</div>
              <div className="text-xs text-muted-foreground">Need Order</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold">{summary.runningLowCount}</div>
              <div className="text-xs text-muted-foreground">Running Low</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold">{formatCurrency(summary.totalOrderValue)}</div>
              <div className="text-xs text-muted-foreground">Est. Order Value</div>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Package className="h-5 w-5" />
                Reorder Recommendations
              </CardTitle>
              <CardDescription>
                Products sorted by {sortBy === "alphabetical" ? "name" : "status urgency"}
              </CardDescription>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full sm:w-[150px]">
                  <SelectValue placeholder="All Products" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Products</SelectItem>
                  <SelectItem value="critical">Critical!</SelectItem>
                  <SelectItem value="need_order">Need Order+</SelectItem>
                  <SelectItem value="running_low">Running Low+</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as "alphabetical" | "status")}>
                <SelectTrigger className="w-full sm:w-[140px]">
                  <SelectValue placeholder="Sort by" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="alphabetical">A-Z (Name)</SelectItem>
                  <SelectItem value="status">By Status</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  <TableHead className="text-right hidden sm:table-cell">Stock</TableHead>
                  <TableHead className="text-right hidden sm:table-cell">Minimum</TableHead>
                  <TableHead className="text-right hidden md:table-cell">Est. Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recommendations.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                      No products match the selected filters
                    </TableCell>
                  </TableRow>
                ) : (
                  recommendations.map((rec) => {
                    const statusConfig = STATUS_CONFIG[rec.status];
                    const isBelowMinimum = rec.minimum && rec.currentStock < rec.minimum;
                    return (
                      <TableRow key={rec.productId}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            {/* Mobile: status dot indicator */}
                            <StatusDot status={rec.status} className="sm:hidden" />
                            <span className="truncate max-w-[200px]">{rec.productName}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge variant={statusConfig.variant} className="gap-1">
                            {statusConfig.icon}
                            <span className="hidden sm:inline">{statusConfig.label}</span>
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right hidden sm:table-cell">
                          <span
                            className={cn(
                              isBelowMinimum && "text-negative font-medium"
                            )}
                          >
                            {rec.currentStock}
                          </span>
                        </TableCell>
                        <TableCell className="text-right hidden sm:table-cell">
                          {rec.minimum ? (
                            rec.minimum
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right hidden md:table-cell">
                          {rec.estimatedOrderValue > 0 ? (
                            formatCurrency(rec.estimatedOrderValue)
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          {recommendations.length > 0 && (
            <div className="text-center p-4 text-sm text-muted-foreground">
              Showing {recommendations.length} products
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
