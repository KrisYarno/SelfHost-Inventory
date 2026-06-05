import prisma from "@/lib/prisma";

export type SalesGroupBy = "product" | "day" | "integration" | "company";

/** Company-scoped sales read. ALWAYS constrains companyId IN companyIds; empty companyIds -> [] (hard isolation). */
export async function getSales(opts: { companyIds: string[]; productId?: number; from?: string; to?: string; groupBy?: SalesGroupBy }) {
  if (opts.companyIds.length === 0) return [];
  const where: any = { companyId: { in: opts.companyIds } };
  if (opts.productId) where.productId = opts.productId;
  if (opts.from || opts.to) where.dayKey = { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) };
  const BY: Record<SalesGroupBy, string[]> = {
    product: ["productId"], day: ["dayKey"], integration: ["integrationId"], company: ["companyId", "dayKey"],
  };
  const groupBy = opts.groupBy ?? "product";
  const by = BY[groupBy] ?? BY.product;
  // orderCount per fact row = distinct orders for ONE (product,company,integration,day) grain.
  // Summing it across PRODUCTS (day/integration/company) double-counts a multi-product order,
  // and the correct value can't be recomputed from the fact (no distinct order IDs). So only
  // sum orderCount when grouping BY product (where every summed row shares the same product =
  // "orders containing this product"); OMIT it otherwise so we never emit a wrong number.
  const _sum: { orderedQty: true; fulfilledQty: true; revenue: true; orderCount?: true } = {
    orderedQty: true, fulfilledQty: true, revenue: true,
  };
  if (groupBy === "product") _sum.orderCount = true;
  return prisma.productSalesFact.groupBy({
    by: by as any,
    where,
    _sum,
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
