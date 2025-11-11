"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  Download,
  Search,
  Filter,
  ChevronLeft,
  ChevronRight
} from "lucide-react";
import { format } from "date-fns";
import { cn, formatNumber } from "@/lib/utils";
import { useDebounce } from "@/hooks/use-debounce";
import { toast } from "sonner";

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

export default function AdminLogsPage() {
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [searchTerm, setSearchTerm] = useState("");
  const [userFilter, setUserFilter] = useState("all");
  const [locationFilter, setLocationFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);
  const [data, setData] = useState<LogsResponse | null>(null);
  const [filters, setFilters] = useState<{ 
    users: Array<{ id: number; email: string }>;
    locations?: Array<string>;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  
  const debouncedSearch = useDebounce(searchTerm, 300);

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: pageSize.toString(),
      });
      
      if (debouncedSearch) params.append("search", debouncedSearch);
      if (userFilter !== "all") params.append("user", userFilter);
      if (locationFilter !== "all") params.append("location", locationFilter);
      if (typeFilter !== "all") params.append("type", typeFilter);
      if (dateFrom) params.append("dateFrom", dateFrom.toISOString());
      if (dateTo) params.append("dateTo", dateTo.toISOString());
      
      const response = await fetch(`/api/admin/logs?${params}`);
      if (!response.ok) throw new Error("Failed to fetch logs");
      const result = await response.json();
      setData(result);
    } catch (error) {
      console.error('Error fetching logs:', error);
      toast.error('Failed to load logs');
    } finally {
      setIsLoading(false);
    }
  }, [page, pageSize, debouncedSearch, userFilter, locationFilter, typeFilter, dateFrom, dateTo]);

  const fetchFilters = async () => {
    try {
      const response = await fetch("/api/admin/logs/filters");
      if (!response.ok) throw new Error("Failed to fetch filters");
      const result = await response.json();
      setFilters(result);
    } catch (error) {
      console.error('Error fetching filters:', error);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    fetchFilters();
    
    // Auto-refresh every 10 seconds
    const interval = setInterval(fetchLogs, 10000);
    return () => clearInterval(interval);
  }, []);

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
      a.download = `inventory-logs-${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      toast.success('Export completed successfully');
    } catch (error) {
      console.error('Error exporting logs:', error);
      toast.error('Failed to export logs');
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

  if (isLoading) {
    return (
      <div className="container mx-auto p-4 sm:p-6 space-y-6 overflow-x-hidden">
        <h1 className="text-3xl font-bold">Inventory Change Log</h1>
        <Card>
          <CardContent className="p-6">
            <div className="space-y-4">
              {[...Array(10)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6 overflow-x-hidden">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
        <h1 className="text-3xl font-bold">Inventory Change Log</h1>
        <Button onClick={handleExportCSV} variant="outline">
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
      </div>

      {/* Filters */}
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

          <Button 
            variant="ghost" 
            size="sm" 
            onClick={clearFilters}
            className="mt-4"
          >
            Clear Filters
          </Button>
        </CardContent>
      </Card>

      {/* Logs Table */}
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
                      <Badge variant="outline">{log.logType}</Badge>
                    </td>
                    <td className={cn(
                      "p-4 text-right font-mono font-medium",
                      log.delta > 0 ? "text-green-600" : "text-red-600"
                    )}>
                      {log.delta > 0 ? '+' : ''}{formatNumber(log.delta)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between p-4 border-t">
            <p className="text-sm text-muted-foreground">
              Showing {((page - 1) * pageSize) + 1} to {Math.min(page * pageSize, data?.total || 0)} of {data?.total || 0} entries
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
