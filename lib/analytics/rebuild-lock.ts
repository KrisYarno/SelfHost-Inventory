import prisma from "@/lib/prisma";

export type RebuildJob = "snapshots" | "sales";

/** Lease length. A live job heartbeats well under this; a crashed job's lease expires and is re-acquirable. */
const LEASE_MS = 15 * 60 * 1000;

/** Atomic acquire: succeeds only if free (lockedAt null) or the prior holder's lease went stale. Returns the
 *  acquire timestamp (fencing token) or null if another run holds a live lease. Mirrors Integration.syncLockedAt. */
export async function acquireRebuildLock(job: RebuildJob): Promise<Date | null> {
  const now = new Date();
  const stale = new Date(now.getTime() - LEASE_MS);
  const res = await prisma.analyticsRebuildState.updateMany({
    where: { job, OR: [{ lockedAt: null }, { heartbeatAt: { lt: stale } }, { heartbeatAt: null, lockedAt: { lt: stale } }] },
    data: { lockedAt: now, heartbeatAt: now },
  });
  return res.count === 1 ? now : null;
}

/** Extend the lease; returns false if superseded (lease lost) — the caller should stop. Call comfortably under
 *  LEASE_MS (e.g. every 30-60s and around any long operation); if the gap between heartbeats exceeds the 15-min
 *  lease, a second runner can steal the lock. */
export async function heartbeatRebuildLock(job: RebuildJob, token: Date): Promise<boolean> {
  const res = await prisma.analyticsRebuildState.updateMany({ where: { job, lockedAt: token }, data: { heartbeatAt: new Date() } });
  return res.count === 1;
}

/** Fencing release: only clears the lock if we still own it (token match); no-op if superseded. */
export async function releaseRebuildLock(job: RebuildJob, token: Date): Promise<void> {
  await prisma.analyticsRebuildState.updateMany({ where: { job, lockedAt: token }, data: { lockedAt: null, heartbeatAt: null } });
}

export interface RebuildRunFields {
  lastWindowFrom: string | null; lastWindowTo: string | null;
  rowsDeleted: number; rowsInserted: number; unattributed: number; flaggedPairs: number;
  sourceWatermark: Date | null; lastError: string | null;
}

// ---------------------------------------------------------------------------
// Run lifecycle (Lane 3, spec §10 R-L14 / plan Task 6 codex #1).
//
// A run is a row in `analytics_rebuild_runs` (operational telemetry, NOT audit).
// The lifecycle OWNS the cross-process lock: beginRebuildRun acquires it and
// inserts a RUNNING row; finalizeRebuildRun writes the terminal row + the
// AnalyticsRebuildState mirror + the keep-100 retention prune in ONE
// transaction, then releases the lock via the fencing token. rebuild-snapshots
// / rebuild-sales drive this (they hold the lock today).
// ---------------------------------------------------------------------------

/** Who / why triggered this run — carried onto the RUNNING row at begin time. */
export interface RebuildMeta {
  mode: 'nightly' | 'full' | 'backfill';
  source: 'cron' | 'manual' | 'cli';
  requestedByUserId?: number;
}

/**
 * `acquired: true`  — the lock is ours; `runId` is a fresh RUNNING row, `token`
 *                     is the fencing token to pass to finalizeRebuildRun.
 * `acquired: false` — the lock is held by a live run; `runId` is an ALREADY
 *                     FINALIZED row (status ABORTED, skippedReason 'lock-held').
 *                     The caller must NOT call finalizeRebuildRun for it.
 */
export type BeginRunResult =
  | { acquired: true; runId: number; token: Date }
  | { acquired: false; runId: number };

/**
 * Acquire the lock and open a run row. On acquire, inserts a RUNNING row and
 * returns its id + the fencing token. On contention, records a self-finalized
 * ABORTED / 'lock-held' row so a skipped attempt is still visible in history,
 * and returns { acquired: false }.
 */
export async function beginRebuildRun(job: RebuildJob, meta: RebuildMeta): Promise<BeginRunResult> {
  const token = await acquireRebuildLock(job);
  const now = new Date();
  const base = {
    job,
    mode: meta.mode,
    source: meta.source,
    requestedByUserId: meta.requestedByUserId ?? null,
    startedAt: now,
  };

  if (!token) {
    const row = await prisma.analyticsRebuildRun.create({
      data: { ...base, status: 'ABORTED', finishedAt: now, durationMs: 0, skippedReason: 'lock-held' },
      select: { id: true },
    });
    return { acquired: false, runId: row.id };
  }

  const row = await prisma.analyticsRebuildRun.create({
    data: { ...base, status: 'RUNNING' },
    select: { id: true },
  });
  return { acquired: true, runId: row.id, token };
}

/** How many run rows to keep per job (newest by startedAt); older rows are pruned. */
export const REBUILD_RUN_RETENTION = 100;

/**
 * Finalize a run: terminal run-row + AnalyticsRebuildState mirror + keep-100
 * retention prune in ONE transaction, then a fenced lock release via `token`
 * (pass null when the run was never acquired). Partial counters supplied by a
 * FAILED/ABORTED caller are preserved verbatim. durationMs is computed from the
 * RUNNING row's startedAt.
 */
export async function finalizeRebuildRun(
  runId: number,
  token: Date | null,
  outcome: { status: 'SUCCEEDED' | 'FAILED' | 'ABORTED'; skippedReason?: string } & Partial<RebuildRunFields>,
): Promise<void> {
  const finishedAt = new Date();
  const { status, skippedReason, ...fields } = outcome;

  const job = await prisma.$transaction(async (tx) => {
    const run = await tx.analyticsRebuildRun.findUnique({ where: { id: runId }, select: { job: true, startedAt: true } });
    const runJob = run?.job ?? '';
    const durationMs = run ? finishedAt.getTime() - run.startedAt.getTime() : null;

    await tx.analyticsRebuildRun.update({
      where: { id: runId },
      data: {
        status,
        finishedAt,
        durationMs,
        skippedReason: skippedReason ?? null,
        // Run-row column names differ from the state mirror (windowFrom/windowTo/error).
        windowFrom: fields.lastWindowFrom,
        windowTo: fields.lastWindowTo,
        rowsDeleted: fields.rowsDeleted,
        rowsInserted: fields.rowsInserted,
        unattributed: fields.unattributed,
        flaggedPairs: fields.flaggedPairs,
        sourceWatermark: fields.sourceWatermark,
        error: fields.lastError,
      },
    });

    if (runJob) {
      // State mirror: RebuildRunFields keys map 1:1 onto the state columns.
      await tx.analyticsRebuildState.update({ where: { job: runJob }, data: { ...fields, lastRunAt: finishedAt } });

      // Retention: keep the newest REBUILD_RUN_RETENTION rows per job; delete the rest.
      const stale = await tx.analyticsRebuildRun.findMany({
        where: { job: runJob },
        orderBy: { startedAt: 'desc' },
        skip: REBUILD_RUN_RETENTION,
        select: { id: true },
      });
      if (stale.length) {
        await tx.analyticsRebuildRun.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
      }
    }

    return runJob;
  });

  if (token && job) await releaseRebuildLock(job as RebuildJob, token);
}
