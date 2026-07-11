"use client";

import * as React from "react";
import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Download, ChevronLeft, ChevronRight, ChevronDown, Layers } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { usePaginatedLogs } from "@/hooks/use-paginated-logs";
import { toast } from "sonner";
import { StatusBadge } from "@/components/ui/status-badge";
import { actionMeta, ACTION_GROUPS } from "@/lib/change-tracking/taxonomy";
import { extractChanges } from "@/lib/change-tracking/extract-changes";
import { ChangeDiffList } from "@/components/history/change-diff-list";
import { ActorChip } from "@/components/history/actor-chip";
import { BatchDrawer } from "@/components/logs/batch-drawer";

type AuditFilterState = {
  actionGroup: string;
  entityType: string;
  userId: string;
};

interface AuditLog {
  id: number;
  // Nullable for machine-actor rows (change-tracking foundation): AuditLog.userId
  // is now nullable and `user` is absent for SYSTEM/WEBHOOK/LLM actors — rendered "System".
  userId: number | null;
  actorKind: string;
  actionType: string;
  entityType: string;
  entityId: string | null;
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
  } | null;
}

interface AuditLogsResponse {
  logs: AuditLog[];
  total: number;
}

// Entity-type options (validated server-side against the union; garbage -> 400).
const ENTITY_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "USER", label: "User" },
  { value: "PRODUCT", label: "Product" },
  { value: "INVENTORY", label: "Inventory" },
  { value: "ORDER", label: "Order" },
  { value: "COMPANY", label: "Company" },
  { value: "INTEGRATION", label: "Integration" },
  { value: "STAGING", label: "Pre-staging" },
  { value: "SETTINGS", label: "Settings" },
  { value: "SYSTEM", label: "System" },
];

// ---------------------------------------------------------------------------
// Batch chip
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Desktop row (table) — expandable detail carries ip/userAgent (D-L5 demote)
// ---------------------------------------------------------------------------

function DesktopAuditRow({
  log,
  onBatchClick,
}: {
  log: AuditLog;
  onBatchClick: (batchId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const meta = actionMeta(log.actionType);
  const changes = extractChanges(log.details);
  const hasDetail = !!(log.ipAddress || log.userAgent);

  return (
    <>
      <TableRow>
        <TableCell className="w-8 align-top">
          {hasDetail && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label="Toggle request details"
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronDown
                aria-hidden
                className={cn(
                  "h-4 w-4 transition-transform duration-150 motion-reduce:transition-none",
                  expanded && "rotate-180"
                )}
              />
            </button>
          )}
        </TableCell>
        <TableCell className="whitespace-nowrap align-top font-mono text-sm tabular-nums">
          {format(new Date(log.createdAt), "yyyy-MM-dd HH:mm:ss")}
        </TableCell>
        <TableCell className="align-top">
          <ActorChip actorKind={log.actorKind} actorName={log.user?.username ?? null} />
        </TableCell>
        <TableCell className="min-w-[220px] align-top">
          <div className="space-y-1">
            <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
            {changes ? (
              <ChangeDiffList changes={changes} entityHint={meta.group} />
            ) : (
              <p className="text-sm text-muted-foreground">{log.action}</p>
            )}
          </div>
        </TableCell>
        <TableCell className="align-top text-sm">
          <div>{log.entityType}</div>
          {log.entityId && <div className="text-muted-foreground">ID: {log.entityId}</div>}
        </TableCell>
        <TableCell className="align-top text-right">
          {log.affectedCount > 1 && (
            <span className="text-xs text-muted-foreground tabular-nums">x{log.affectedCount}</span>
          )}
        </TableCell>
        <TableCell className="align-top">
          {log.batchId && <BatchChip onClick={() => onBatchClick(log.batchId!)} />}
        </TableCell>
      </TableRow>
      {expanded && hasDetail && (
        <TableRow>
          <TableCell colSpan={7} className="bg-surface">
            <dl className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
              {log.ipAddress && (
                <div>
                  <dt className="inline font-medium">IP address: </dt>
                  <dd className="inline">{log.ipAddress}</dd>
                </div>
              )}
              {log.userAgent && (
                <div className="break-all sm:col-span-2">
                  <dt className="inline font-medium">User agent: </dt>
                  <dd className="inline">{log.userAgent}</dd>
                </div>
              )}
            </dl>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Mobile row (list) — D-L8: chronological list rows replace the 720px table
// ---------------------------------------------------------------------------

function MobileAuditRow({
  log,
  onBatchClick,
}: {
  log: AuditLog;
  onBatchClick: (batchId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const meta = actionMeta(log.actionType);
  const changes = extractChanges(log.details);
  const hasDetail = !!(log.ipAddress || log.userAgent);

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
        <time
          dateTime={log.createdAt}
          title={log.createdAt}
          className="shrink-0 text-xs text-muted-foreground tabular-nums"
        >
          {format(new Date(log.createdAt), "MMM d, HH:mm")}
        </time>
      </div>

      {changes ? (
        <div className="mt-2">
          <ChangeDiffList changes={changes} entityHint={meta.group} />
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">{log.action}</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <ActorChip actorKind={log.actorKind} actorName={log.user?.username ?? null} />
        <span aria-hidden>·</span>
        <span>
          {log.entityType}
          {log.entityId ? ` #${log.entityId}` : ""}
        </span>
        {log.batchId && <BatchChip onClick={() => onBatchClick(log.batchId!)} />}
      </div>

      {hasDetail && (
        <>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="mt-2 inline-flex min-h-[44px] items-center gap-1 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Details
            <ChevronDown
              aria-hidden
              className={cn(
                "h-4 w-4 transition-transform duration-150 motion-reduce:transition-none",
                expanded && "rotate-180"
              )}
            />
          </button>
          {expanded && (
            <dl className="mt-1 space-y-1 text-xs text-muted-foreground">
              {log.ipAddress && (
                <div>
                  <dt className="inline font-medium">IP address: </dt>
                  <dd className="inline">{log.ipAddress}</dd>
                </div>
              )}
              {log.userAgent && (
                <div className="break-all">
                  <dt className="inline font-medium">User agent: </dt>
                  <dd className="inline">{log.userAgent}</dd>
                </div>
              )}
            </dl>
          )}
        </>
      )}
    </div>
  );
}

export function AuditLogTab({ active }: { active: boolean }) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [actionGroupFilter, setActionGroupFilter] = useState<string>("all");
  const [entityTypeFilter, setEntityTypeFilter] = useState<string>("all");
  const [userIdFilter, setUserIdFilter] = useState<string>("");
  const [drawerBatchId, setDrawerBatchId] = useState<string | null>(null);

  const filters = useMemo<AuditFilterState>(
    () => ({
      actionGroup: actionGroupFilter,
      entityType: entityTypeFilter,
      userId: userIdFilter,
    }),
    [actionGroupFilter, entityTypeFilter, userIdFilter]
  );

  const buildQuery = useCallback((page: number, pageSize: number, f: AuditFilterState) => {
    const params = new URLSearchParams({
      limit: pageSize.toString(),
      offset: ((page - 1) * pageSize).toString(),
    });

    if (f.actionGroup && f.actionGroup !== "all") {
      params.append("actionGroup", f.actionGroup);
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

  // Server-side CSV (R-L8): replaces the client "fetch limit=1000 then build CSV"
  // path that 400s in prod today. The export route records DATA_EXPORT and streams
  // the full filtered result (batchId + stringified changes included).
  const handleExport = async () => {
    try {
      const params = new URLSearchParams();
      if (actionGroupFilter !== "all") params.append("actionGroup", actionGroupFilter);
      if (entityTypeFilter !== "all") params.append("entityType", entityTypeFilter);
      if (userIdFilter) params.append("userId", userIdFilter);

      const response = await fetch(`/api/admin/audit-logs/export?${params}`);
      if (!response.ok) throw new Error("Failed to export audit logs");

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-logs-${format(new Date(), "yyyy-MM-dd")}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

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
          <p className="text-sm text-muted-foreground">Narrow by action group, entity type, or user.</p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-4">
            <Select value={actionGroupFilter} onValueChange={setActionGroupFilter}>
              <SelectTrigger>
                <SelectValue placeholder="All actions" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All actions</SelectItem>
                {ACTION_GROUPS.map((g) => (
                  <SelectItem key={g.key} value={g.key}>
                    {g.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={entityTypeFilter} onValueChange={setEntityTypeFilter}>
              <SelectTrigger>
                <SelectValue placeholder="All entity types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All entity types</SelectItem>
                {ENTITY_TYPE_OPTIONS.map((e) => (
                  <SelectItem key={e.value} value={e.value}>
                    {e.label}
                  </SelectItem>
                ))}
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
                setActionGroupFilter("all");
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
          {/* Mobile: chronological list rows (D-L8) */}
          <div className="space-y-2 md:hidden">
            {isLoading ? (
              [...Array(5)].map((_, i) => <Skeleton key={i} className="h-24 w-full" />)
            ) : logs.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No audit logs found</p>
            ) : (
              logs.map((log) => (
                <MobileAuditRow key={log.id} log={log} onBatchClick={setDrawerBatchId} />
              ))
            )}
          </div>

          {/* Desktop: expandable table */}
          <div className="hidden md:block">
            <ScrollArea className="h-[600px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead className="whitespace-nowrap">Timestamp</TableHead>
                    <TableHead className="whitespace-nowrap">Actor</TableHead>
                    <TableHead className="whitespace-nowrap">Action</TableHead>
                    <TableHead className="whitespace-nowrap">Entity</TableHead>
                    <TableHead className="whitespace-nowrap text-right">Count</TableHead>
                    <TableHead className="whitespace-nowrap">Batch</TableHead>
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
                      <DesktopAuditRow key={log.id} log={log} onBatchClick={setDrawerBatchId} />
                    ))
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          </div>

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

      <BatchDrawer
        batchId={drawerBatchId}
        onOpenChange={(open) => {
          if (!open) setDrawerBatchId(null);
        }}
      />
    </div>
  );
}
