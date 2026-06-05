import prisma from "@/lib/prisma";
import { calculateTrend } from "@/lib/metrics/warehouse-metrics";

// StockTrend is owned by lib/analytics/hub.ts (T1). It is inlined here so this helper
// builds standalone when T2 lands before T1 (see the plan's T2 sequencing note). The
// shape is identical to hub.ts's export, so the two stay structurally compatible; swap
// to `import type { StockTrend } from "@/lib/analytics/hub"` once hub.ts exists.
export type StockTrend = { value: number; direction: "up" | "down" | "stable" };

// Batched per-product stock-trend for the hub. ONE groupBy over product_stock_snapshots,
// SUMMING all location snapshots per (productId, dayKey) to a per-day GLOBAL level, then
// per product: <2 distinct days => null; else calculateTrend(latestDay, earliestDay).
//
// This is a NEW aggregate read. The existing getStockSeries returns RAW per-location rows;
// do NOT reuse it row-wise (it would double-count multi-location products per day).
export async function getProductStockTrends(
  productIds: number[],
  from?: string,
  to?: string
): Promise<Map<number, StockTrend | null>> {
  const result = new Map<number, StockTrend | null>();
  if (productIds.length === 0) return result;

  const where: {
    productId: { in: number[] };
    dayKey?: { gte?: string; lte?: string };
  } = { productId: { in: productIds } };
  if (from || to) where.dayKey = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };

  // SUM locations per (productId, dayKey) => one per-day GLOBAL level per product.
  const rows = await prisma.productStockSnapshot.groupBy({
    by: ["productId", "dayKey"],
    where,
    _sum: { quantity: true },
    orderBy: [{ productId: "asc" }, { dayKey: "asc" }],
  });

  // Bucket the per-day levels by product (already day-ascending from orderBy).
  const byProduct = new Map<number, Array<{ dayKey: string; level: number }>>();
  for (const r of rows) {
    const arr = byProduct.get(r.productId) ?? [];
    arr.push({ dayKey: r.dayKey, level: r._sum.quantity ?? 0 });
    byProduct.set(r.productId, arr);
  }

  for (const pid of productIds) {
    const days = byProduct.get(pid);
    if (!days || days.length < 2) {
      result.set(pid, null); // <2 distinct snapshot days => no trend
      continue;
    }
    const earliest = days[0].level;
    const latest = days[days.length - 1].level;
    result.set(pid, calculateTrend(latest, earliest));
  }
  return result;
}
