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

/** Extend the lease. No-op if superseded (token mismatch). Call periodically during long runs. */
export async function heartbeatRebuildLock(job: RebuildJob, token: Date): Promise<void> {
  await prisma.analyticsRebuildState.updateMany({ where: { job, lockedAt: token }, data: { heartbeatAt: new Date() } });
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

/** Persist the run record (observability — prove correctness). lastRunAt stamped automatically. */
export async function recordRebuildRun(job: RebuildJob, fields: Partial<RebuildRunFields>): Promise<void> {
  await prisma.analyticsRebuildState.update({ where: { job }, data: { ...fields, lastRunAt: new Date() } });
}
