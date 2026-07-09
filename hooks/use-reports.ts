"use client";

import { useInfiniteQuery, useQuery, type InfiniteData } from "@tanstack/react-query";
import type { DateRange } from "react-day-picker";
import type {
  ActivityChartData,
  ActivityItem,
  DashboardMetrics,
  LowStockAlert,
  ProductMovementSummary,
  ReorderRecommendation,
  ReorderSummary,
  StockLevelChartData,
  UserActivitySummary,
} from "@/types/reports";
import type { CombinedMinBreach } from "@/types/inventory";

/**
 * Canonical query-key scheme for every reports endpoint:
 *
 *   ["reports", <report>, { ...filters }]
 *
 * Whatever scopes a report (date range, location — company is reserved for the
 * analytics hub, reports do not scope by it) lives inside the filter object, so
 * a range/location change produces a new key and refetches naturally while a
 * previously-viewed scope returns instantly from cache. Filters are reduced to
 * primitives (ISO strings, ids) so structural hashing is stable regardless of
 * Date object identity.
 */
export const reportsKey = (report: string, filters: Record<string, unknown> = {}) =>
  ["reports", report, filters] as const;

/** Range + location scope shared by the page-level metric and chart endpoints. */
export interface ReportScope {
  dateRange?: DateRange;
  locationId?: number | null;
}

/** startDate/endDate/locationId query params shared by scoped endpoints. */
function scopeParams(scope: ReportScope): URLSearchParams {
  const params = new URLSearchParams();
  if (scope.dateRange?.from) params.set("startDate", scope.dateRange.from.toISOString());
  if (scope.dateRange?.to) params.set("endDate", scope.dateRange.to.toISOString());
  if (scope.locationId) params.set("locationId", String(scope.locationId));
  return params;
}

/** Primitive slice of the scope used inside query keys (Date -> ISO string). */
function scopeKey(scope: ReportScope) {
  return {
    from: scope.dateRange?.from?.toISOString() ?? null,
    to: scope.dateRange?.to?.toISOString() ?? null,
    locationId: scope.locationId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Page-level scoped endpoints (metrics + the two overview charts)
// ---------------------------------------------------------------------------

interface MetricsResult {
  metrics: DashboardMetrics;
}

export function useReportsMetrics(scope: ReportScope) {
  return useQuery({
    queryKey: reportsKey("metrics", scopeKey(scope)),
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/reports/metrics?${scopeParams(scope)}`, { signal });
      if (!res.ok) throw new Error("Failed to fetch metrics");
      return (await res.json()) as MetricsResult;
    },
  });
}

export function useReportsInventoryTrends(scope: ReportScope) {
  return useQuery({
    queryKey: reportsKey("inventory-trends", scopeKey(scope)),
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/reports/inventory-trends?${scopeParams(scope)}`, { signal });
      if (!res.ok) throw new Error("Failed to fetch inventory trends");
      const data = await res.json();
      return (data.data ?? []) as StockLevelChartData[];
    },
  });
}

export function useReportsDailyActivity(scope: ReportScope) {
  return useQuery({
    queryKey: reportsKey("daily-activity", scopeKey(scope)),
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/reports/daily-activity?${scopeParams(scope)}`, { signal });
      if (!res.ok) throw new Error("Failed to fetch daily activity");
      const data = await res.json();
      return (data.data ?? []) as ActivityChartData[];
    },
  });
}

// ---------------------------------------------------------------------------
// Card-level endpoints
// ---------------------------------------------------------------------------

export function useReportsActivity(pageSize = 10) {
  return useQuery({
    queryKey: reportsKey("activity", { pageSize }),
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/reports/activity?pageSize=${pageSize}`, { signal });
      if (!res.ok) throw new Error("Failed to fetch activities");
      const data = await res.json();
      return (data.activities ?? []) as ActivityItem[];
    },
  });
}

export function useReportsMinimums() {
  return useQuery({
    queryKey: reportsKey("minimums"),
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/reports/minimums", { signal });
      if (!res.ok) throw new Error("Failed to fetch minimum report");
      const data = await res.json();
      return (data.breaches ?? []) as CombinedMinBreach[];
    },
  });
}

export function useReportsLowStock() {
  return useQuery({
    queryKey: reportsKey("low-stock"),
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/reports/low-stock", { signal });
      if (!res.ok) throw new Error("Failed to fetch low stock alerts");
      const data = await res.json();
      return (data.alerts ?? []) as LowStockAlert[];
    },
  });
}

export function useReportsUserActivity() {
  return useQuery({
    queryKey: reportsKey("user-activity"),
    queryFn: async ({ signal }) => {
      // Server applies a 365-day default window; the client sends no params.
      const res = await fetch("/api/reports/user-activity", { signal });
      if (!res.ok) throw new Error("Failed to fetch user activity");
      const data = await res.json();
      return (data.users ?? []) as UserActivitySummary[];
    },
  });
}

// ---------------------------------------------------------------------------
// Reorder recommendations (filter/sort in the key -> natural refetch)
// ---------------------------------------------------------------------------

export interface ReorderFilters {
  sortBy: "alphabetical" | "status";
  statusFilter: string; // "all" | "critical" | "need_order" | "running_low"
}

interface ReorderResult {
  recommendations: ReorderRecommendation[];
  summary: ReorderSummary | null;
}

export function useReportsReorder(filters: ReorderFilters) {
  return useQuery({
    queryKey: reportsKey("reorder-recommendations", { ...filters }),
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        sortBy: filters.sortBy,
        limit: "100",
        ...(filters.statusFilter !== "all" && { statusFilter: filters.statusFilter }),
      });
      const res = await fetch(`/api/reports/reorder-recommendations?${params}`, { signal });
      if (!res.ok) throw new Error("Failed to fetch reorder recommendations");
      return (await res.json()) as ReorderResult;
    },
  });
}

// ---------------------------------------------------------------------------
// Product performance (server-side paginated -> useInfiniteQuery, mirrors
// use-inventory-variants.ts: filter in the key, module-scope select)
// ---------------------------------------------------------------------------

const PRODUCT_PERFORMANCE_PAGE_SIZE = 20;

interface ProductMovementPage {
  products: ProductMovementSummary[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

// Module-scope select: a per-render closure would return fresh arrays every
// render (see use-inventory-variants.ts for the same rationale).
const selectProductMovement = (data: InfiniteData<ProductMovementPage>) => ({
  products: data.pages.flatMap((p) => p.products),
  total: data.pages[data.pages.length - 1]?.pagination.total ?? 0,
});

export function useReportsProductPerformance(locationId?: number | null) {
  return useInfiniteQuery({
    queryKey: reportsKey("product-movement-summary", {
      days: 30,
      sortBy: "activity",
      locationId: locationId ?? null,
    }),
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams({
        days: "30",
        page: String(pageParam),
        pageSize: String(PRODUCT_PERFORMANCE_PAGE_SIZE),
        sortBy: "activity",
        ...(locationId ? { locationId: String(locationId) } : {}),
      });
      const res = await fetch(`/api/reports/product-movement-summary?${params}`, { signal });
      if (!res.ok) throw new Error("Failed to fetch product performance");
      return (await res.json()) as ProductMovementPage;
    },
    initialPageParam: 1,
    getNextPageParam: (last) =>
      last.pagination.page < last.pagination.totalPages ? last.pagination.page + 1 : undefined,
    select: selectProductMovement,
  });
}
