import prisma from "@/lib/prisma";
import { dayKeyRange, nextDayStart, toDayKey } from "./dates";
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
 *  `from` defaults to the earliest log day for the pair (>= seed date); `to` defaults to today (UTC). Idempotent + locked. */
export async function rebuildStockSnapshots(opts: { from?: string; to?: string } = {}): Promise<{ rowsInserted: number; flaggedPairs: number }> {
  const token = await acquireRebuildLock("snapshots");
  if (!token) return { rowsInserted: 0, flaggedPairs: 0 };
  let rowsInserted = 0, flaggedPairs = 0;
  let aborted = false;
  try {
    const to = opts.to ?? toDayKey(new Date());
    // Tripwire: no nonzero null-location deltas may exist (verified none today; a future one would be unattributable).
    const badNull = await prisma.inventory_logs.count({ where: { locationId: null, delta: { not: 0 } } });
    if (badNull > 0) throw new Error(`reconcile: ${badNull} nonzero null-location inventory_logs exist — investigate before trusting snapshots`);

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
      const from = opts.from ?? (logs.length ? toDayKey(logs.reduce((a, b) => (a.changeTime < b.changeTime ? a : b)).changeTime) : to);
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
    await recordRebuildRun("snapshots", { lastWindowFrom: opts.from ?? null, lastWindowTo: to, rowsInserted, flaggedPairs, lastError: aborted ? "aborted: lease lost mid-run" : null });
    return { rowsInserted, flaggedPairs };
  } catch (e) {
    await recordRebuildRun("snapshots", { lastError: String((e as Error).message) });
    throw e;
  } finally {
    await releaseRebuildLock("snapshots", token);
  }
}
