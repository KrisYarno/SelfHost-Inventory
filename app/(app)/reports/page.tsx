"use client";

import { useState, useEffect } from "react";
import { getSession } from "@/lib/auth";
import { MetricsCard } from "@/components/reports/metrics-card";
import { ActivityTimeline } from "@/components/reports/activity-timeline";
import { ProductPerformance } from "@/components/reports/product-performance";
import { UserActivity } from "@/components/reports/user-activity";
import { LowStockAlert } from "@/components/reports/low-stock-alert";
import { LineChartComponent, ActivityBarChart } from "@/components/reports/inventory-chart";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  Download, 
  RefreshCw, 
  Package, 
  TrendingUp, 
  Users, 
  AlertTriangle,
  Activity,
  DollarSign
} from "lucide-react";
import { DashboardMetrics } from "@/types/reports";
import { format } from "date-fns";

export default function ReportsPage() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetchMetrics();
  }, []);

  const fetchMetrics = async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/reports/metrics");
      if (!response.ok) throw new Error("Failed to fetch metrics");
      const data = await response.json();
      setMetrics(data.metrics);
    } catch (error) {
      console.error("Error fetching metrics:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchMetrics();
    // Trigger refresh of child components
    window.location.reload();
    setRefreshing(false);
  };

  const generateMockChartData = () => {
    // Generate mock data for the line chart (last 7 days)
    const lineData = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      lineData.push({
        date: format(date, "MMM d"),
        quantity: Math.floor(Math.random() * 1000) + 500
      });
    }

    // Generate mock data for activity chart
    const activityData = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      activityData.push({
        date: format(date, "MMM d"),
        stockIn: Math.floor(Math.random() * 100) + 20,
        stockOut: Math.floor(Math.random() * 80) + 10,
        adjustments: Math.floor(Math.random() * 20)
      });
    }

    return { lineData, activityData };
  };

  const { lineData, activityData } = generateMockChartData();

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="border-b border-border bg-background px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
            <p className="text-sm text-muted-foreground">
              Analytics and insights for your inventory
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button variant="outline" size="sm">
              <Download className="h-4 w-4 mr-2" />
              Export
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        <div className="p-6 space-y-6 max-w-7xl mx-auto">
          {/* Metrics Cards */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <MetricsCard
              title="Total Products"
              value={metrics?.totalProducts || 0}
              subtitle={`${metrics?.activeProducts || 0} active`}
              icon={<Package className="h-4 w-4" />}
            />
            <MetricsCard
              title="Total Stock"
              value={metrics?.totalStockQuantity.toLocaleString() || 0}
              subtitle="Units in inventory"
              icon={<Package className="h-4 w-4" />}
            />
            <MetricsCard
              title="Inventory Value"
              value={`$${(metrics?.totalInventoryValue || 0).toLocaleString()}`}
              subtitle="Estimated value"
              icon={<DollarSign className="h-4 w-4" />}
            />
            <MetricsCard
              title="Low Stock Items"
              value={metrics?.lowStockProducts || 0}
              subtitle="Below threshold"
              icon={<AlertTriangle className="h-4 w-4" />}
              trend={metrics?.lowStockProducts ? {
                value: 12,
                direction: 'up'
              } : undefined}
            />
          </div>

          {/* Tabs for different report sections */}
          <Tabs defaultValue="overview" className="space-y-4">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="products">Products</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
              <TabsTrigger value="users">Users</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-6">
              {/* Charts Row */}
              <div className="grid gap-6 lg:grid-cols-2">
                <LineChartComponent
                  data={lineData}
                  title="Inventory Trend"
                  description="Total stock levels over the last 7 days"
                />
                <ActivityBarChart
                  data={activityData}
                  title="Daily Activity"
                  description="Stock movements by type"
                />
              </div>

              {/* Activity and Alerts Row */}
              <div className="grid gap-6 lg:grid-cols-2">
                <ActivityTimeline />
                <LowStockAlert />
              </div>
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
    </div>
  );
}