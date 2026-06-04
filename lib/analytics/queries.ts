import prisma from "@/lib/prisma";

export type SalesGroupBy = "product" | "day" | "integration" | "company";

/** Company-scoped sales read. ALWAYS constrains companyId IN companyIds; empty companyIds -> [] (hard isolation). */
export async function getSales(opts: { companyIds: string[]; productId?: number; from?: string; to?: string; groupBy?: SalesGroupBy }) {
  if (opts.companyIds.length === 0) return [];
  const where: any = { companyId: { in: opts.companyIds } };
  if (opts.productId) where.productId = opts.productId;
  if (opts.from || opts.to) where.dayKey = { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) };
  const by: Record<SalesGroupBy, string[]> = {
    product: ["productId"], day: ["dayKey"], integration: ["integrationId"], company: ["companyId", "dayKey"],
  };
  return prisma.productSalesFact.groupBy({
    by: by[opts.groupBy ?? "product"] as any,
    where,
    _sum: { orderedQty: true, fulfilledQty: true, revenue: true, orderCount: true },
  });
}

/** GLOBAL stock-level series from snapshots (no company scoping — inventory is GLOBAL). */
export async function getStockSeries(opts: { productId?: number; locationId?: number; from?: string; to?: string }) {
  const where: any = {};
  if (opts.productId) where.productId = opts.productId;
  if (opts.locationId) where.locationId = opts.locationId;
  if (opts.from || opts.to) where.dayKey = { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) };
  return prisma.productStockSnapshot.findMany({
    where, orderBy: [{ dayKey: "asc" }, { locationId: "asc" }],
    select: { dayKey: true, locationId: true, quantity: true },
  });
}
