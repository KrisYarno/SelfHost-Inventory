"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@/contexts/location-context";
import { PageHeader } from "@/components/layout/page-header";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Package,
  Layers,
  AlertTriangle,
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  MapPin,
  Clock,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import type { MetricsResponse, ActivityResponse } from "@/types/reports";
import { Sparkline } from "@/components/ui/sparkline";

// ---------------------------------------------------------------------------
// Data fetching helpers
// ---------------------------------------------------------------------------

async function fetchMetrics(locationId: number | null): Promise<MetricsResponse> {
  const params = new URLSearchParams();
  if (locationId) params.set("locationId", String(locationId));
  const res = await fetch(`/api/reports/metrics?${params}`);
  if (!res.ok) throw new Error("Failed to fetch metrics");
  return res.json();
}

async function fetchLocationStock(
  locations: { id: number; name: string }[]
): Promise<{ id: number; name: string; totalStock: number }[]> {
  // Fetch inventory for each location in parallel
  const results = await Promise.all(
    locations.map(async (loc) => {
      const res = await fetch(`/api/inventory/current-fast?locationId=${loc.id}`);
      if (!res.ok) return { id: loc.id, name: loc.name, totalStock: 0 };
      const data = await res.json();
      const totalStock = (data.inventory || []).reduce(
        (sum: number, item: { quantity: number }) => sum + item.quantity,
        0
      );
      return { id: loc.id, name: loc.name, totalStock };
    })
  );
  return results;
}

interface StockerMinimumItem {
  productId: number;
  productName: string;
  locationId: number;
  locationName: string;
  currentQuantity: number;
  minQuantity: number;
  shortage: number;
}

async function fetchLowStock(
  locationId: number | null
): Promise<{ items: StockerMinimumItem[] }> {
  if (!locationId) return { items: [] };
  const res = await fetch(`/api/stocker/minimums?locationId=${locationId}`);
  if (!res.ok) throw new Error("Failed to fetch low stock");
  return res.json();
}

async function fetchActivity(): Promise<ActivityResponse> {
  const res = await fetch(`/api/reports/activity?pageSize=10`);
  if (!res.ok) throw new Error("Failed to fetch activity");
  return res.json();
}

async function fetchTrendData(
  locationId: number | null
): Promise<{ data: { date: string; quantity: number }[] }> {
  const params = new URLSearchParams();
  if (locationId) params.set("locationId", String(locationId));
  const res = await fetch(`/api/reports/inventory-trends?${params}`);
  if (!res.ok) throw new Error("Failed to fetch trend data");
  return res.json();
}

// ---------------------------------------------------------------------------
// Stat Card
// ---------------------------------------------------------------------------

function StatCard({
  title,
  value,
  icon: Icon,
  accent,
  subtitle,
  loading,
  sparklineData,
}: {
  title: string;
  value: string | number;
  icon: React.ElementType;
  accent?: string;
  subtitle?: string;
  loading?: boolean;
  sparklineData?: number[];
}) {
  return (
    <Card>
      <CardContent className="p-5">
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-3 w-20" />
          </div>
        ) : (
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <p className="text-body-sm text-muted-foreground">{title}</p>
              <div className="flex items-center gap-2">
                <p className="text-2xl font-bold tracking-tight">{value}</p>
                {sparklineData && sparklineData.length >= 2 && (
                  <Sparkline data={sparklineData} width={60} height={20} />
                )}
              </div>
              {subtitle && (
                <p className="text-xs text-muted-foreground">{subtitle}</p>
              )}
            </div>
            <div
              className="rounded-lg p-2.5"
              style={{ backgroundColor: accent ? `${accent}20` : "hsl(35 70% 65% / 0.15)" }}
            >
              <Icon
                className="h-5 w-5"
                style={{ color: accent || "hsl(35, 70%, 65%)" }}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Dashboard Page
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const { locations, selectedLocationId, selectedLocation } = useLocation();

  // --- Metrics ---
  const {
    data: metricsData,
    isLoading: metricsLoading,
  } = useQuery({
    queryKey: ["dashboard-metrics", selectedLocationId],
    queryFn: () => fetchMetrics(selectedLocationId),
  });

  const metrics = metricsData?.metrics;

  // --- Location stock overview ---
  const {
    data: locationStock,
    isLoading: locationStockLoading,
  } = useQuery({
    queryKey: ["dashboard-location-stock", locations.map((l) => l.id).join(",")],
    queryFn: () => fetchLocationStock(locations),
    enabled: locations.length > 0,
  });

  // --- Low stock alerts (per-location, using stocker minimums) ---
  const {
    data: lowStockData,
    isLoading: lowStockLoading,
  } = useQuery({
    queryKey: ["dashboard-low-stock", selectedLocationId],
    queryFn: () => fetchLowStock(selectedLocationId),
    enabled: !!selectedLocationId,
  });

  // --- Trend data (7-day sparkline) ---
  const { data: trendData } = useQuery({
    queryKey: ["dashboard-trends", selectedLocationId],
    queryFn: () => fetchTrendData(selectedLocationId),
  });

  const sparklineValues = trendData?.data?.map((d) => d.quantity) ?? [];

  // --- Recent activity ---
  const {
    data: activityData,
    isLoading: activityLoading,
  } = useQuery({
    queryKey: ["dashboard-activity"],
    queryFn: fetchActivity,
  });

  const lowStockItems = lowStockData?.items ?? [];
  const activities = activityData?.activities ?? [];

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Dashboard"
        description={
          selectedLocation
            ? `Viewing ${selectedLocation.name}`
            : "Inventory overview"
        }
      />

      <main className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto max-w-7xl space-y-6">
          {/* ── Row 1: Stat Cards ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              title="Total Products"
              value={metrics?.totalProducts ?? "--"}
              icon={Package}
              accent="hsl(35, 70%, 65%)"
              loading={metricsLoading}
            />
            <StatCard
              title="Total Stock"
              value={
                metrics?.totalStockQuantity != null
                  ? metrics.totalStockQuantity.toLocaleString()
                  : "--"
              }
              icon={Layers}
              accent="hsl(199, 89%, 48%)"
              subtitle="units across all locations"
              loading={metricsLoading}
              sparklineData={sparklineValues}
            />
            <StatCard
              title="Low Stock Alerts"
              value={metrics?.lowStockProducts ?? "--"}
              icon={AlertTriangle}
              accent={
                metrics && metrics.lowStockProducts > 0
                  ? "hsl(0, 84%, 60%)"
                  : "hsl(142, 71%, 45%)"
              }
              subtitle={
                metrics && metrics.lowStockProducts > 0
                  ? "products below threshold"
                  : "all stocked"
              }
              loading={metricsLoading}
            />
            <StatCard
              title="Recent Activity"
              value={metrics?.recentActivityCount ?? "--"}
              icon={Activity}
              accent="hsl(262, 83%, 58%)"
              subtitle="inventory changes"
              loading={metricsLoading}
            />
          </div>

          {/* ── Row 2: Location Stock + Low Stock Alerts ── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Location Stock Overview */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <MapPin className="h-4 w-4 text-muted-foreground" />
                  Stock by Location
                </CardTitle>
              </CardHeader>
              <CardContent>
                {locationStockLoading ? (
                  <div className="space-y-3">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="flex items-center justify-between">
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="h-4 w-16" />
                      </div>
                    ))}
                  </div>
                ) : locationStock && locationStock.length > 0 ? (
                  <div className="space-y-2">
                    {locationStock.map((loc) => {
                      const isSelected = loc.id === selectedLocationId;
                      return (
                        <div
                          key={loc.id}
                          className={`flex items-center justify-between rounded-lg px-3 py-2.5 transition-colors ${
                            isSelected
                              ? "bg-primary/10 border border-primary/20"
                              : "bg-muted/50"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{loc.name}</span>
                            {isSelected && (
                              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                                selected
                              </Badge>
                            )}
                          </div>
                          <span className="text-sm font-semibold tabular-nums">
                            {loc.totalStock.toLocaleString()}
                            <span className="text-muted-foreground font-normal ml-1">units</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    No locations configured.
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Low Stock Alerts */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                    Low Stock Alerts
                  </CardTitle>
                  {!lowStockLoading && lowStockItems.length > 0 && (
                    <Badge variant="destructive" className="text-xs">
                      {lowStockItems.length}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {lowStockLoading ? (
                  <div className="space-y-3">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="flex items-center justify-between">
                        <Skeleton className="h-4 w-40" />
                        <Skeleton className="h-4 w-20" />
                      </div>
                    ))}
                  </div>
                ) : lowStockItems.length > 0 ? (
                  <div className="space-y-2 max-h-[300px] overflow-y-auto">
                    {lowStockItems.map((item) => {
                      const pct =
                        item.minQuantity > 0
                          ? Math.round((item.currentQuantity / item.minQuantity) * 100)
                          : 0;
                      const isCritical = pct < 25;
                      return (
                        <div
                          key={item.productId}
                          className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2.5"
                        >
                          <div className="min-w-0 flex-1 mr-3">
                            <p className="text-sm font-medium truncate">
                              {item.productName}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {item.currentQuantity} / {item.minQuantity} min
                            </p>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {/* Mini progress bar */}
                            <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${
                                  isCritical ? "bg-destructive" : "bg-warning"
                                }`}
                                style={{ width: `${Math.min(pct, 100)}%` }}
                              />
                            </div>
                            <Badge
                              variant={isCritical ? "destructive" : "warning"}
                              className="text-[10px] min-w-[40px] justify-center"
                            >
                              {pct}%
                            </Badge>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="py-6 text-center">
                    <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-success/10">
                      <Package className="h-5 w-5 text-success" />
                    </div>
                    <p className="text-sm font-medium">All stocked up</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {selectedLocation
                        ? `No items below minimum at ${selectedLocation.name}`
                        : "No low stock items"}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* ── Row 3: Recent Activity Feed ── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Clock className="h-4 w-4 text-muted-foreground" />
                Recent Activity
              </CardTitle>
            </CardHeader>
            <CardContent>
              {activityLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="flex items-center gap-3">
                      <Skeleton className="h-8 w-8 rounded-full" />
                      <div className="flex-1 space-y-1">
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-3 w-1/3" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : activities.length > 0 ? (
                <div className="space-y-1">
                  {activities.map((item) => {
                    const isIn = item.type === "stock_in";
                    const isOut = item.type === "stock_out";
                    return (
                      <div
                        key={item.id}
                        className="flex items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-muted/50 transition-colors"
                      >
                        {/* Icon */}
                        <div
                          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                            isIn
                              ? "bg-success/10 text-success"
                              : isOut
                                ? "bg-destructive/10 text-destructive"
                                : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {isIn ? (
                            <ArrowDownRight className="h-4 w-4" />
                          ) : isOut ? (
                            <ArrowUpRight className="h-4 w-4" />
                          ) : (
                            <Activity className="h-4 w-4" />
                          )}
                        </div>

                        {/* Content */}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm leading-snug">
                            {item.description}
                          </p>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                            <span className="text-xs text-muted-foreground">
                              {formatDistanceToNow(new Date(item.timestamp), {
                                addSuffix: true,
                              })}
                            </span>
                            {item.user && (
                              <span className="text-xs text-muted-foreground">
                                by {item.user.username}
                              </span>
                            )}
                            {item.location && (
                              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                                {item.location.name}
                              </Badge>
                            )}
                          </div>
                        </div>

                        {/* Quantity badge */}
                        {item.metadata?.quantityChange != null &&
                          item.metadata.quantityChange !== 0 && (
                            <Badge
                              variant={
                                item.metadata.quantityChange > 0
                                  ? "success"
                                  : "destructive"
                              }
                              className="text-xs tabular-nums shrink-0"
                            >
                              {item.metadata.quantityChange > 0 ? "+" : ""}
                              {item.metadata.quantityChange}
                            </Badge>
                          )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No recent activity to show.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
