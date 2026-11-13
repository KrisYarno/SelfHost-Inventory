"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import { getJSON, type ApiError } from "@/hooks/get-json";
import { invalidateInventoryCaches } from "@/hooks/use-inventory-mutations";
import type { User } from "@/components/admin/user-table";
// Reconciliation Part 2 (seam S-B18): the move dialog OWNS the 200 body's shape,
// because it is the one surface that renders it. TYPE-ONLY — nothing of the
// component reaches this module at runtime.
import type { MoveResponse } from "@/components/workbench/move-batch-dialog";
import type {
  AttributionClassKey,
  AttributionReport,
  BatchDetail,
} from "@/lib/reconciliation/attribution";
import type { ExceptionsPage } from "@/lib/reconciliation/exceptions";
import type { UnmappedPage } from "@/lib/reconciliation/unmapped";
import type { ExceptionKind, ExceptionSeverity } from "@/lib/exceptions/kinds";
import {
  MOVE_UNANSWERED_SENTENCE,
  isMoveRefusal,
  moveAbortSignal,
  moveUnanswered,
  type MoveUnanswered,
} from "@/lib/reconciliation/move-timeout";

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

// The read transport (`ApiError`, `getJSON`) and the order search live in their
// own leaf modules since reconciliation Part 2 B3-1b — the adjust dialog's
// order number field reads through them without importing this module.
// Re-exported here so every existing importer compiles unchanged.
export type { ApiError };
export { useOrderSearch } from "@/hooks/use-order-search";
export type { OrderSearchResult, OrderSearchResponse } from "@/hooks/use-order-search";

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
  /**
   * Receiving/Labeling overhaul (spec §11, PK2-12): live work on the NEW flow —
   * supply-order lines that are ORDERED, VERIFIED or LABELING. A queue somebody
   * is meant to be working.
   */
  stagingOpenNewFlow: number;
  /**
   * The RENAMED legacy counter (was `stagingReceived`): pre-staging rows still
   * sitting at `RECEIVED` after the cutover. Not a queue — a straggler, settled
   * through the receiving cutover runbook. Reported BESIDE the new-flow count,
   * never summed with it: they mean different things and are fixed differently.
   */
  stagingResidualReceived: number;
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
  /**
   * The sidecar's own ENABLE_ANALYTICS_REBUILD flag, as reported in its most
   * recent heartbeat (P5). null for pre-P5 / malformed heartbeats; the two-flag
   * mismatch attention items fire only when this is a boolean from a FRESH
   * heartbeat.
   */
  envEnabled?: boolean | null;
}

export interface AttentionItem {
  severity: "warning" | "negative";
  system: string;
  message: string;
  href: string;
}

/**
 * Lane 6: the effective platform-write posture, for the ops dashboard tile and
 * the emergency-stop control. Read from the SAME source as the egress gate, so
 * the tile can never disagree with what a write actually does.
 */
export interface PlatformWritesHealth {
  effective: "off" | "dry-run" | "on";
  capabilities: string[];
  killSwitchEngaged: boolean;
  invalidEnv: boolean;
  invalidReasons: string[];
  label: string;
}

/**
 * Reconciliation lane (spec REV-7 D11, plan P-10): a WORKLOAD figure for the
 * ops-health workload area — open exception rows, and deductions in the last
 * fortnight that named an order and did not match one. Deliberately spelled
 * STRUCTURALLY here rather than imported from `lib/reconciliation/overview.ts`:
 * this module is client-side, and importing the producer would drag Prisma into
 * the bundle. The route's `satisfies OpsHealthResponse` is what keeps the two
 * in step.
 *
 * It NEVER contributes an attention row — see the route.
 */
export interface ReconciliationHealth {
  openExceptions: number;
  unmatchedIntended14d: number;
  asOf: string;
}

export interface OpsHealthResponse {
  verdict: "ok" | "degraded" | "failing";
  attention: AttentionItem[];
  integrations: Sub<IntegrationHealth[]>;
  backups: Sub<BackupsHealth>;
  pendingReviews: Sub<PendingReviewsHealth>;
  rebuild: Sub<RebuildHealth>;
  platformWrites: Sub<PlatformWritesHealth>;
  reconciliation: Sub<ReconciliationHealth>;
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
  /** Only the fields that changed (B3-1R MS-3-1/3-4): the route treats every field as optional. */
  data: Partial<{
    username: string;
    defaultLocationId: number;
    isAdmin: boolean;
    emailAlerts: boolean;
    minLocationEmailAlerts: boolean;
    minCombinedEmailAlerts: boolean;
    companies: Array<{ companyId: string }>;
  }>;
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
  /** Lane 6 (R-E9): the runtime emergency stop for all platform writes. */
  platformWritesKillSwitch: boolean;
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

/**
 * Lane 6 (R-E9): the emergency stop. `engage(true)` blocks EVERY platform write
 * instantly, with no redeploy; `engage(false)` lifts the stop. It can only ever
 * make the posture more restrictive — egress ANDs it with everything else.
 *
 * Invalidates both the settings cache and the ops-health cache so the posture
 * tile reflects the new state on the next poll (or immediately on refetch).
 */
export function useSetPlatformWriteKillSwitch() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: (engaged: boolean) =>
      mutateJSON(
        "/api/admin/settings",
        "POST",
        { platformWritesKillSwitch: engaged },
        csrfToken,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "settings"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "ops-health"] });
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
// Reconciliation  (app/(app)/admin/reconciliation — pack C4a.1, spec REV-7 §4.2)
//
// The wire types are the PRODUCER's (`lib/reconciliation/attribution.ts`),
// imported type-only so no client bundle pulls in Prisma. Everything lives
// under ["admin","reconciliation",…] so one prefix invalidates the report, the
// drill-down and the picker together — which is what a write on this surface
// has to do (a stale row here is a stale `expectPreviousOrderRecordId`).
// ===========================================================================

export interface AttributionReportInput {
  /** ISO day keys; `to` is INCLUSIVE end-of-day UTC (the route's contract). */
  from: string;
  to: string;
  classKey?: AttributionClassKey;
  orderNumber?: string;
  limit?: number;
  cursor?: string;
}

/**
 * The report. DISABLED while either end of the window is empty (QA-5): a date
 * input the operator cleared holds `""`, the route answers that with a 400, and
 * the tab would put an error card over a screen somebody is still filling in.
 * The `useOrderSearch` rule, applied to the other input that can be half-typed.
 */
export function useAttributionReport(input: AttributionReportInput) {
  return useQuery<AttributionReport, ApiError>({
    queryKey: ["admin", "reconciliation", "attribution", input],
    enabled: input.from !== "" && input.to !== "",
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ from: input.from, to: input.to });
      if (input.classKey) params.set("class", input.classKey);
      if (input.orderNumber) params.set("orderNumber", input.orderNumber);
      if (input.limit !== undefined) params.set("limit", String(input.limit));
      if (input.cursor) params.set("cursor", input.cursor);
      return getJSON<AttributionReport>(`/api/reconciliation/attribution?${params}`, { signal });
    },
  });
}

/** The drill-down. `null` = nothing is open, so nothing is asked for. */
export function useBatchDetail(batchId: string | null) {
  return useQuery<BatchDetail, ApiError>({
    queryKey: ["admin", "reconciliation", "batch", batchId],
    queryFn: ({ signal }) =>
      getJSON<BatchDetail>(
        `/api/reconciliation/attribution/${encodeURIComponent(batchId as string)}`,
        { signal },
      ),
    enabled: batchId !== null,
  });
}

// `useOrderSearch` + `OrderSearchResult` / `OrderSearchResponse`: MOVED to
// `hooks/use-order-search.ts` (B3-1b) and re-exported at the top of this file.

export interface AttributeBatchInput {
  orderRecordId: string;
  /** The id the ROW DISPLAYED — `null` states "I saw it unattributed" (D4). */
  expectPreviousOrderRecordId: string | null;
  reason?: string;
}

export interface AttributeBatchResult {
  changed: boolean;
  orderRecordId: string;
  previousOrderRecordId: string | null;
  rowCount: number;
  completedFulfillment: boolean;
}

/**
 * A structured refusal, as the confirm panel needs it: the server's sentence
 * VERBATIM plus the two fields the UI acts on. `mutateJSON`'s plain Error would
 * throw `code` away, and `BATCH_MOVED` would be indistinguishable from any
 * other conflict.
 */
export interface ReconciliationError extends Error {
  status?: number;
  code: string;
  currentOrderRecordId?: string | null;
}

function readReconciliationError(
  res: Response,
  json: Record<string, unknown>,
): ReconciliationError {
  const message =
    typeof json.error === "string" ? json.error : `Request failed (${res.status})`;
  const err = new Error(message) as ReconciliationError;
  err.status = res.status;
  err.code = typeof json.code === "string" ? json.code : "UNKNOWN";
  if ("currentOrderRecordId" in json) {
    err.currentOrderRecordId = (json.currentOrderRecordId as string | null) ?? null;
  }
  return err;
}

/**
 * Manual attribution (D4). `onSettled` — not `onSuccess`: a REFUSED write is
 * exactly when the client's picture is known to be wrong, so the surface
 * refreshes on the way out either way.
 */
export function useAttributeBatch(batchId: string) {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation<AttributeBatchResult, ReconciliationError, AttributeBatchInput>({
    mutationFn: async (input) => {
      const res = await fetch(`/api/reconciliation/attribution/${encodeURIComponent(batchId)}`, {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify(input),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw readReconciliationError(res, json);
      }
      return json as unknown as AttributeBatchResult;
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["admin", "reconciliation"] }),
  });
}

/**
 * The reverse route's answer (reconciliation Part 2, seam S-B17). `restoredUnits`
 * is what THIS call put back; `previouslyRestored` is what earlier corrections
 * already had. The panel prints the server's own `message`, numbers and all.
 */
export interface ReverseBatchResult {
  reversedBatchId: string;
  batchId: string;
  orderRecordId: string | null;
  rows: Array<{ productId: number; locationId: number; delta: number }>;
  restoredUnits: number;
  previouslyRestored: number;
  totalUnits: number;
  physicalLocationId: number | null;
  message: string;
}

/**
 * THE ATOMIC REVERSE (pack CB2b.4). `onSettled`, like its sibling: a REFUSED
 * reverse is exactly when the client's picture is known to be wrong.
 *
 * It invalidates TWO worlds, because it moves stock as well as attribution
 * truth: the reconciliation surface (the report AND the drill-down share the
 * prefix) and the inventory caches every other page reads.
 */
export function useReverseBatch(batchId: string) {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation<ReverseBatchResult, ReconciliationError, void>({
    mutationFn: async () => {
      const res = await fetch(
        `/api/inventory/batches/${encodeURIComponent(batchId)}/reverse`,
        { method: "POST", headers: withCSRFHeaders({}, csrfToken) },
      );
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw readReconciliationError(res, json);
      }
      return json as unknown as ReverseBatchResult;
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "reconciliation"] });
      await invalidateInventoryCaches(queryClient);
    },
  });
}


/**
 * THE WRONG-LOCATION MOVE (pack CB2c.3). `onSettled`, like its two siblings: a
 * REFUSED move is exactly when the client's picture is known to be wrong, and it
 * invalidates the same two worlds the reverse does — the reconciliation surface
 * and the inventory caches every other page reads.
 *
 * IT REJECTS WITH A PLAIN `{ error, code }` OBJECT, deliberately (R7-10). The
 * dialog is shared with the workbench, whose raw-fetch caller rejects with the
 * PARSED BODY; mapping the house `ReconciliationError` here — it carries
 * `.message`/`.code` and no `.error` — is what makes both callers reject
 * identically, so the dialog has one way to read a refusal instead of two.
 * `useReverseBatch` keeps the house class, because `reverse-confirm.tsx` reads
 * `err.message`.
 */
export function useMoveBatch(batchId: string) {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation<MoveResponse, { error: string; code: string }, { physicalLocationId: number }>({
    mutationFn: async (input) => {
      let res: Response;
      try {
        res = await fetch(
          `/api/inventory/batches/${encodeURIComponent(batchId)}/move`,
          {
            method: "POST",
            headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
            body: JSON.stringify(input),
            // CB2.5e.4: the move holds row locks while it writes, and a caller
            // that waits forever leaves the operator staring at a spinner with
            // no way back. The server's own transaction budget is 30 s
            // (`STOCK_TX_OPTIONS`), so 60 s is past every answer it can give.
            // GUARDED — a browser without `AbortSignal.timeout` runs on its own
            // clock rather than throwing before the fetch.
            signal: moveAbortSignal(),
          },
        );
      } catch (err) {
        // B25-FR1/F2: EVERY rejection is "we do not know" — the timeout we asked
        // for, and equally a network that died with the request already out. The
        // SAME `{ error, code }` shape the refusals use, so the one shared dialog
        // reads one thing.
        throw moveUnanswered(err);
      }
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        // A PLAIN OBJECT, not an Error subclass: the workbench's raw-fetch
        // caller rejects with the parsed body, and this is what makes the two
        // rejections the same shape for the one dialog that reads them. A
        // response is a REFUSAL only when it parsed into the house envelope: an
        // ingress 502 with no `code` says nothing about where the batch is.
        if (!isMoveRefusal(json)) {
          // Typed against the module's own envelope (the frozen sentence and the
          // two legal codes are the compiler's business, not a literal's).
          const unanswered: MoveUnanswered = {
            error: MOVE_UNANSWERED_SENTENCE,
            code: "UNANSWERED",
          };
          throw unanswered;
        }
        const refusal = readReconciliationError(res, json);
        throw { error: refusal.message, code: refusal.code };
      }
      return json as unknown as MoveResponse;
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "reconciliation"] });
      await invalidateInventoryCaches(queryClient);
    },
  });
}

/**
 * The FINDER (pack C4b.1). Every filter is the SERVER's — `count` and
 * `moreCount` are computed over the whole filtered set, so a filter applied in
 * the browser would leave the tab reporting a bound it no longer meets.
 */
export interface ExceptionsQueryInput {
  kind?: ExceptionKind;
  /** Defaults (server-side) to `open` — the tab sends it explicitly anyway. */
  resolved?: "open" | "resolved" | "all";
  severity?: ExceptionSeverity;
  olderThanDays?: number;
  limit?: number;
  cursor?: string;
}

export function useExceptions(input: ExceptionsQueryInput) {
  return useQuery<ExceptionsPage, ApiError>({
    queryKey: ["admin", "reconciliation", "exceptions", input],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (input.kind) params.set("kind", input.kind);
      if (input.resolved) params.set("resolved", input.resolved);
      if (input.severity) params.set("severity", input.severity);
      if (input.olderThanDays !== undefined) {
        params.set("olderThanDays", String(input.olderThanDays));
      }
      if (input.limit !== undefined) params.set("limit", String(input.limit));
      if (input.cursor) params.set("cursor", input.cursor);
      return getJSON<ExceptionsPage>(`/api/reconciliation/exceptions?${params}`, { signal });
    },
  });
}

export interface UnmappedQueryInput {
  olderThanDays?: number;
  limit?: number;
  cursor?: string;
}

export function useUnmapped(input: UnmappedQueryInput) {
  return useQuery<UnmappedPage, ApiError>({
    queryKey: ["admin", "reconciliation", "unmapped", input],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (input.olderThanDays !== undefined) {
        params.set("olderThanDays", String(input.olderThanDays));
      }
      if (input.limit !== undefined) params.set("limit", String(input.limit));
      if (input.cursor) params.set("cursor", input.cursor);
      return getJSON<UnmappedPage>(`/api/reconciliation/unmapped?${params}`, { signal });
    },
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
