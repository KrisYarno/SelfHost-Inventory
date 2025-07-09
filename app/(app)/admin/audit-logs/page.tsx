"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, FileText, ChevronLeft, ChevronRight, Filter, Download } from "lucide-react";
import { toast } from "sonner";

interface AuditLog {
  id: number;
  userId: number;
  actionType: string;
  entityType: string;
  entityId: number | null;
  batchId: string | null;
  action: string;
  details: any;
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

const actionTypeColors: Record<string, string> = {
  USER_APPROVAL: "bg-green-500",
  USER_REJECTION: "bg-red-500",
  USER_BULK_APPROVAL: "bg-green-600",
  USER_BULK_REJECTION: "bg-red-600",
  PRODUCT_CREATE: "bg-blue-500",
  PRODUCT_UPDATE: "bg-yellow-500",
  PRODUCT_DELETE: "bg-red-500",
  INVENTORY_ADJUSTMENT: "bg-purple-500",
  INVENTORY_BULK_UPDATE: "bg-purple-600",
  DATA_EXPORT: "bg-gray-500",
};

export default function AuditLogsPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [searchTerm, setSearchTerm] = useState("");
  const [actionTypeFilter, setActionTypeFilter] = useState<string>("all");
  const [entityTypeFilter, setEntityTypeFilter] = useState<string>("all");
  const [userIdFilter, setUserIdFilter] = useState<string>("");

  useEffect(() => {
    if (status === "loading") return;
    if (!session?.user?.isAdmin) {
      router.push("/unauthorized");
      return;
    }
    fetchAuditLogs();
  }, [session, status, router, page, actionTypeFilter, entityTypeFilter, userIdFilter]);

  const fetchAuditLogs = async () => {
    try {
      setIsLoading(true);
      const params = new URLSearchParams({
        limit: pageSize.toString(),
        offset: ((page - 1) * pageSize).toString(),
      });

      if (actionTypeFilter && actionTypeFilter !== "all") params.append("actionType", actionTypeFilter);
      if (entityTypeFilter && entityTypeFilter !== "all") params.append("entityType", entityTypeFilter);
      if (userIdFilter) params.append("userId", userIdFilter);

      const response = await fetch(`/api/admin/audit-logs?${params}`);
      if (!response.ok) throw new Error("Failed to fetch audit logs");

      const data = await response.json();
      setLogs(data.logs);
      setTotal(data.total);
    } catch (error) {
      console.error("Error fetching audit logs:", error);
      toast.error("Failed to load audit logs");
    } finally {
      setIsLoading(false);
    }
  };

  const handleExport = async () => {
    try {
      const params = new URLSearchParams({
        limit: "1000",
        offset: "0",
      });

      if (actionTypeFilter && actionTypeFilter !== "all") params.append("actionType", actionTypeFilter);
      if (entityTypeFilter && entityTypeFilter !== "all") params.append("entityType", entityTypeFilter);
      if (userIdFilter) params.append("userId", userIdFilter);

      const response = await fetch(`/api/admin/audit-logs?${params}`);
      if (!response.ok) throw new Error("Failed to export audit logs");

      const data = await response.json();
      
      // Convert to CSV
      const csv = [
        ["Timestamp", "User", "Action Type", "Entity Type", "Action", "Affected Count", "IP Address"],
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
        .map((row) => row.map((cell: string) => `"${cell}"`).join(","))
        .join("\n");

      // Download CSV
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

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Audit Logs</h1>
          <p className="text-muted-foreground">
            Track all administrative actions and changes
          </p>
        </div>
        <Button onClick={handleExport} variant="outline">
          <Download className="mr-2 h-4 w-4" />
          Export
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filter Logs</CardTitle>
          <CardDescription>
            Search and filter audit logs by various criteria
          </CardDescription>
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
          <CardDescription>
            Showing {logs.length} of {total} total entries
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[600px]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Action Type</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead>Count</TableHead>
                  <TableHead>Details</TableHead>
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
                      <TableCell className="font-mono text-sm">
                        {format(new Date(log.createdAt), "yyyy-MM-dd HH:mm:ss")}
                      </TableCell>
                      <TableCell>
                        <div>
                          <div className="font-medium">{log.user.username}</div>
                          <div className="text-sm text-muted-foreground">
                            {log.user.email}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={actionTypeColors[log.actionType] || "bg-gray-500"}
                        >
                          {log.actionType.replace(/_/g, " ")}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-xs truncate">
                        {log.action}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          <div>{log.entityType}</div>
                          {log.entityId && (
                            <div className="text-muted-foreground">
                              ID: {log.entityId}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {log.affectedCount > 1 && (
                          <Badge variant="secondary">{log.affectedCount}</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {log.batchId && (
                          <Badge variant="outline" className="text-xs">
                            Batch
                          </Badge>
                        )}
                        {log.ipAddress && (
                          <div className="text-xs text-muted-foreground">
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