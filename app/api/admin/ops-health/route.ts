import { NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { listBackups } from "@/lib/backup/list";
import { getPostureView } from "@/lib/platforms/egress";
import type {
  Sub,
  IntegrationHealth,
  BackupsHealth,
  PendingReviewsHealth,
  RebuildJobHealth,
  RebuildRunRow,
  RebuildHealth,
  AttentionItem,
  OpsHealthResponse,
  PlatformWritesHealth,
} from "@/hooks/use-admin";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/ops-health (admin) — the triage aggregate behind the Overview's
 * ops-health section (spec §3 D7/D8, §10 R-L14, §11 D-L1/D-L4). Polled at 60s
 * (slower than the 30s dashboard route, which stays untouched).
 *
 * EVERY subsystem is enveloped as Sub<T> and assembled via Promise.allSettled: a
 * subsystem that throws degrades to { status:'unavailable', errorCode } and NEVER
 * 500s the whole route (codex #7). The verdict + needs-attention list are derived
 * AFTER assembly from whatever succeeded. The response contract types live in
 * hooks/use-admin.ts so no client bundle imports this route handler.
 */

// --- thresholds ---

const INTEGRATION_LOCK_STALE_MS = 5 * 60 * 1000; // syncLockedAt older than this = stale (matches sync acquire)
const REBUILD_LEASE_MS = 15 * 60 * 1000; // rebuild heartbeatAt older than this = stale lock
const NO_SUCCESS_MS = 26 * 60 * 60 * 1000; // enabled + no SUCCESS within this = warn
const BACKUP_AMBER_MS = 26 * 60 * 60 * 1000; // newest older than this = amber
const BACKUP_RED_MS = 50 * 60 * 60 * 1000; // newest older than this = red

/** Sidecar heartbeat is stale past 2x its tick interval (default 30m tick). */
function heartbeatStaleMs(): number {
  const tickMinutes = Math.max(1, parseInt(process.env.ANALYTICS_REBUILD_TICK_MINUTES || "30", 10));
  return 2 * tickMinutes * 60 * 1000;
}

/** Parse the write-only lastSyncError JSON summary tolerantly (malformed => raw as message). */
function parseSyncError(
  raw: string | null,
): { at: string | null; message: string; errorCount: number } | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { at?: unknown; errors?: unknown; message?: unknown; errorCount?: unknown };
    const firstErr =
      Array.isArray(p.errors) && p.errors.length > 0
        ? String((p.errors[0] as { message?: unknown })?.message ?? "Sync error")
        : String(p.message ?? "Sync error");
    return {
      at: typeof p.at === "string" ? p.at : null,
      message: firstErr,
      errorCount:
        typeof p.errorCount === "number"
          ? p.errorCount
          : Array.isArray(p.errors)
            ? p.errors.length
            : 1,
    };
  } catch {
    return { at: null, message: raw, errorCount: 1 };
  }
}

// --- subsystem loaders (each throws on its own failure; allSettled envelopes it) ---

async function loadIntegrations(now: number): Promise<IntegrationHealth[]> {
  const rows = await prisma.integration.findMany({
    select: {
      id: true,
      name: true,
      platform: true,
      isActive: true,
      lastSyncAt: true,
      lastSyncError: true,
      lastStockSyncError: true,
      syncLockedAt: true,
      webhookFailureCount: true,
      lastWebhookReceivedAt: true,
      company: { select: { name: true } },
    },
    orderBy: [{ company: { name: "asc" } }, { name: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    platform: r.platform,
    companyName: r.company?.name ?? "",
    isActive: r.isActive,
    lastSyncAt: r.lastSyncAt ? r.lastSyncAt.toISOString() : null,
    lastSyncError: parseSyncError(r.lastSyncError),
    lastStockSyncError: r.lastStockSyncError,
    syncLockedAt: r.syncLockedAt ? r.syncLockedAt.toISOString() : null,
    lockStale: r.syncLockedAt ? now - r.syncLockedAt.getTime() > INTEGRATION_LOCK_STALE_MS : false,
    webhookFailureCount: r.webhookFailureCount,
    lastWebhookReceivedAt: r.lastWebhookReceivedAt ? r.lastWebhookReceivedAt.toISOString() : null,
  }));
}

async function loadBackups(now: number): Promise<BackupsHealth> {
  const listing = await listBackups();
  const newest = listing.files[0]
    ? {
        name: listing.files[0].name,
        mtimeMs: listing.files[0].mtimeMs,
        ageHours: (now - listing.files[0].mtimeMs) / (60 * 60 * 1000),
      }
    : null;
  return { newest, count: listing.files.length, volume: listing.status };
}

// Receiving/Labeling overhaul (spec §11, PK2-12): the staging counter SPLITS in
// two, because after the cutover the two numbers mean different things. Open
// new-flow lines are work in progress on the current flow; a residual RECEIVED
// row is a pre-staging straggler that appeared between the drain check and the
// deploy, and it is settled through the runbook, not by working a queue. They
// are reported as two counts and rendered as two rows — never added together.
const STAGING_OPEN_NEW_FLOW = ["ORDERED", "VERIFIED", "LABELING"] as const;

async function loadPendingReviews(): Promise<PendingReviewsHealth> {
  const [pendingUsers, pendingProducts, stagingOpenNewFlow, stagingResidualReceived] =
    await Promise.all([
      prisma.user.count({ where: { isApproved: false, deletedAt: null } }),
      prisma.product.count({ where: { approvalStatus: "PENDING_REVIEW", deletedAt: null } }),
      prisma.stagingItem.count({ where: { status: { in: [...STAGING_OPEN_NEW_FLOW] } } }),
      prisma.stagingItem.count({ where: { status: "RECEIVED" } }),
    ]);
  return { pendingUsers, pendingProducts, stagingOpenNewFlow, stagingResidualReceived };
}

async function loadRebuild(now: number): Promise<RebuildHealth> {
  const [states, enabledSetting, heartbeatSetting] = await Promise.all([
    prisma.analyticsRebuildState.findMany({
      select: { job: true, lockedAt: true, heartbeatAt: true, lastError: true },
    }),
    prisma.systemSetting.findUnique({ where: { key: "analyticsRebuildEnabled" } }),
    prisma.systemSetting.findUnique({ where: { key: "analyticsSidecarHeartbeat" } }),
  ]);
  const enabled = enabledSetting?.value === "true";

  // Heartbeat: { at, envEnabled } JSON; tolerate malformed / missing. envEnabled is
  // the sidecar's own ENABLE_ANALYTICS_REBUILD flag; null for pre-P5 payloads that
  // never carried it or for malformed JSON (so the mismatch check stays inert).
  let sidecarSeenAt: string | null = null;
  let envEnabled: boolean | null = null;
  if (heartbeatSetting?.value) {
    try {
      const hb = JSON.parse(heartbeatSetting.value) as { at?: unknown; envEnabled?: unknown };
      if (typeof hb.at === "string") sidecarSeenAt = hb.at;
      if (typeof hb.envEnabled === "boolean") envEnabled = hb.envEnabled;
    } catch {
      sidecarSeenAt = null;
      envEnabled = null;
    }
  }
  const heartbeatStale =
    !sidecarSeenAt || now - new Date(sidecarSeenAt).getTime() > heartbeatStaleMs();

  // Last SUCCESSFUL run per job + recent runs (last 10/job).
  const jobs: RebuildJobHealth[] = await Promise.all(
    states.map(async (s) => {
      const lastSuccess = await prisma.analyticsRebuildRun.findFirst({
        where: { job: s.job, status: "SUCCEEDED" },
        orderBy: { startedAt: "desc" },
        select: { finishedAt: true, startedAt: true },
      });
      const successAt = lastSuccess?.finishedAt ?? lastSuccess?.startedAt ?? null;
      return {
        job: s.job,
        enabled,
        lastSuccessAt: successAt ? successAt.toISOString() : null,
        lastError: s.lastError,
        lockHeld: s.lockedAt != null,
        lockStale:
          s.lockedAt != null &&
          (s.heartbeatAt == null || now - s.heartbeatAt.getTime() > REBUILD_LEASE_MS),
        sidecarSeenAt,
      };
    }),
  );

  const runRows = await prisma.analyticsRebuildRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 20,
  });
  const runs: RebuildRunRow[] = runRows.map((r) => ({
    id: r.id,
    job: r.job,
    mode: r.mode,
    source: r.source,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    durationMs: r.durationMs,
    windowFrom: r.windowFrom,
    windowTo: r.windowTo,
    rowsDeleted: r.rowsDeleted,
    rowsInserted: r.rowsInserted,
    unattributed: r.unattributed,
    flaggedPairs: r.flaggedPairs,
    skippedReason: r.skippedReason,
    error: r.error,
  }));

  return { jobs, runs, sidecarSeenAt, heartbeatStale, envEnabled };
}

// --- assembly ---

function toSub<T>(r: PromiseSettledResult<T>, code: string): Sub<T> {
  return r.status === "fulfilled"
    ? { status: "ok", data: r.value }
    : { status: "unavailable", errorCode: code };
}

/** Lane 6: the effective platform-write posture for the ops dashboard tile. */
async function loadPlatformWrites(): Promise<PlatformWritesHealth> {
  const view = await getPostureView();
  return {
    effective: view.effective,
    capabilities: view.capabilities,
    killSwitchEngaged: view.killSwitchEngaged,
    invalidEnv: view.invalidEnv,
    invalidReasons: view.invalidReasons,
    label: view.label,
  };
}

export const GET = apiHandler(async () => {
  await requireAdmin();
  const now = Date.now();

  const [integrationsR, backupsR, pendingR, rebuildR, platformWritesR] =
    await Promise.allSettled([
      loadIntegrations(now),
      loadBackups(now),
      loadPendingReviews(),
      loadRebuild(now),
      loadPlatformWrites(),
    ]);

  const integrations = toSub(integrationsR, "INTEGRATIONS_UNAVAILABLE");
  const backups = toSub(backupsR, "BACKUPS_UNAVAILABLE");
  const pendingReviews = toSub(pendingR, "PENDING_REVIEWS_UNAVAILABLE");
  const rebuild = toSub(rebuildR, "REBUILD_UNAVAILABLE");
  const platformWrites = toSub(platformWritesR, "PLATFORM_WRITES_UNAVAILABLE");

  const attention: AttentionItem[] = [];

  // Integrations: a durable order-sync failure is negative; lock-stale / webhook flaps warn.
  if (integrations.status === "ok") {
    for (const it of integrations.data) {
      if (it.lastSyncError) {
        attention.push({
          severity: "negative",
          system: "Integrations",
          message: `${it.companyName || it.name}: order sync failing — ${it.lastSyncError.message}`,
          href: "/admin/integrations",
        });
      } else if (it.lockStale) {
        attention.push({
          severity: "warning",
          system: "Integrations",
          message: `${it.companyName || it.name}: sync lock stuck (over 5 minutes)`,
          href: "/admin/integrations",
        });
      } else if (it.webhookFailureCount > 0) {
        attention.push({
          severity: "warning",
          system: "Integrations",
          message: `${it.companyName || it.name}: ${it.webhookFailureCount} webhook failures`,
          href: "/admin/integrations",
        });
      }
    }
  } else {
    attention.push({ severity: "warning", system: "Integrations", message: "Integration health unavailable", href: "/admin/integrations" });
  }

  // Backups: unreadable volume or a red-age newest is negative; amber / none warn.
  if (backups.status === "ok") {
    const b = backups.data;
    if (b.volume === "unavailable") {
      attention.push({ severity: "negative", system: "Backups", message: "Backup volume unreadable", href: "/admin/backup" });
    } else if (b.count === 0) {
      attention.push({ severity: "warning", system: "Backups", message: "No database backups yet", href: "/admin/backup" });
    } else if (b.newest && now - b.newest.mtimeMs > BACKUP_RED_MS) {
      attention.push({ severity: "negative", system: "Backups", message: `Newest backup is over ${Math.round(BACKUP_RED_MS / 3600000)} hours old`, href: "/admin/backup" });
    } else if (b.newest && now - b.newest.mtimeMs > BACKUP_AMBER_MS) {
      attention.push({ severity: "warning", system: "Backups", message: "Newest backup is over a day old", href: "/admin/backup" });
    }
  } else {
    attention.push({ severity: "warning", system: "Backups", message: "Backup status unavailable", href: "/admin/backup" });
  }

  // Pending reviews: actionable queues warn.
  if (pendingReviews.status === "ok") {
    const p = pendingReviews.data;
    if (p.pendingProducts > 0) {
      attention.push({ severity: "warning", system: "Reviews", message: `${p.pendingProducts} products awaiting review`, href: "/admin/product-review" });
    }
    // `stagingOpenNewFlow` is deliberately NOT an attention item (spec REV-10
    // clause 7): lines in ORDERED/VERIFIED/LABELING are the operator path
    // WORKING, and a health panel that goes amber whenever somebody is
    // receiving something is amber forever — which teaches people to ignore it.
    // The number is still reported in `pendingReviews.data`, as a workload
    // figure. `stagingResidualReceived` stays a warning: a straggler is a
    // cutover event nobody is working on.
    if (p.stagingResidualReceived > 0) {
      attention.push({ severity: "warning", system: "Reviews", message: `${p.stagingResidualReceived} legacy straggler row(s) still RECEIVED — follow the receiving cutover runbook`, href: "/admin" });
    }
    if (p.pendingUsers > 0) {
      attention.push({ severity: "warning", system: "Reviews", message: `${p.pendingUsers} users awaiting approval`, href: "/admin/users" });
    }
  } else {
    attention.push({ severity: "warning", system: "Reviews", message: "Pending-review counts unavailable", href: "/admin" });
  }

  // Rebuild: heartbeat-down or a job error is negative; no-recent-success / stale-lock warn.
  if (rebuild.status === "ok") {
    const r = rebuild.data;
    const anyEnabled = r.jobs.some((j) => j.enabled);
    if (anyEnabled && r.heartbeatStale) {
      attention.push({ severity: "negative", system: "Analytics rebuild", message: "Rebuild sidecar not running (no recent heartbeat)", href: "/admin/settings" });
    }
    for (const j of r.jobs) {
      if (j.lastError) {
        attention.push({ severity: "negative", system: "Analytics rebuild", message: `${j.job} rebuild error: ${j.lastError}`, href: "/admin/settings" });
      } else if (j.enabled && (!j.lastSuccessAt || now - new Date(j.lastSuccessAt).getTime() > NO_SUCCESS_MS)) {
        attention.push({ severity: "warning", system: "Analytics rebuild", message: `${j.job} has no successful rebuild in over a day`, href: "/admin/settings" });
      } else if (j.lockStale) {
        attention.push({ severity: "warning", system: "Analytics rebuild", message: `${j.job} rebuild lock is stale`, href: "/admin/settings" });
      }
    }
    // Two-flag misconfig (spec P5, codex #12). Only trust a FRESH heartbeat carrying
    // a parsed boolean envEnabled: a stale/absent/pre-P5 heartbeat leaves this inert
    // (the heartbeat-stale item above already covers a down sidecar). `anyEnabled` is
    // the admin/DB toggle (every job shares it); env is the environment flag.
    if (!r.heartbeatStale && typeof r.envEnabled === "boolean") {
      if (r.envEnabled && !anyEnabled) {
        attention.push({ severity: "warning", system: "Analytics rebuild", message: "Analytics rebuild is enabled in the environment but the admin toggle is off.", href: "/admin/settings" });
      } else if (!r.envEnabled && anyEnabled) {
        attention.push({ severity: "warning", system: "Analytics rebuild", message: "Analytics rebuild admin toggle is on but the environment flag is off.", href: "/admin/settings" });
      }
    }
  } else {
    attention.push({ severity: "warning", system: "Analytics rebuild", message: "Rebuild status unavailable", href: "/admin/settings" });
  }

  // Platform writes: an env we could NOT parse is a real red flag — writes fell
  // closed to off, and the operator's intent did not take effect (codex #16). The
  // emergency stop being engaged is surfaced as info (it is a deliberate act).
  if (platformWrites.status === "ok") {
    const p = platformWrites.data;
    if (p.invalidEnv) {
      attention.push({
        severity: "negative",
        system: "Platform writes",
        message: `Platform-write config not understood (${p.invalidReasons.join(", ")}); writes are OFF.`,
        href: "/admin/settings",
      });
    }
  } else {
    attention.push({
      severity: "warning",
      system: "Platform writes",
      message: "Platform-write posture unavailable",
      href: "/admin/settings",
    });
  }

  // Severity-then-insertion order (negative before warning); insertion is already recency-ish per system.
  attention.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "negative" ? -1 : 1));

  const verdict: OpsHealthResponse["verdict"] = attention.some((a) => a.severity === "negative")
    ? "failing"
    : attention.length > 0
      ? "degraded"
      : "ok";

  return NextResponse.json({
    verdict,
    attention,
    integrations,
    backups,
    pendingReviews,
    rebuild,
    platformWrites,
  } satisfies OpsHealthResponse);
});
