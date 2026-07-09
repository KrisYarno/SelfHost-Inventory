"use client";

import { useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Package, Users, AlertTriangle, ArrowRight, Activity, TrendingUp } from "lucide-react";
import Link from "next/link";
import { formatNumber } from "@/lib/utils";
import { toast } from "sonner";
import { RateLimitMonitor } from "@/components/admin/rate-limit-monitor";
import { useAdminDashboard } from "@/hooks/use-admin";

export default function AdminDashboardPage() {
  // 30s auto-refresh preserved inside the hook via refetchInterval.
  const { data: metrics, isLoading, isError, errorUpdatedAt } = useAdminDashboard();

  // Preserve the original toast on each failed (poll) fetch.
  useEffect(() => {
    if (isError) {
      toast.error("Failed to load dashboard data");
    }
  }, [isError, errorUpdatedAt]);

  if (isLoading) {
    return (
      <div className="container mx-auto p-6 space-y-6">
        <h1 className="text-3xl font-bold">Admin Dashboard</h1>
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <Skeleton className="h-4 w-[100px]" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-[60px]" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-[var(--card-padding)] space-y-6 overflow-x-hidden">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
        <h1 className="text-3xl font-bold">Admin Dashboard</h1>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/admin/logs">
              <Activity className="mr-2 h-4 w-4" />
              Change Logs
            </Link>
          </Button>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Products</CardTitle>
            <Package className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{metrics?.totalProducts || 0}</div>
            <p className="text-xs text-muted-foreground">Across all locations</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{metrics?.activeUsers || 0}</div>
            <p className="text-xs text-muted-foreground">
              {metrics?.pendingUsers || 0} pending approval
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Low Stock Alert</CardTitle>
            <AlertTriangle className="h-4 w-4 text-warning" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{metrics?.lowStockProducts || 0}</div>
            <p className="text-xs text-muted-foreground">
              {metrics?.outOfStockProducts || 0} out of stock
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Recent Activity</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{metrics?.recentTransactions || 0}</div>
            <p className="text-xs text-muted-foreground">Last 24 hours</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Top Moving Products */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              Top Moving Products
              <Button asChild variant="ghost" size="sm">
                <Link href="/products">
                  View All
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {metrics?.topMovingProducts?.slice(0, 5).map((product) => (
                <div key={product.id} className="flex items-center justify-between">
                  <div className="font-medium">{product.name}</div>
                  <div className="text-sm text-muted-foreground">
                    {formatNumber(product.movement)} units
                  </div>
                </div>
              )) || <p className="text-muted-foreground">No product movement data</p>}
            </div>
          </CardContent>
        </Card>

        {/* Recent Activity */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              Recent Activity
              <Button asChild variant="ghost" size="sm">
                <Link href="/admin/logs">
                  View All
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {metrics?.recentActivity?.slice(0, 5).map((activity) => (
                <div key={activity.id} className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{activity.user}</p>
                    <p className="text-xs text-muted-foreground">
                      {activity.action} {activity.product}
                    </p>
                  </div>
                  <div className="text-right">
                    <p
                      className={`text-sm font-medium ${
                        activity.quantity > 0 ? "text-positive" : "text-negative"
                      }`}
                    >
                      {activity.quantity > 0 ? "+" : ""}
                      {activity.quantity}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(activity.timestamp).toLocaleTimeString()}
                    </p>
                  </div>
                </div>
              )) || <p className="text-muted-foreground">No recent activity</p>}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Rate Limit Monitor */}
      <RateLimitMonitor />

      {/* Quick Links */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
            <Button asChild variant="outline" className="w-full">
              <Link href="/admin/users">Manage Users</Link>
            </Button>
            <Button asChild variant="outline" className="w-full">
              <Link href="/admin/inventory/mass-update">Mass Inventory Update</Link>
            </Button>
            <Button asChild variant="outline" className="w-full">
              <Link href="/admin/settings">System Settings</Link>
            </Button>
            <Button asChild variant="outline" className="w-full">
              <Link href="/admin/logs">View Logs</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
