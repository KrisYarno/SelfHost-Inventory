"use client";

import { useState, useRef } from "react";
import { MetricsCard } from "@/components/reports/metrics-card";
import { ActivityTimeline } from "@/components/reports/activity-timeline";
import { ProductPerformance } from "@/components/reports/product-performance";
import { UserActivity } from "@/components/reports/user-activity";
import { LowStockAlert } from "@/components/reports/low-stock-alert";
import { LineChartComponent, ActivityBarChart } from "@/components/reports/inventory-chart";
import { ReorderRecommendations } from "@/components/reports/reorder-recommendations";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Download,
  RefreshCw,
  AlertTriangle,
  DollarSign,
  FileDown,
  Image as ImageIcon,
  ShoppingCart,
  Activity,
  Archive,
  Info,
} from "lucide-react";
import { useLocation } from "@/contexts/location-context";
import {
  useReportsMetrics,
  useReportsInventoryTrends,
  useReportsDailyActivity,
} from "@/hooks/use-reports";
import { DateRangePicker, DateRangePreset } from "@/components/ui/date-range-picker";
import { DateRange } from "react-day-picker";
import { format, startOfDay, endOfDay, subDays } from "date-fns";
import { exportToCSV, exportChartAsImage, generateExportFilename } from "@/lib/export-utils";
import { DrillDownModal } from "@/components/reports/drill-down-modal";
import { CombinedMinimumsReport } from "@/components/reports/combined-minimums";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const formatCurrency = (value?: number) => currencyFormatter.format(value ?? 0);

export default function AdminReportsPage() {
  const [dateRange, setDateRange] = useState<DateRange | undefined>({
    from: startOfDay(subDays(new Date(), 6)),
    to: endOfDay(new Date()),
  });
  const [drillDownModal, setDrillDownModal] = useState<{
    isOpen: boolean;
    type: "product" | "date" | "user" | "location";
    title: string;
    data: any;
  }>({
    isOpen: false,
    type: "product",
    title: "",
    data: null,
  });

  const { selectedLocationId } = useLocation();
  const chartRefs = useRef<{ [key: string]: HTMLDivElement | null }>({});

  // Range + location scope drives all three page-level queries; both live in
  // each query key (["reports", <report>, { range, locationId }]), so changing
  // the date range or location refetches naturally and a previously-viewed
  // scope returns instantly from cache.
  const scope = { dateRange, locationId: selectedLocationId };
  const metricsQuery = useReportsMetrics(scope);
  const inventoryTrendsQuery = useReportsInventoryTrends(scope);
  const dailyActivityQuery = useReportsDailyActivity(scope);

  const metrics = metricsQuery.data?.metrics ?? null;
  const inventoryTrends = inventoryTrendsQuery.data ?? [];
  const dailyActivity = dailyActivityQuery.data ?? [];
  // Preserve prior default: true until metrics load reporting zero recent activity.
  const hasRecentActivity = !metrics || metrics.recentActivityCount > 0;
  // Spinner reflects an explicit refetch of existing data, not the initial load.
  const refreshing =
    metricsQuery.isRefetching ||
    inventoryTrendsQuery.isRefetching ||
    dailyActivityQuery.isRefetching;

  const handleRefresh = () => {
    metricsQuery.refetch();
    inventoryTrendsQuery.refetch();
    dailyActivityQuery.refetch();
  };

  const handleDateRangeChange = (newDateRange: DateRange | undefined, _preset: DateRangePreset) => {
    setDateRange(newDateRange);
  };

  const handleExportMetrics = () => {
    if (!metrics) return;

    const filename = generateExportFilename("metrics", "csv", dateRange);
    const data = [
      // Decision metrics (new)
      {
        metric: "Order Now",
        value: metrics.orderNowCount,
        additional: `${metrics.orderSoonCount} order soon`,
      },
      {
        metric: "Reorder Health Score",
        value: `${metrics.reorderHealthScore}%`,
        additional: "Products in healthy stock position",
      },
      {
        metric: "Monthly Carrying Cost",
        value: formatCurrency(metrics.monthlyCarryingCost),
        additional: "25% annual holding rate",
      },
      {
        metric: "Dead Stock Value",
        value: formatCurrency(metrics.deadStockValue),
        additional: "No movement in 90 days",
      },
      {
        metric: "Stockout Risk",
        value: metrics.stockoutRiskCount,
        additional: `Avg ${metrics.daysOfSupplyAvg} days supply`,
      },
      // Legacy metrics
      {
        metric: "Total Products",
        value: metrics.totalProducts,
        additional: `${metrics.activeProducts} active`,
      },
      {
        metric: "Total Stock",
        value: metrics.totalStockQuantity,
        additional: "Units in inventory",
      },
      {
        metric: "Inventory Cost Value",
        value: formatCurrency(metrics.totalInventoryCostValue),
        additional: "At cost",
      },
      {
        metric: "Inventory Retail Value",
        value: formatCurrency(metrics.totalInventoryRetailValue),
        additional: "At retail",
      },
      { metric: "Low Stock Items", value: metrics.lowStockProducts, additional: "Below threshold" },
    ];
    exportToCSV(data, [
      { key: "metric", label: "Metric" },
      { key: "value", label: "Value" },
      { key: "additional", label: "Details" },
    ], filename);
  };

  const handleExportChart = async (chartId: string, chartName: string) => {
    const chartElement = chartRefs.current[chartId];
    if (!chartElement) return;
    const filename = generateExportFilename(chartName, "png", dateRange);
    await exportChartAsImage(chartElement, filename);
  };

  const handleDrillDown = async (
    type: "product" | "date" | "user" | "location",
    identifier: string,
    title: string
  ) => {
    try {
      let data = null;
      const params = new URLSearchParams();
      if (dateRange?.from) params.append("startDate", dateRange.from.toISOString());
      if (dateRange?.to) params.append("endDate", dateRange.to.toISOString());
      switch (type) {
        case "product": {
          const r = await fetch(`/api/reports/product-details/${identifier}?${params}`);
          data = await r.json();
          break;
        }
        case "date": {
          params.append("date", identifier);
          const r = await fetch(`/api/reports/date-details?${params}`);
          data = await r.json();
          break;
        }
        case "user": {
          const r = await fetch(`/api/reports/user-details/${identifier}?${params}`);
          data = await r.json();
          break;
        }
        case "location": {
          const r = await fetch(`/api/reports/location-details/${identifier}?${params}`);
          data = await r.json();
          break;
        }
      }
      setDrillDownModal({ isOpen: true, type, title, data });
    } catch (error) {
      console.error("Error fetching drill-down data:", error);
    }
  };

  const closeDrillDownModal = () => setDrillDownModal((prev) => ({ ...prev, isOpen: false }));

  return (
    <div className="flex flex-col h-full overflow-x-hidden">
      <header className="border-b border-border bg-background px-4 sm:px-6 py-4">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
              <p className="text-sm text-muted-foreground">
                Analytics and insights for your inventory
              </p>
            </div>
            <div className="flex items-center gap-2 self-start sm:self-auto">
              <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
                <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Download className="h-4 w-4 mr-2" />
                    Export
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Export Options</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleExportMetrics}>
                    <FileDown className="h-4 w-4 mr-2" />
                    Export Metrics (CSV)
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => handleExportChart("inventory-trend", "inventory-trend")}
                  >
                    <ImageIcon className="h-4 w-4 mr-2" aria-hidden="true" />
                    Export Inventory Trend (PNG)
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => handleExportChart("daily-activity", "daily-activity")}
                  >
                    <ImageIcon className="h-4 w-4 mr-2" aria-hidden="true" />
                    Export Daily Activity (PNG)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4 min-w-0">
            <DateRangePicker date={dateRange} onDateChange={handleDateRangeChange} />
            <div className="text-sm text-muted-foreground hidden sm:block truncate min-w-0">
              {dateRange?.from && dateRange?.to && (
                <span>
                  Showing data from {format(dateRange.from, "MMM dd, yyyy")} to{" "}
                  {format(dateRange.to, "MMM dd, yyyy")}
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="p-4 sm:p-6 space-y-6 max-w-7xl w-full mx-auto">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <MetricsCard
              title="Order Now"
              value={metrics?.orderNowCount || 0}
              subtitle={`${metrics?.orderSoonCount || 0} order soon`}
              icon={<ShoppingCart className="h-4 w-4" />}
              className={
                metrics?.orderNowCount && metrics.orderNowCount > 0
                  ? "border-red-500 bg-red-50 dark:bg-red-950/20"
                  : ""
              }
            />
            <MetricsCard
              title="Health Score"
              value={`${metrics?.reorderHealthScore || 0}%`}
              subtitle="products in healthy stock"
              icon={<Activity className="h-4 w-4" />}
              className={
                metrics?.reorderHealthScore !== undefined
                  ? metrics.reorderHealthScore >= 80
                    ? "border-green-500 bg-green-50 dark:bg-green-950/20"
                    : metrics.reorderHealthScore >= 50
                      ? "border-yellow-500 bg-yellow-50 dark:bg-yellow-950/20"
                      : "border-red-500 bg-red-50 dark:bg-red-950/20"
                  : ""
              }
            />
            <MetricsCard
              title="Monthly Carrying Cost"
              value={formatCurrency(metrics?.monthlyCarryingCost)}
              subtitle={`${formatCurrency(metrics?.totalInventoryCostValue)} total value`}
              icon={<DollarSign className="h-4 w-4" />}
              unconfigured={!metrics?.totalInventoryCostValue || metrics.totalInventoryCostValue === 0}
              unconfiguredMessage="Set product costs to enable this metric"
            />
            <MetricsCard
              title="Dead Stock Value"
              value={formatCurrency(metrics?.deadStockValue)}
              subtitle={
                metrics?.totalInventoryCostValue && metrics.totalInventoryCostValue > 0
                  ? `${Math.round(((metrics.deadStockValue || 0) / metrics.totalInventoryCostValue) * 100)}% of inventory`
                  : "No movement in 90 days"
              }
              icon={<Archive className="h-4 w-4" />}
              className={
                metrics?.deadStockValue && metrics.deadStockValue > 0
                  ? "border-orange-500 bg-orange-50 dark:bg-orange-950/20"
                  : ""
              }
              unconfigured={(!metrics?.deadStockValue || metrics.deadStockValue === 0) && (!metrics?.totalInventoryCostValue || metrics.totalInventoryCostValue === 0)}
              unconfiguredMessage="Set product costs to enable this metric"
            />
            <MetricsCard
              title="Stockout Risk"
              value={metrics?.stockoutRiskCount || 0}
              subtitle={`Avg ${metrics?.daysOfSupplyAvg || 0} days of supply (outflow-based — includes transfers and corrections) · trend tracks the low-stock count`}
              icon={<AlertTriangle className="h-4 w-4" />}
              trend={metrics?.lowStockTrend}
            />
          </div>
          {!hasRecentActivity && metrics && (
            <div className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30 px-4 py-3 text-sm text-blue-800 dark:text-blue-300">
              <Info className="h-4 w-4 shrink-0" />
              <span>
                No inventory activity was recorded in the selected date range. Cost and value
                metrics reflect current stock levels, but movement-based metrics (trends,
                activity charts) will appear empty.
              </span>
            </div>
          )}
          <CombinedMinimumsReport />

          <Tabs defaultValue="overview" className="space-y-4">
            <TabsList className="w-full overflow-x-auto whitespace-nowrap">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="reorder">Reorder</TabsTrigger>
              <TabsTrigger value="products">Products</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
              <TabsTrigger value="users">Users</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-6">
              <div className="grid gap-6 lg:grid-cols-2">
                <div
                  ref={(el) => {
                    chartRefs.current["inventory-trend"] = el;
                  }}
                >
                  <LineChartComponent
                    data={inventoryTrends}
                    title="Inventory Trend"
                    description={`Total stock levels (${dateRange?.from && dateRange?.to ? `${format(dateRange.from, "MMM dd")} - ${format(dateRange.to, "MMM dd")}` : ""})`}
                    onClick={(data) => {
                      const dateMatch = data.date.match(/(\w+)\s(\d+)/);
                      if (dateMatch && dateRange?.from) {
                        const targetDate = new Date(dateRange.from);
                        targetDate.setDate(parseInt(dateMatch[2]));
                        handleDrillDown(
                          "date",
                          targetDate.toISOString().split("T")[0],
                          `Details for ${data.date}`
                        );
                      }
                    }}
                  />
                </div>
                <div
                  ref={(el) => {
                    chartRefs.current["daily-activity"] = el;
                  }}
                >
                  <ActivityBarChart
                    data={dailyActivity}
                    title="Daily Activity"
                    description="Stock movements by type"
                    onClick={(data) => {
                      const dateMatch = data.date.match(/(\w+)\s(\d+)/);
                      if (dateMatch && dateRange?.from) {
                        const targetDate = new Date(dateRange.from);
                        targetDate.setDate(parseInt(dateMatch[2]));
                        handleDrillDown(
                          "date",
                          targetDate.toISOString().split("T")[0],
                          `Activity on ${data.date}`
                        );
                      }
                    }}
                  />
                </div>
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                <ActivityTimeline />
                <LowStockAlert />
              </div>
            </TabsContent>

            <TabsContent value="reorder" className="space-y-6">
              <ReorderRecommendations />
            </TabsContent>

            <TabsContent value="products" className="space-y-6">
              <ProductPerformance />
            </TabsContent>

            <TabsContent value="activity" className="space-y-6">
              <div className="grid gap-6 lg:grid-cols-3">
                <div className="lg:col-span-2">
                  <ActivityTimeline />
                </div>
                <div>
                  <LowStockAlert />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="users" className="space-y-6">
              <UserActivity />
            </TabsContent>
          </Tabs>
        </div>
      </main>

      <DrillDownModal
        isOpen={drillDownModal.isOpen}
        onClose={closeDrillDownModal}
        title={drillDownModal.title}
        type={drillDownModal.type}
        data={drillDownModal.data}
      />
    </div>
  );
}
