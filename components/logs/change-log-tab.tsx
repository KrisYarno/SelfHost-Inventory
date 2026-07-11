"use client";

import * as React from "react";
import { useEffect, useMemo, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { ValueChip } from "@/components/ui/value-chip";
import { Download, Filter, Search, ChevronLeft, ChevronRight, Layers } from "lucide-react";
import { cn, formatDelta, formatNumber } from "@/lib/utils";
import { useDebounce } from "@/hooks/use-debounce";
import { usePaginatedLogs } from "@/hooks/use-paginated-logs";
import { toast } from "sonner";
import { getInventoryLogTone } from "@/components/logs/log-style";
import { BatchDrawer } from "@/components/logs/batch-drawer";

interface InventoryLog {
  id: number;
  timestamp: string;
  productName: string;
  userName: string;
  locationName: string;
  delta: number;
  logType: string;
  reasonCode: string | null;
  unitCostCents: number | null;
  batchId: string | null;
  notes?: string;
}

interface LogsResponse {
  logs: InventoryLog[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Frozen receipt cost (Phase C) — $X.XX, em-dash when the row carries none.
function formatCents(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function BatchChip({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="View batch"
      className="inline-flex min-h-[44px] items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <StatusBadge tone="neutral" className="cursor-pointer gap-1">
        <Layers className="h-3 w-3" aria-hidden />
        Batch
      </StatusBadge>
    </button>
  );
}

export function ChangeLogTab({ active }: { active: boolean }) {
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [searchTerm, setSearchTerm] = useState("");
  const [userFilter, setUserFilter] = useState("all");
  const [locationFilter, setLocationFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);
  const [drawerBatchId, setDrawerBatchId] = useState<string | null>(null);

  const { data: filters } = useQuery<{
    users: Array<{ id: number; email: string }>;
    locations?: Array<{ id: number; name: string }>;
  }>({
    queryKey: ["admin-logs-filters"],
    queryFn: async () => {
      const response = await fetch("/api/admin/logs/filters");
      if (!response.ok) throw new Error("Failed to fetch filters");
      return response.json();
    },
    enabled: active,
  });

  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const debouncedSearch = useDebounce(searchTerm, 300);

  const logFilters = useMemo(
    () => ({
      search: debouncedSearch,
      user: userFilter,
      location: locationFilter,
      type: typeFilter,
      dateFrom,
      dateTo,
    }),
    [debouncedSearch, userFilter, locationFilter, typeFilter, dateFrom, dateTo]
  );

  const buildQuery = useCallback((page: number, pageSize: number, filters: typeof logFilters) => {
    const params = new URLSearchParams({
      page: page.toString(),
      pageSize: pageSize.toString(),
    });

    if (filters.search) params.append("search", filters.search);
    if (filters.user !== "all") params.append("user", filters.user);
    if (filters.location !== "all") params.append("location", filters.location);
    if (filters.type !== "all") params.append("type", filters.type);
    if (filters.dateFrom) params.append("dateFrom", filters.dateFrom.toISOString());
    if (filters.dateTo) params.append("dateTo", filters.dateTo.toISOString());

    return params;
  }, []);

  const { data, isLoading, isRefreshing, error, refresh } = usePaginatedLogs<
    typeof logFilters,
    LogsResponse
  >({
    endpoint: "/api/admin/logs",
    page,
    pageSize,
    filters: logFilters,
    enabled: active,
    buildQuery,
  });

  useEffect(() => {
    if (!isLoading && isInitialLoading) {
      setIsInitialLoading(false);
    }
  }, [isLoading, isInitialLoading]);

  useEffect(() => {
    if (error) {
      toast.error(error);
    }
  }, [error]);

  const handleRefresh = async () => {
    await refresh();
  };

  const handleExportCSV = async () => {
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.append("search", debouncedSearch);
      if (userFilter !== "all") params.append("user", userFilter);
      if (locationFilter !== "all") params.append("location", locationFilter);
      if (typeFilter !== "all") params.append("type", typeFilter);
      if (dateFrom) params.append("dateFrom", dateFrom.toISOString());
      if (dateTo) params.append("dateTo", dateTo.toISOString());
      const response = await fetch(`/api/admin/logs/export?${params}`);
      if (!response.ok) throw new Error("Failed to export logs");
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `inventory-logs-${new Date().toISOString().split("T")[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      toast.success("Export completed successfully");
    } catch (error) {
      console.error("Error exporting logs:", error);
      toast.error("Failed to export logs");
    }
  };

  const clearFilters = () => {
    setSearchTerm("");
    setUserFilter("all");
    setLocationFilter("all");
    setTypeFilter("all");
    setDateFrom(undefined);
    setDateTo(undefined);
    setPage(1);
  };

  if (isInitialLoading) {
    return (
      <Card>
        <CardContent className="p-6 space-y-4">
          {[...Array(10)].map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
        <div>
          <h2 className="text-2xl font-semibold">Change Logs</h2>
          <p className="text-muted-foreground text-sm">
            Master ledger of inventory changes (+/-) by product and location.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={handleRefresh} variant="outline" size="sm" disabled={isRefreshing}>
            {isRefreshing ? (
              <>
                <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Refreshing...
              </>
            ) : (
              "Refresh"
            )}
          </Button>
          <Button onClick={handleExportCSV} variant="outline" size="sm">
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Filter className="h-4 w-4" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <div className="space-y-2">
              <Label>Search</Label>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Product name..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-8"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>User</Label>
              <Select value={userFilter} onValueChange={setUserFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Users</SelectItem>
                  {filters?.users?.map((user) => (
                    <SelectItem key={user.id} value={user.id.toString()}>
                      {user.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Location</Label>
              <Select value={locationFilter} onValueChange={setLocationFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Locations</SelectItem>
                  {filters?.locations?.map((location) => (
                    <SelectItem key={location.id} value={location.id.toString()}>
                      {location.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="ADJUSTMENT">Adjustment</SelectItem>
                  <SelectItem value="TRANSFER">Transfer</SelectItem>
                  <SelectItem value="STOCK_IN">Stock In</SelectItem>
                  <SelectItem value="SALE">Sale</SelectItem>
                  <SelectItem value="CORRECTION">Correction</SelectItem>
                  <SelectItem value="COUNT">Count</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>From Date</Label>
              <Input
                type="date"
                value={dateFrom ? format(dateFrom, "yyyy-MM-dd") : ""}
                onChange={(e) => setDateFrom(e.target.value ? new Date(e.target.value) : undefined)}
                className="w-full"
              />
            </div>

            <div className="space-y-2">
              <Label>To Date</Label>
              <Input
                type="date"
                value={dateTo ? format(dateTo, "yyyy-MM-dd") : ""}
                onChange={(e) => setDateTo(e.target.value ? new Date(e.target.value) : undefined)}
                className="w-full"
              />
            </div>
          </div>

          <Button variant="ghost" size="sm" onClick={clearFilters} className="mt-4">
            Clear Filters
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {/* Mobile: chronological list rows (D-L8) */}
          <div className="space-y-2 p-4 md:hidden">
            {data?.logs.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No changes recorded.</p>
            ) : (
              data?.logs.map((log) => {
                const tone = getInventoryLogTone(log.logType, log.delta);
                return (
                  <div key={log.id} className="rounded-lg border border-border bg-surface p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-medium" title={log.productName}>
                        {log.productName}
                      </span>
                      <time className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {format(new Date(log.timestamp), "MMM d, HH:mm")}
                      </time>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <StatusBadge tone={tone.tone}>{tone.label}</StatusBadge>
                      <ValueChip tone={log.delta >= 0 ? "positive" : "negative"}>
                        {formatDelta(log.delta)}
                      </ValueChip>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {log.reasonCode && <span>{log.reasonCode}</span>}
                      {log.unitCostCents != null && (
                        <span className="tabular-nums">{formatCents(log.unitCostCents)}</span>
                      )}
                      {log.batchId && <BatchChip onClick={() => setDrawerBatchId(log.batchId!)} />}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {log.locationName} · {log.userName}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Desktop: table with Phase C handoff columns */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-4">Timestamp</th>
                  <th className="text-left p-4">Product</th>
                  <th className="text-left p-4">User</th>
                  <th className="text-left p-4">Location</th>
                  <th className="text-left p-4">Type</th>
                  <th className="text-left p-4">Reason</th>
                  <th className="text-right p-4">Unit cost</th>
                  <th className="text-right p-4">Change</th>
                  <th className="text-left p-4">Batch</th>
                </tr>
              </thead>
              <tbody>
                {data?.logs.map((log) => {
                  const tone = getInventoryLogTone(log.logType, log.delta);
                  return (
                    <tr key={log.id} className="border-t hover:bg-muted/30">
                      <td className="p-4 text-sm whitespace-nowrap tabular-nums">
                        {format(new Date(log.timestamp), "MMM d, yyyy HH:mm:ss")}
                      </td>
                      <td className="p-4 font-medium">{log.productName}</td>
                      <td className="p-4">{log.userName}</td>
                      <td className="p-4">
                        <Badge variant="secondary">{log.locationName}</Badge>
                      </td>
                      <td className="p-4">
                        <StatusBadge tone={tone.tone}>{tone.label}</StatusBadge>
                      </td>
                      <td className="p-4">
                        {log.reasonCode ? (
                          <StatusBadge tone="neutral">{log.reasonCode}</StatusBadge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="p-4 text-right tabular-nums">{formatCents(log.unitCostCents)}</td>
                      <td
                        className={cn(
                          "p-4 text-right font-mono font-medium tabular-nums",
                          log.delta > 0 ? "text-positive" : "text-negative"
                        )}
                      >
                        {log.delta > 0 ? "+" : ""}
                        {formatNumber(log.delta)}
                      </td>
                      <td className="p-4">
                        {log.batchId && <BatchChip onClick={() => setDrawerBatchId(log.batchId!)} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between p-4 border-t">
            <p className="text-sm text-muted-foreground">
              Showing {(page - 1) * pageSize + 1} to {Math.min(page * pageSize, data?.total || 0)}{" "}
              of {data?.total || 0} entries
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(page - 1)}
                disabled={page === 1}
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </Button>
              <span className="text-sm">
                Page {page} of {data?.totalPages || 1}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(page + 1)}
                disabled={page === (data?.totalPages || 1)}
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <BatchDrawer
        batchId={drawerBatchId}
        onOpenChange={(open) => {
          if (!open) setDrawerBatchId(null);
        }}
      />
    </div>
  );
}
