// Top-level directive
"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { format } from "date-fns";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { Download, Filter, Search, ChevronLeft, ChevronRight, Shield } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn, formatNumber } from "@/lib/utils";
import { useDebounce } from "@/hooks/use-debounce";
import { usePaginatedLogs } from "@/hooks/use-paginated-logs";
import { toast } from "sonner";
import { getAuditTone, getInventoryLogTone } from "@/components/logs/log-style";
import { StatusBadge } from "@/components/ui/status-badge";
import { TransferLogTable } from "@/components/inventory/transfer-log-table";

type TabKey = "change" | "audit" | "transfers";
export default function AdminLogsHubPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTab = (searchParams?.get("tab") as TabKey) || "change";
  const [tab, setTab] = useState<TabKey>(initialTab);

  useEffect(() => {
    router.replace(`/admin/logs?tab=${tab}`);
  }, [tab, router]);

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6 overflow-x-hidden">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold">Logs</h1>
        <p className="text-muted-foreground">
          Review inventory changes, transfers, and admin activity from one place.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList className="flex flex-wrap gap-2">
          <TabsTrigger value="change">Change Logs</TabsTrigger>
          <TabsTrigger value="audit">Audit Logs</TabsTrigger>
          <TabsTrigger value="transfers">Transfers</TabsTrigger>
        </TabsList>

        <TabsContent value="change" className="space-y-6">
          <ChangeLogTab active={tab === "change"} />
        </TabsContent>

        <TabsContent value="audit" className="space-y-6">
          <AuditLogTab active={tab === "audit"} />
        </TabsContent>

        <TabsContent value="transfers" className="space-y-6">
          <TransferLogTab active={tab === "transfers"} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ----------------------
// Change Logs (inventory ledger)
// ----------------------

interface InventoryLog {
  id: number;
  timestamp: string;
  productName: string;
  userName: string;
  locationName: string;
  delta: number;
  logType: string;
  notes?: string;
}

interface LogsResponse {
  logs: InventoryLog[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
function ChangeLogTab({ active }: { active: boolean }) {
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [searchTerm, setSearchTerm] = useState("");
  const [userFilter, setUserFilter] = useState("all");
  const [locationFilter, setLocationFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);
  const [filters, setFilters] = useState<{
    users: Array<{ id: number; email: string }>;
    locations?: Array<string>;
  } | null>(null);

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

  const fetchFilters = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/logs/filters");
      if (!response.ok) throw new Error("Failed to fetch filters");
      const result = await response.json();
      setFilters(result);
    } catch (error) {
      console.error("Error fetching filters:", error);
    }
  }, []);

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

  useEffect(() => {
    if (active) {
      fetchFilters();
    }
  }, [fetchFilters, active]);

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
                    <SelectItem key={location} value={location}>
                      {location}
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
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-4">Timestamp</th>
                  <th className="text-left p-4">Product</th>
                  <th className="text-left p-4">User</th>
                  <th className="text-left p-4">Location</th>
                  <th className="text-left p-4">Type</th>
                  <th className="text-right p-4">Change</th>
                </tr>
              </thead>
              <tbody>
                {data?.logs.map((log) => (
                  <tr key={log.id} className="border-t hover:bg-muted/30">
                    <td className="p-4 text-sm">
                      {format(new Date(log.timestamp), "MMM d, yyyy HH:mm:ss")}
                    </td>
                    <td className="p-4 font-medium">{log.productName}</td>
                    <td className="p-4">{log.userName}</td>
                    <td className="p-4">
                      <Badge variant="secondary">{log.locationName}</Badge>
                    </td>
                    <td className="p-4">
                      {(() => {
                        const tone = getInventoryLogTone(log.logType, log.delta);
                        return (
                          <Badge className={tone.className} variant="secondary">
                            {tone.label}
                          </Badge>
                        );
                      })()}
                    </td>
                    <td
                      className={cn(
                        "p-4 text-right font-mono font-medium",
                        log.delta > 0 ? "text-positive" : "text-negative"
                      )}
                    >
                      {log.delta > 0 ? "+" : ""}
                      {formatNumber(log.delta)}
                    </td>
                  </tr>
                ))}
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
    </div>
  );
}
// ----------------------
// Audit Logs
// ----------------------

type AuditFilterState = {
  actionType: string;
  entityType: string;
  userId: string;
};

interface AuditLog {
  id: number;
  userId: number;
  actionType: string;
  entityType: string;
  entityId: number | null;
  batchId: string | null;
  action: string;
  details: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  affectedCount: number;
  createdAt: string;
  user: {
    id: number;
    username: string;
    email: string;
  };
}

interface AuditLogsResponse {
  logs: AuditLog[];
  total: number;
}

function AuditLogTab({ active }: { active: boolean }) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [actionTypeFilter, setActionTypeFilter] = useState<string>("all");
  const [entityTypeFilter, setEntityTypeFilter] = useState<string>("all");
  const [userIdFilter, setUserIdFilter] = useState<string>("");

  const filters = useMemo<AuditFilterState>(
    () => ({
      actionType: actionTypeFilter,
      entityType: entityTypeFilter,
      userId: userIdFilter,
    }),
    [actionTypeFilter, entityTypeFilter, userIdFilter]
  );

  const buildQuery = useCallback((page: number, pageSize: number, f: AuditFilterState) => {
    const params = new URLSearchParams({
      limit: pageSize.toString(),
      offset: ((page - 1) * pageSize).toString(),
    });

    if (f.actionType && f.actionType !== "all") {
      params.append("actionType", f.actionType);
    }
    if (f.entityType && f.entityType !== "all") {
      params.append("entityType", f.entityType);
    }
    if (f.userId) {
      params.append("userId", f.userId);
    }

    return params;
  }, []);

  const { data, isLoading, isRefreshing, error, refresh } = usePaginatedLogs<
    AuditFilterState,
    AuditLogsResponse
  >({
    endpoint: "/api/admin/audit-logs",
    page,
    pageSize,
    filters,
    enabled: active && status === "authenticated" && !!session?.user?.isAdmin,
    buildQuery,
  });

  const logs = data?.logs ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);

  useEffect(() => {
    if (status === "loading") return;
    if (status === "authenticated" && !session?.user?.isAdmin) {
      router.push("/unauthorized");
      return;
    }
  }, [session, status, router]);

  useEffect(() => {
    if (error) {
      console.error("Error fetching audit logs:", error);
      toast.error(error);
    }
  }, [error]);

  const handleExport = async () => {
    try {
      const params = new URLSearchParams({
        limit: "1000",
        offset: "0",
      });

      if (actionTypeFilter && actionTypeFilter !== "all")
        params.append("actionType", actionTypeFilter);
      if (entityTypeFilter && entityTypeFilter !== "all")
        params.append("entityType", entityTypeFilter);
      if (userIdFilter) params.append("userId", userIdFilter);

      const response = await fetch(`/api/admin/audit-logs?${params}`);
      if (!response.ok) throw new Error("Failed to export audit logs");

      const data = await response.json();

      const csv = [
        [
          "Timestamp",
          "User",
          "Action Type",
          "Entity Type",
          "Action",
          "Affected Count",
          "IP Address",
        ],
        ...data.logs.map((log: AuditLog) => [
          format(new Date(log.createdAt), "yyyy-MM-dd HH:mm:ss"),
          log.user.email,
          log.actionType,
          log.entityType,
          log.action,
          log.affectedCount.toString(),
          log.ipAddress || "N/A",
        ]),
      ]
        .map((row: string[]) => row.map((cell) => `"${cell}"`).join(","))
        .join("\n");

      const blob = new Blob([csv], { type: "text/csv" });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-logs-${format(new Date(), "yyyy-MM-dd")}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);

      toast.success("Audit logs exported successfully");
    } catch (error) {
      console.error("Error exporting audit logs:", error);
      toast.error("Failed to export audit logs");
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Audit Logs</h2>
          <p className="text-muted-foreground text-sm">
            Administrative actions and high-level events.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={refresh} variant="outline" size="sm" disabled={isRefreshing}>
            {isRefreshing ? (
              <>
                <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Refreshing...
              </>
            ) : (
              "Refresh"
            )}
          </Button>
          <Button onClick={handleExport} variant="outline" size="sm">
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filter Logs</CardTitle>
          <p className="text-sm text-muted-foreground">Narrow by action, entity type, or user.</p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-4">
            <Select value={actionTypeFilter} onValueChange={setActionTypeFilter}>
              <SelectTrigger>
                <SelectValue placeholder="All action types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All action types</SelectItem>
                <SelectItem value="USER_APPROVAL">User Approval</SelectItem>
                <SelectItem value="USER_REJECTION">User Rejection</SelectItem>
                <SelectItem value="USER_BULK_APPROVAL">Bulk Approval</SelectItem>
                <SelectItem value="USER_BULK_REJECTION">Bulk Rejection</SelectItem>
                <SelectItem value="PRODUCT_CREATE">Product Create</SelectItem>
                <SelectItem value="PRODUCT_UPDATE">Product Update</SelectItem>
                <SelectItem value="PRODUCT_DELETE">Product Delete</SelectItem>
                <SelectItem value="INVENTORY_ADJUSTMENT">Inventory Adjustment</SelectItem>
                <SelectItem value="INVENTORY_BULK_UPDATE">Bulk Inventory Update</SelectItem>
              </SelectContent>
            </Select>

            <Select value={entityTypeFilter} onValueChange={setEntityTypeFilter}>
              <SelectTrigger>
                <SelectValue placeholder="All entity types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All entity types</SelectItem>
                <SelectItem value="USER">User</SelectItem>
                <SelectItem value="PRODUCT">Product</SelectItem>
                <SelectItem value="INVENTORY">Inventory</SelectItem>
                <SelectItem value="SYSTEM">System</SelectItem>
              </SelectContent>
            </Select>

            <Input
              placeholder="User ID"
              value={userIdFilter}
              onChange={(e) => setUserIdFilter(e.target.value)}
              type="number"
            />

            <Button
              variant="outline"
              onClick={() => {
                setActionTypeFilter("all");
                setEntityTypeFilter("all");
                setUserIdFilter("");
                setPage(1);
              }}
            >
              Clear Filters
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Audit Log Entries</CardTitle>
          <p className="text-sm text-muted-foreground">
            Showing {logs.length} of {total} total entries
          </p>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[600px]">
            <Table className="min-w-[720px] sm:min-w-0">
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">Timestamp</TableHead>
                  <TableHead className="whitespace-nowrap">User</TableHead>
                  <TableHead className="whitespace-nowrap">Action Type</TableHead>
                  <TableHead className="whitespace-nowrap">Action</TableHead>
                  <TableHead className="whitespace-nowrap">Entity</TableHead>
                  <TableHead className="whitespace-nowrap text-right">Count</TableHead>
                  <TableHead className="whitespace-nowrap">Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={7}>
                        <Skeleton className="h-12 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : logs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center">
                      No audit logs found
                    </TableCell>
                  </TableRow>
                ) : (
                  logs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="font-mono text-sm whitespace-nowrap">
                        {format(new Date(log.createdAt), "yyyy-MM-dd HH:mm:ss")}
                      </TableCell>
                      <TableCell className="min-w-[160px]">
                        <div className="min-w-0">
                          <div className="font-medium truncate max-w-[50vw] sm:max-w-none">
                            {log.user.username}
                          </div>
                          <div className="text-sm text-muted-foreground truncate max-w-[60vw] sm:max-w-none">
                            {log.user.email}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {(() => {
                          const tone = getAuditTone(log.actionType);
                          return (
                            <Badge className={tone.className} variant="secondary">
                              {tone.label}
                            </Badge>
                          );
                        })()}
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate">{log.action}</TableCell>
                      <TableCell>
                        <div className="text-sm">
                          <div>{log.entityType}</div>
                          {log.entityId && (
                            <div className="text-muted-foreground">ID: {log.entityId}</div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {log.affectedCount > 1 && (
                          <Badge variant="secondary">x{log.affectedCount}</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {log.batchId && (
                          <Badge variant="outline" className="text-xs flex items-center gap-1">
                            <Shield className="h-3 w-3" />
                            Batch
                          </Badge>
                        )}
                        {log.ipAddress && (
                          <div className="text-xs text-muted-foreground truncate max-w-[40vw] sm:max-w-none">
                            {log.ipAddress}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </ScrollArea>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <div className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page === 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(Math.min(totalPages, page + 1))}
                  disabled={page === totalPages}
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
// ----------------------
// Transfers (read-only log)
// ----------------------

interface TransferLogRow {
  id: number;
  createdAt: string | Date;
  productName: string;
  quantity: number | null;
  fromLocationName: string;
  toLocationName: string;
  userName: string;
  batchId?: string | null;
}

function TransferLogTab({ active }: { active: boolean }) {
  const [logs, setLogs] = useState<TransferLogRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTransfers = useCallback(async () => {
    if (!active) return;
    try {
      setIsLoading(true);
      setError(null);
      const res = await fetch("/api/inventory/transfers?pageSize=50");
      if (!res.ok) throw new Error("Failed to load transfer history");
      const data = await res.json();
      setLogs(data.transfers ?? []);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load transfer history";
      setError(message);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }, [active]);

  useEffect(() => {
    loadTransfers();
  }, [loadTransfers]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Transfers</h2>
          <p className="text-muted-foreground text-sm">
            From/to location moves, separate from other adjustments.
          </p>
        </div>
        <Button onClick={loadTransfers} variant="outline" size="sm" disabled={isLoading}>
          {isLoading ? (
            <>
              <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Refreshing...
            </>
          ) : (
            "Refresh"
          )}
        </Button>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>Transfers</CardTitle>
          <StatusBadge tone="info" className="bg-muted text-foreground border-border/70">
            Latest {logs.length}
          </StatusBadge>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : logs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No transfer activity recorded yet.</p>
          ) : (
            <TransferLogTable logs={logs} />
          )}

          {error && <p className="text-sm text-destructive mt-3">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
