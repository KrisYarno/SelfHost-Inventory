"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import type { User } from "@/components/admin/user-table";

// ---------------------------------------------------------------------------
// Shared TanStack Query hooks for the /admin surface.
//
// Query-key convention mirrors the repo idiom (see use-inventory-*.ts): a
// stable string prefix + an object of filters so related keys invalidate by
// prefix. Everything under the ["admin", ...] namespace so a resource can be
// invalidated wholesale (e.g. ["admin","users"] covers both the paginated
// list and the pending-approvals list).
//
// Reads -> useQuery. Server-state mutations -> useMutation with precise
// invalidation of only the touched key. Mutations stay pure (no toasts): the
// calling component owns UI feedback, matching use-inventory-mutations.ts.
// ---------------------------------------------------------------------------

export interface ApiError extends Error {
  status?: number;
}

/** GET helper for queries: throws Error & { status } so callers can branch on 401. */
async function getJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const err = new Error(`Request failed (${res.status})`) as ApiError;
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

/**
 * Mutation helper: sends JSON (only sets Content-Type when a body is present,
 * matching the existing callers) and surfaces the server's { error } message
 * so the component's catch can toast it verbatim.
 */
async function mutateJSON<T = unknown>(
  url: string,
  method: string,
  body: unknown | undefined,
  csrfToken: string | null,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: withCSRFHeaders(
      body !== undefined ? { "Content-Type": "application/json" } : {},
      csrfToken,
    ),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({} as { error?: string }));
    const err = new Error(data.error || `Request failed (${res.status})`) as ApiError;
    err.status = res.status;
    throw err;
  }
  return res.json().catch(() => ({})) as Promise<T>;
}

// ===========================================================================
// Dashboard  (app/(app)/admin/page.tsx)
// ===========================================================================

export interface DashboardMetrics {
  totalProducts: number;
  totalUsers: number;
  activeUsers: number;
  pendingUsers: number;
  lowStockProducts: number;
  outOfStockProducts: number;
  recentTransactions: number;
  topMovingProducts: Array<{ id: number; name: string; movement: number }>;
  recentActivity: Array<{
    id: number;
    user: string;
    action: string;
    product: string;
    quantity: number;
    timestamp: string;
  }>;
}

/** Admin dashboard metrics. 30s auto-refresh preserved via refetchInterval. */
export function useAdminDashboard() {
  return useQuery<DashboardMetrics>({
    queryKey: ["admin", "dashboard"],
    queryFn: ({ signal }) => getJSON<DashboardMetrics>("/api/admin/dashboard", { signal }),
    refetchInterval: 30_000,
  });
}

// ===========================================================================
// Ops health  (app/(app)/admin/page.tsx — triage-first Overview, D-L1)
//
// Response contract lives HERE (not in the route module) so BOTH the server
// route and the client hook/components share one source without a client bundle
// ever importing a route handler. The route imports these type-only.
// ===========================================================================

/** Per-subsystem envelope: a failing subsystem degrades, never 500s the route. */
export type Sub<T> = { status: "ok"; data: T } | { status: "unavailable"; errorCode: string };

export interface IntegrationHealth {
  id: string;
  name: string;
  platform: string;
  companyName: string;
  isActive: boolean;
  lastSyncAt: string | null;
  lastSyncError: { at: string | null; message: string; errorCount: number } | null;
  lastStockSyncError: string | null;
  syncLockedAt: string | null;
  lockStale: boolean;
  webhookFailureCount: number;
  lastWebhookReceivedAt: string | null;
}

export interface BackupsHealth {
  newest: { name: string; mtimeMs: number; ageHours: number } | null;
  count: number;
  volume: "ok" | "unavailable";
}

export interface PendingReviewsHealth {
  pendingUsers: number;
  pendingProducts: number;
  stagingReceived: number;
}

export interface RebuildJobHealth {
  job: string;
  enabled: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  lockHeld: boolean;
  lockStale: boolean;
  sidecarSeenAt: string | null;
}

export interface RebuildRunRow {
  id: number;
  job: string;
  mode: string;
  source: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  windowFrom: string | null;
  windowTo: string | null;
  rowsDeleted: number;
  rowsInserted: number;
  unattributed: number;
  flaggedPairs: number;
  skippedReason: string | null;
  error: string | null;
}

export interface RebuildHealth {
  jobs: RebuildJobHealth[];
  runs: RebuildRunRow[];
  sidecarSeenAt: string | null;
  heartbeatStale: boolean;
}

export interface AttentionItem {
  severity: "warning" | "negative";
  system: string;
  message: string;
  href: string;
}

export interface OpsHealthResponse {
  verdict: "ok" | "degraded" | "failing";
  attention: AttentionItem[];
  integrations: Sub<IntegrationHealth[]>;
  backups: Sub<BackupsHealth>;
  pendingReviews: Sub<PendingReviewsHealth>;
  rebuild: Sub<RebuildHealth>;
}

/** Ops-health aggregate. 60s poll (slower than the 30s dashboard route). */
export function useOpsHealth() {
  return useQuery<OpsHealthResponse>({
    queryKey: ["admin", "ops-health"],
    queryFn: ({ signal }) => getJSON<OpsHealthResponse>("/api/admin/ops-health", { signal }),
    refetchInterval: 60_000,
  });
}

export interface TriggerRebuildInput {
  job: "snapshots" | "sales";
  mode: "nightly" | "full";
}

/**
 * Manual rebuild trigger (admin). The server inserts a RUNNING row at lock
 * acquire, so on success we invalidate ops-health to surface it immediately.
 */
export function useTriggerRebuild() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: ({ job, mode }: TriggerRebuildInput) =>
      mutateJSON<{ success: boolean; job: string; mode: string; skipped: boolean }>(
        "/api/admin/analytics-rebuild",
        "POST",
        { job, mode },
        csrfToken,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "ops-health"] }),
  });
}

// ===========================================================================
// Users  (app/(app)/admin/users/page.tsx + edit-user-dialog.tsx)
// ===========================================================================

export interface UsersResponse {
  users: User[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface UserListFilters {
  filter: "all" | "approved" | "pending";
  search: string;
  page: number;
}

/** Pending-approval cards. Independent of the table's filter/search/page. */
export function useAdminPendingUsers() {
  return useQuery<UsersResponse, ApiError>({
    queryKey: ["admin", "users", "pending"],
    queryFn: ({ signal }) =>
      getJSON<UsersResponse>("/api/admin/users?filter=pending&limit=100", { signal }),
  });
}

/**
 * Paginated / filtered user table (with edit-dialog details). No placeholderData
 * on purpose: the original showed the table's loading skeleton on every
 * filter/search/page change, so isLoading must map onto that same conditional.
 */
export function useAdminUsers({ filter, search, page }: UserListFilters) {
  return useQuery<UsersResponse, ApiError>({
    queryKey: ["admin", "users", "list", { filter, search, page }],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        filter,
        page: page.toString(),
        limit: "10",
        include: "details",
      });
      if (search) params.append("search", search);
      return getJSON<UsersResponse>(`/api/admin/users?${params}`, { signal });
    },
  });
}

export function useApproveUser() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: (userId: number) =>
      mutateJSON(`/api/admin/users/${userId}/approve`, "POST", undefined, csrfToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}

export function useRejectUser() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: ({ userId, reason }: { userId: number; reason?: string }) =>
      mutateJSON(`/api/admin/users/${userId}/reject`, "DELETE", { reason }, csrfToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}

export function useDeleteUser() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: (userId: number) =>
      mutateJSON(`/api/admin/users/${userId}`, "DELETE", undefined, csrfToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}

export function useBulkApproveUsers() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: (userIds: number[]) =>
      mutateJSON<{ approved: number }>(
        "/api/admin/users/bulk-approve",
        "POST",
        { userIds },
        csrfToken,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}

export function useBulkRejectUsers() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: (userIds: number[]) =>
      mutateJSON<{ rejected: number }>(
        "/api/admin/users/bulk-reject",
        "POST",
        { userIds },
        csrfToken,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}

export function useBulkDeleteUsers() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: (userIds: number[]) =>
      mutateJSON<{ deleted: number }>(
        "/api/admin/users/bulk-delete",
        "POST",
        { userIds },
        csrfToken,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}

export interface UpdateUserInput {
  id: number;
  data: {
    username: string;
    defaultLocationId: number;
    isAdmin: boolean;
    emailAlerts: boolean;
    minLocationEmailAlerts: boolean;
    minCombinedEmailAlerts: boolean;
    companies: Array<{ companyId: string }>;
  };
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: ({ id, data }: UpdateUserInput) =>
      mutateJSON(`/api/admin/users/${id}`, "PATCH", data, csrfToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}

// ===========================================================================
// Companies  (app/(app)/admin/companies/page.tsx + edit-user-dialog options)
// ===========================================================================

export interface AdminCompany {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  _count?: {
    users: number;
    integrations: number;
  };
}

/** Shared company list — consumed by the companies page AND the user edit dialog. */
export function useAdminCompanies() {
  return useQuery<AdminCompany[], ApiError>({
    queryKey: ["admin", "companies"],
    queryFn: async ({ signal }) => {
      const data = await getJSON<{ companies?: AdminCompany[] }>("/api/admin/companies", { signal });
      return data.companies ?? [];
    },
  });
}

export function useCreateCompany() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: (formData: { name: string; slug: string }) =>
      mutateJSON("/api/admin/companies", "POST", formData, csrfToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "companies"] }),
  });
}

export function useUpdateCompany() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: ({ id, formData }: { id: string; formData: { name: string; slug: string } }) =>
      mutateJSON(`/api/admin/companies/${id}`, "PUT", formData, csrfToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "companies"] }),
  });
}

export function useDeleteCompany() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: (id: string) =>
      mutateJSON(`/api/admin/companies/${id}`, "DELETE", undefined, csrfToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "companies"] }),
  });
}

// ===========================================================================
// Location options  (/api/locations — used by the user edit dialog)
// ===========================================================================

export interface LocationOption {
  id: number;
  name: string;
}

/** /api/locations returns a bare array; tolerate { locations } too. */
export function useLocationOptions() {
  return useQuery<LocationOption[]>({
    queryKey: ["admin", "location-options"],
    queryFn: async ({ signal }) => {
      const data = await getJSON<LocationOption[] | { locations?: LocationOption[] }>(
        "/api/locations",
        { signal },
      );
      if (Array.isArray(data)) return data;
      return data.locations ?? [];
    },
  });
}

// ===========================================================================
// System settings  (app/(app)/admin/settings/page.tsx)
// ===========================================================================

export interface SettingsLocation {
  id: number;
  name: string;
  _count?: {
    product_locations: number;
    inventory_logs: number;
  };
}

export interface SystemSettings {
  locations: SettingsLocation[];
  weeklyReportsEnabled: boolean;
  analyticsRebuildEnabled: boolean;
  /** System-wide default low-stock threshold products inherit when NULL (R-L13). */
  lowStockDefaultThreshold: number;
}

export function useAdminSettings() {
  return useQuery<SystemSettings>({
    queryKey: ["admin", "settings"],
    queryFn: ({ signal }) => getJSON<SystemSettings>("/api/admin/settings", { signal }),
  });
}

export function useAddLocation() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: (name: string) =>
      mutateJSON("/api/admin/locations", "POST", { name }, csrfToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "settings"] }),
  });
}

export function useDeleteSettingsLocation() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: (locationId: number) =>
      mutateJSON(`/api/admin/locations/${locationId}`, "DELETE", undefined, csrfToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "settings"] }),
  });
}

/**
 * Toggle a settings flag. Patches the cached settings on success so the switch
 * flips immediately (mirrors the old setData(...) after a successful POST),
 * instead of waiting on a refetch.
 */
export function useToggleSetting(field: "weeklyReportsEnabled" | "analyticsRebuildEnabled") {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      mutateJSON("/api/admin/settings", "POST", { [field]: enabled }, csrfToken),
    onSuccess: (_data, enabled) => {
      queryClient.setQueryData<SystemSettings>(["admin", "settings"], (prev) =>
        prev ? { ...prev, [field]: enabled } : prev,
      );
    },
  });
}

// ===========================================================================
// Product minimum thresholds  (app/(app)/admin/settings/thresholds/page.tsx)
// ===========================================================================

export interface ThresholdLocationMeta {
  id: number;
  name: string;
}

export interface ThresholdMinimumLocation {
  locationId: number;
  locationName: string;
  quantity: number;
  minQuantity: number;
}

export interface ProductMinimum {
  id: number;
  name: string;
  // RAW nullable low-stock alert threshold (R-L13 tri-state): null = inherit the
  // system default, 0 = alerts off, >0 = explicit override.
  combinedMinimum: number | null;
  totalStock: number;
  perLocation: ThresholdMinimumLocation[];
}

export interface ThresholdsData {
  products: ProductMinimum[];
  locations: ThresholdLocationMeta[];
  /** System default inheritors resolve to; shown inline + editable at the top (D-L9). */
  lowStockDefault: number;
}

export interface ThresholdUpdate {
  productId: number;
  // null clears the override (inherit), 0 disables, >0 is explicit (R-L13).
  combinedMinimum?: number | null;
  perLocation?: Array<{ locationId: number; minQuantity: number }>;
}

export function useThresholds() {
  return useQuery<ThresholdsData>({
    queryKey: ["admin", "thresholds"],
    queryFn: ({ signal }) =>
      getJSON<ThresholdsData>("/api/admin/products/thresholds", { signal }),
  });
}

export function useSaveThresholds() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: (updates: ThresholdUpdate[]) =>
      mutateJSON("/api/admin/products/thresholds", "PATCH", { updates }, csrfToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "thresholds"] }),
  });
}

/**
 * Save the system-wide default low-stock threshold (D-L9 matrix header input).
 * Persisted via the settings POST (records a SETTINGS_UPDATE diff); invalidates
 * both the thresholds matrix and the settings card, plus the client-cached
 * default hook so every low-stock surface picks up the new value.
 */
export function useSaveLowStockDefault() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: (lowStockDefaultThreshold: number) =>
      mutateJSON(
        "/api/admin/settings",
        "POST",
        { lowStockDefaultThreshold },
        csrfToken,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "thresholds"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "settings"] });
      queryClient.invalidateQueries({ queryKey: ["settings", "low-stock-default"] });
    },
  });
}

// ===========================================================================
// Database backups  (app/(app)/admin/backup/page.tsx)
// ===========================================================================

export interface ListedBackupFile {
  name: string;
  mtimeMs: number;
}

export function useBackups() {
  return useQuery<ListedBackupFile[]>({
    queryKey: ["admin", "backups"],
    queryFn: async ({ signal }) => {
      const data = await getJSON<{ files?: ListedBackupFile[] }>("/api/admin/backup?list=1", {
        cache: "no-store",
        signal,
      });
      return data.files ?? [];
    },
  });
}

/**
 * Create a backup. The POST streams the .sql file back for download (a one-shot
 * side effect kept inside the mutation, NOT cached) and then invalidates the
 * backup list so the new file appears.
 */
export function useCreateBackup() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/backup", {
        method: "POST",
        headers: withCSRFHeaders({}, csrfToken),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(data.error || "Backup failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.sql`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "backups"] }),
  });
}

// ===========================================================================
// Rate-limit monitor  (components/admin/rate-limit-monitor.tsx)
// ===========================================================================

export interface RateLimitData {
  endpoint: string;
  current: number;
  entries: number;
  resetTime: string;
}

/** 5s poll preserved via refetchInterval. */
export function useRateLimits() {
  return useQuery<RateLimitData[]>({
    queryKey: ["admin", "rate-limits"],
    queryFn: ({ signal }) => getJSON<RateLimitData[]>("/api/admin/rate-limits", { signal }),
    refetchInterval: 5_000,
  });
}
