import prisma from "@/lib/prisma";
import { saleDayKey, dayKeyRange, dayKeyStart, nextDayStart, toDayKey } from "./dates";
import { attributeOrderItems, AttributableItem } from "./attribution";
import { acquireRebuildLock, heartbeatRebuildLock, releaseRebuildLock, recordRebuildRun } from "./rebuild-lock";

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

/** Nightly (updatedAt window) or weekly true-full rebuild. Locked + heartbeated. Idempotent. */
export async function rebuildSalesFacts(opts: { since?: Date; full?: boolean; companyId?: string } = {}): Promise<{ rowsDeleted: number; rowsInserted: number; unattributed: number }> {
  const token = await acquireRebuildLock("sales");
  if (!token) return { rowsDeleted: 0, rowsInserted: 0, unattributed: 0 };
  let rowsDeleted = 0, rowsInserted = 0, unattributed = 0, watermark: Date | null = null, aborted = false;
  try {
    let dayKeys: string[];
    if (opts.full) {
      const earliest = await prisma.externalOrder.findFirst({ orderBy: { createdAt: "asc" }, select: { externalCreatedAt: true, createdAt: true } });
      dayKeys = earliest ? dayKeyRange(saleDayKey(earliest), toDayKey(new Date())) : [];
    } else {
      const since = opts.since ?? new Date(Date.now() - 36 * 60 * 60 * 1000);
      const touched = await prisma.externalOrder.findMany({ where: { updatedAt: { gte: since }, ...(opts.companyId ? { companyId: opts.companyId } : {}) },
        select: { externalCreatedAt: true, createdAt: true, updatedAt: true } });
      dayKeys = collectTouchedDayKeys(touched);
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
    return { rowsDeleted, rowsInserted, unattributed };
  } catch (e) {
    await recordRebuildRun("sales", { lastError: String((e as Error).message) });
    throw e;
  } finally {
    await releaseRebuildLock("sales", token);
  }
}
