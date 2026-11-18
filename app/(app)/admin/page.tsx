"use client";

import { useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowRight, Activity } from "lucide-react";
import Link from "next/link";
import { formatNumber } from "@/lib/utils";
import { toast } from "sonner";
import { RateLimitMonitor } from "@/components/admin/rate-limit-monitor";
import { OpsHealthSection } from "@/components/admin/ops-health-section";
import { useAdminDashboard } from "@/hooks/use-admin";

/**
 * Compact, borderless metric strip (D-L1): the demoted 4-KPI grid. With no
 * metrics (the read failed and nothing was loaded) every value is `--` and the
 * counted sub-lines are left out — never a 0 that was not read (F0-4).
 */
function MetricStrip({
  metrics,
}: {
  metrics?: {
    totalProducts?: number;
    activeUsers?: number;
    pendingUsers?: number;
    lowStockProducts?: number;
    outOfStockProducts?: number;
    recentTransactions?: number;
  };
}) {
  const items = metrics
    ? [
        { label: "Total products", value: metrics.totalProducts ?? 0, sub: "Across all locations" },
        { label: "Active users", value: metrics.activeUsers ?? 0, sub: `${metrics.pendingUsers ?? 0} pending approval` },
        { label: "Low stock", value: metrics.lowStockProducts ?? 0, sub: `${metrics.outOfStockProducts ?? 0} out of stock` },
        { label: "Activity (24h)", value: metrics.recentTransactions ?? 0, sub: "Inventory movements" },
      ]
    : [
        { label: "Total products", value: null, sub: "Across all locations" },
        { label: "Active users", value: null, sub: null },
        { label: "Low stock", value: null, sub: null },
        { label: "Activity (24h)", value: null, sub: "Inventory movements" },
      ];
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4 sm:divide-x sm:divide-border">
      {items.map((it) => (
        <div key={it.label} className="sm:pl-6 sm:first:pl-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{it.label}</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">
            {it.value === null ? "--" : formatNumber(it.value)}
          </p>
          {it.sub !== null && <p className="text-xs text-muted-foreground">{it.sub}</p>}
        </div>
      ))}
    </div>
  );
}

/** A list's failed read (F0-4): says so, and offers Retry. */
function ListLoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-destructive">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-4">
      {[...Array(3)].map((_, i) => (
        <Skeleton key={i} className="h-5 w-full" />
      ))}
    </div>
  );
}

export default function AdminDashboardPage() {
  // 30s auto-refresh preserved inside the hook via refetchInterval.
  const { data: metrics, isLoading, isPending, isError, errorUpdatedAt, refetch } = useAdminDashboard();
  // The hook polls, so a failed POLL over loaded data must keep the data: the
  // error copy is only for a read that failed with nothing loaded (F0-4).
  const failed = isError && metrics === undefined;
  // FR1-5: the lists' skeletons key on PENDING, not loading — a paused (offline)
  // read is pending too, and an empty sentence is only for an answer.
  const topMovers = metrics?.topMovingProducts ?? [];
  const recentActivity = metrics?.recentActivity ?? [];

  // Preserve the original toast on each failed (poll) fetch.
  useEffect(() => {
    if (isError) {
      toast.error("Failed to load dashboard data");
    }
  }, [isError, errorUpdatedAt]);

  return (
    <div className="container mx-auto space-y-6 overflow-x-hidden p-[var(--card-padding)]">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
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

      {/* Triage-first: verdict strip + needs-attention + ops workspaces */}
      <OpsHealthSection />

      {/* Demoted KPI strip */}
      {isLoading ? (
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : (
        <MetricStrip metrics={metrics} />
      )}

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
            {isPending ? (
              <ListSkeleton />
            ) : failed ? (
              <ListLoadFailed message="Couldn't load product movement." onRetry={() => refetch()} />
            ) : topMovers.length === 0 ? (
              <p className="text-muted-foreground">No product movement in the last 7 days.</p>
            ) : (
              <div className="space-y-4">
                {topMovers.slice(0, 5).map((product) => (
                  <div key={product.id} className="flex items-center justify-between">
                    <div className="font-medium">{product.name}</div>
                    <div className="text-sm text-muted-foreground">
                      {formatNumber(product.movement)} units
                    </div>
                  </div>
                ))}
              </div>
            )}
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
            {isPending ? (
              <ListSkeleton />
            ) : failed ? (
              <ListLoadFailed message="Couldn't load recent activity." onRetry={() => refetch()} />
            ) : recentActivity.length === 0 ? (
              <p className="text-muted-foreground">No recent activity.</p>
            ) : (
              <div className="space-y-4">
                {recentActivity.slice(0, 5).map((activity) => (
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
                ))}
              </div>
            )}
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
              <Link href="/admin/backup">Database Backups</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
