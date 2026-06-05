import prisma from "@/lib/prisma";
import { saleDayKey, dayKeyRange, dayKeyStart, nextDayStart, toDayKey } from "./dates";
import { attributeOrderItems, AttributableItem } from "./attribution";
import { acquireRebuildLock, heartbeatRebuildLock, releaseRebuildLock, recordRebuildRun } from "./rebuild-lock";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back the nightly `updatedAt` window reaches (default 36h, env-tunable). Generous overlap
 *  past the ~24h cadence so a late/slow nightly run never leaves a gap in updatedAt-touched orders. */
const SALES_NIGHTLY_LOOKBACK_MS =
  parseInt(process.env.ANALYTICS_SALES_NIGHTLY_LOOKBACK_HOURS || "36", 10) * 60 * 60 * 1000;

/** How many trailing COMPLETED days the nightly run unconditionally re-scans (default 14, env-tunable).
 *  This catches retroactive source edits that DON'T bump ExternalOrder.updatedAt (item re-mapping, hard
 *  deletes, sale-date corrections), which the updatedAt window alone would miss for up to a week. */
const SALES_NIGHTLY_ROLLING_DAYS =
  parseInt(process.env.ANALYTICS_SALES_NIGHTLY_ROLLING_DAYS || "14", 10);

/** Distinct, sorted UTC dayKeys for a set of orders (by externalCreatedAt ?? createdAt). */
export function collectTouchedDayKeys(orders: { externalCreatedAt: Date | null; createdAt: Date }[]): string[] {
  return Array.from(new Set(orders.map(saleDayKey))).sort();
}

export interface FactRow { productId: number; companyId: string; integrationId: string; dayKey: string;
  orderedQty: number; fulfilledQty: number; revenue: string; orderCount: number; }

/** Pure: attribution accumulators -> insertable fact rows (cents -> Decimal string; distinct orders -> orderCount). */
export function factRowsFor(items: AttributableItem[]): { rows: FactRow[]; unattributed: number } {
  const { facts, unattributed } = attributeOrderItems(items);
  const rows = Array.from(facts.values()).map((f) => ({
    productId: f.productId, companyId: f.companyId, integrationId: f.integrationId, dayKey: f.dayKey,
    orderedQty: f.orderedQty, fulfilledQty: f.fulfilledQty,
    revenue: (f.revenueCents / 100).toFixed(2), orderCount: f.orderIds.size,
  }));
  return { rows, unattributed };
}

// Single SELECT (NEVER include+select together). Scalars + the two relations attribution needs.
const ITEM_SELECT = {
  quantity: true, fulfilledQty: true, price: true, bundleComponentSnapshot: true,
  productLink: { select: { internalProductId: true, isBundle: true } },
  order: { select: { companyId: true, integrationId: true, internalStatus: true, externalCreatedAt: true, createdAt: true, id: true } },
} as const;

/** Recompute ONE dayKey atomically: delete-scope == recompute-scope. Re-scans ALL orders of that day. */
async function recomputeDayKey(dayKey: string, companyId?: string): Promise<{ deleted: number; inserted: number; unattributed: number }> {
  const start = dayKeyStart(dayKey), end = nextDayStart(dayKey);
  const orderWhere = {
    OR: [{ externalCreatedAt: { gte: start, lt: end } }, { externalCreatedAt: null, createdAt: { gte: start, lt: end } }],
    ...(companyId ? { companyId } : {}),
  };
  return prisma.$transaction(async (tx) => {
    const deleted = await tx.productSalesFact.deleteMany({ where: { dayKey, ...(companyId ? { companyId } : {}) } });
    const items = await tx.externalOrderItem.findMany({ where: { order: orderWhere }, select: ITEM_SELECT });
    const { rows, unattributed } = factRowsFor(items as unknown as AttributableItem[]);
    if (rows.length) await tx.productSalesFact.createMany({ data: rows });
    return { deleted: deleted.count, inserted: rows.length, unattributed };
  });
}

/** Nightly (rolling window ∪ updatedAt window) or weekly true-full rebuild. Locked + heartbeated. Idempotent.
 *  Returns `skipped: true` (with a zero result) ONLY when the cross-process lock is already held — so a
 *  contended run is distinguishable from a real completed run that happened to touch zero days. */
export async function rebuildSalesFacts(opts: { since?: Date; full?: boolean; companyId?: string } = {}): Promise<{ rowsDeleted: number; rowsInserted: number; unattributed: number; skipped: boolean }> {
  const token = await acquireRebuildLock("sales");
  if (!token) return { rowsDeleted: 0, rowsInserted: 0, unattributed: 0, skipped: true };
  let rowsDeleted = 0, rowsInserted = 0, unattributed = 0, watermark: Date | null = null, aborted = false;
  try {
    let dayKeys: string[];
    if (opts.full) {
      // TRUE full: start at the earliest SALE day, not the earliest createdAt. An imported order can have a
      // later createdAt but an OLDER externalCreatedAt, so its old sale-days would never enter the range if we
      // keyed off createdAt alone. saleDayKey = externalCreatedAt ?? createdAt, so the true floor is the MIN of
      // both branches: the earliest externalCreatedAt (where present) AND the earliest createdAt (the fallback).
      const [earliestExternal, earliestCreated] = await Promise.all([
        prisma.externalOrder.findFirst({ where: { externalCreatedAt: { not: null } }, orderBy: { externalCreatedAt: "asc" }, select: { externalCreatedAt: true, createdAt: true } }),
        prisma.externalOrder.findFirst({ orderBy: { createdAt: "asc" }, select: { externalCreatedAt: true, createdAt: true } }),
      ]);
      const candidates = [earliestExternal, earliestCreated].filter((o): o is { externalCreatedAt: Date | null; createdAt: Date } => o != null).map(saleDayKey);
      const minSaleDay = candidates.length ? candidates.reduce((a, b) => (a < b ? a : b)) : null;
      dayKeys = minSaleDay ? dayKeyRange(minSaleDay, toDayKey(new Date())) : [];
    } else {
      // Nightly dayKeys = UNION of two sources, because each catches what the other misses:
      //   (a) a rolling window of the last N completed days — catches RETROACTIVE source edits that DON'T bump
      //       ExternalOrder.updatedAt (item re-mapping, hard deletes, sale-date corrections) within N days.
      //   (b) the updatedAt-touched days — catches updates to OLD orders whose sale-day is OUTSIDE the rolling
      //       window (e.g. a fulfillment posted today against an order from two months ago).
      const now = new Date();
      const rollingDays = dayKeyRange(toDayKey(new Date(now.getTime() - SALES_NIGHTLY_ROLLING_DAYS * DAY_MS)), toDayKey(now));
      const since = opts.since ?? new Date(now.getTime() - SALES_NIGHTLY_LOOKBACK_MS);
      const touched = await prisma.externalOrder.findMany({ where: { updatedAt: { gte: since }, ...(opts.companyId ? { companyId: opts.companyId } : {}) },
        select: { externalCreatedAt: true, createdAt: true, updatedAt: true } });
      const touchedKeys = collectTouchedDayKeys(touched);
      dayKeys = Array.from(new Set([...rollingDays, ...touchedKeys])).sort();
      // Watermark tracks the updatedAt frontier only (the rolling window is time-derived, not order-derived).
      watermark = touched.reduce<Date | null>((m, o) => (!m || o.updatedAt > m ? o.updatedAt : m), null);
    }
    let i = 0;
    for (const dk of dayKeys) {
      if (++i % 10 === 0) { const alive = await heartbeatRebuildLock("sales", token); if (!alive) { console.warn("[sales] lease lost mid-run — aborting"); aborted = true; break; } }
      const r = await recomputeDayKey(dk, opts.companyId);
      rowsDeleted += r.deleted; rowsInserted += r.inserted; unattributed += r.unattributed;
    }
    await recordRebuildRun("sales", { lastWindowFrom: dayKeys[0] ?? null, lastWindowTo: dayKeys[dayKeys.length - 1] ?? null,
      rowsDeleted, rowsInserted, unattributed, sourceWatermark: watermark, lastError: aborted ? "aborted: lease lost mid-run" : null });
    return { rowsDeleted, rowsInserted, unattributed, skipped: false };
  } catch (e) {
    await recordRebuildRun("sales", { lastError: String((e as Error).message) });
    throw e;
  } finally {
    await releaseRebuildLock("sales", token);
  }
}
