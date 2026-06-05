import prisma from "@/lib/prisma";
import { dayKeyRange, lastCompletedDayKey, nextDayStart, toDayKey } from "./dates";
import { acquireRebuildLock, heartbeatRebuildLock, releaseRebuildLock, recordRebuildRun } from "./rebuild-lock";

export interface LevelPoint { dayKey: string; quantity: number; }
export interface ReconstructInput { current: number; deltas: { changeTime: Date; delta: number }[]; fromDayKey: string; toDayKey: string; }
export interface ReconstructResult { ok: boolean; levels: LevelPoint[]; }

/** Pure: reconstruct end-of-day levels for [from..to] backward from `current`.
 *  level(D) = current - SUM(delta where changeTime >= nextDayStart(D)). ok=false (flag) if any level < 0. */
export function reconstructLevels({ current, deltas, fromDayKey, toDayKey: to }: ReconstructInput): ReconstructResult {
  const levels: LevelPoint[] = [];
  for (const dayKey of dayKeyRange(fromDayKey, to)) {
    const boundary = nextDayStart(dayKey).getTime();
    let sumAfter = 0;
    for (const d of deltas) if (d.changeTime.getTime() >= boundary) sumAfter += d.delta;
    const quantity = current - sumAfter;
    if (quantity < 0) return { ok: false, levels: [] };
    levels.push({ dayKey, quantity });
  }
  return { ok: true, levels };
}

/** Backfill + nightly. Iterates current product_locations pairs; reconstructs; flags negative pairs; dense-upserts.
 *  `from` defaults to the earliest log day for the pair (>= seed date); `to` defaults to the last COMPLETED UTC day. Idempotent + locked.
 *  Returns `skipped: true` (with a zero result) ONLY when the cross-process lock is already held — so a contended
 *  run is distinguishable from a real completed run that happened to touch zero rows. */
export async function rebuildStockSnapshots(opts: { from?: string; to?: string } = {}): Promise<{ rowsInserted: number; flaggedPairs: number; nullLocationCutoff: string | null; skipped: boolean }> {
  const token = await acquireRebuildLock("snapshots");
  if (!token) return { rowsInserted: 0, flaggedPairs: 0, nullLocationCutoff: null, skipped: true };
  let rowsInserted = 0, flaggedPairs = 0;
  let aborted = false;
  try {
    // Snapshots cover end-of-COMPLETED-day only; default `to` is yesterday so a nightly run never stamps today's
    // mid-run live level as that day's verified end-of-day row. Explicit opts.to overrides (e.g. backfill any day).
    const to = opts.to ?? lastCompletedDayKey();
    // Date-bound past legacy null-location movements: any inventory_logs row with locationId=null and a nonzero
    // delta is unattributable to a per-location grain. Reconstruction is only trustworthy for days strictly AFTER
    // the last such log, so we floor the backfill at (max null-location-log day + 1). Days at/before that are a
    // documented gap (legacy pre-per-location-logging data). The current code never creates null-location logs.
    const maxNull = await prisma.inventory_logs.aggregate({ _max: { changeTime: true }, where: { locationId: null, delta: { not: 0 } } });
    const nullLocationCutoff = maxNull._max.changeTime ? toDayKey(nextDayStart(toDayKey(maxNull._max.changeTime))) : null;
    if (nullLocationCutoff) console.warn(`[snapshots] null-location legacy logs present — flooring backfill at ${nullLocationCutoff} (pre-cutoff is a documented gap)`);

    const pairs = await prisma.product_locations.findMany({ select: { productId: true, locationId: true, quantity: true } });
    let i = 0;
    for (const pair of pairs) {
      if (++i % 100 === 0) {
        const alive = await heartbeatRebuildLock("snapshots", token);
        if (!alive) { console.warn("[snapshots] lease lost mid-run — aborting"); aborted = true; break; }
      }
      const logs = await prisma.inventory_logs.findMany({
        where: { productId: pair.productId, locationId: pair.locationId },
        select: { changeTime: true, delta: true },
      });
      const baseFrom = opts.from ?? (logs.length ? toDayKey(logs.reduce((a, b) => (a.changeTime < b.changeTime ? a : b)).changeTime) : to);
      // String comparison of 'YYYY-MM-DD' dayKeys is chronological. If the cutoff is later than baseFrom, floor at it.
      // If from > to (cutoff in the future), dayKeyRange yields [] and this pair contributes 0 rows (no crash).
      const from = nullLocationCutoff && nullLocationCutoff > baseFrom ? nullLocationCutoff : baseFrom;
      const r = reconstructLevels({ current: pair.quantity, deltas: logs, fromDayKey: from, toDayKey: to });
      if (!r.ok) { flaggedPairs++; console.warn(`[snapshots] flagged pair product=${pair.productId} loc=${pair.locationId}: negative reconstruction`); continue; }
      for (const lvl of r.levels) {
        await prisma.productStockSnapshot.upsert({
          where: { productId_locationId_dayKey: { productId: pair.productId, locationId: pair.locationId, dayKey: lvl.dayKey } },
          update: { quantity: lvl.quantity },
          create: { productId: pair.productId, locationId: pair.locationId, dayKey: lvl.dayKey, quantity: lvl.quantity },
        });
        rowsInserted++; // counts rows upserted (touched), including updates of existing rows — not strictly net-new
      }
    }
    // Record the EFFECTIVE floor (the applied cutoff) so the run record reflects the actual backfill start.
    await recordRebuildRun("snapshots", { lastWindowFrom: nullLocationCutoff ?? opts.from ?? null, lastWindowTo: to, rowsInserted, flaggedPairs, lastError: aborted ? "aborted: lease lost mid-run" : null });
    return { rowsInserted, flaggedPairs, nullLocationCutoff, skipped: false };
  } catch (e) {
    await recordRebuildRun("snapshots", { lastError: String((e as Error).message) });
    throw e;
  } finally {
    await releaseRebuildLock("snapshots", token);
  }
}
