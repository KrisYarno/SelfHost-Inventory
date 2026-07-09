import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import { enforceRateLimit, applyRateLimitHeaders } from "@/lib/rateLimit";
import prisma from "@/lib/prisma";
import { getSales } from "@/lib/analytics/queries";
import { resolveCallerCompanyIds } from "@/lib/analytics/company-scope";
import { getProductStockTrends } from "@/lib/analytics/product-trends";
import {
  buildHubRows,
  HubSort,
  HubDir,
  HubFilter,
  StockTrend,
} from "@/lib/analytics/hub";

export const dynamic = "force-dynamic";

const SORTS: HubSort[] = ["units", "revenue", "name", "stock"];
const FILTERS: HubFilter[] = ["all", "in", "low", "out"];

// Searchable/sortable/paginated product list with per-product rollups for the analytics hub.
//   - Stock is GLOBAL (requireApproved); a zero-membership caller still sees stock.
//   - Sales is companyId-scoped: omit companyId => sum across the caller's OWN companies;
//     explicit companyId => requireCompanyMembership (admins bypass; 404 on non-member);
//     empty memberships => getSales returns [] (no leak, no 403).
//   - Current-state list excludes soft-deleted + PENDING_REVIEW (POSITIVE approvalStatus filter).
//   - enforceRateLimit guards the per-request groupBy cost (read-only DoS guard).
export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();
  const headers = enforceRateLimit(request, "analytics-products:GET", { identifier: user.id });

  const sp = request.nextUrl.searchParams;
  const search = sp.get("search")?.trim() || "";
  const filter: HubFilter = FILTERS.includes(sp.get("filter") as HubFilter)
    ? (sp.get("filter") as HubFilter)
    : "all";
  const sort: HubSort = SORTS.includes(sp.get("sort") as HubSort)
    ? (sp.get("sort") as HubSort)
    : "units";
  const dir: HubDir = sp.get("dir") === "asc" ? "asc" : "desc";
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(sp.get("pageSize") || "25", 10)));
  const from = sp.get("from") ?? undefined;
  const to = sp.get("to") ?? undefined;
  const companyId = sp.get("companyId");

  // Resolve the company scope (sales only; stock is GLOBAL).
  const companyIds = await resolveCallerCompanyIds(user, companyId);

  // 1) FULL candidate set: current real products after search + current-state filter.
  //    NOT a page — sort/filter happen after the sales merge (ER mechanical correction).
  const candidates = await prisma.product.findMany({
    where: {
      deletedAt: null,
      approvalStatus: "APPROVED",
      ...(search
        ? {
            OR: [
              { name: { contains: search } },
              { baseName: { contains: search } },
              { variant: { contains: search } },
            ],
          }
        : {}),
    },
    select: { id: true, name: true, lowStockThreshold: true },
    orderBy: { name: "asc" },
  });
  const productIds = candidates.map((c) => c.id);

  // Short-circuit: no products -> empty page (no downstream queries).
  if (productIds.length === 0) {
    return applyRateLimitHeaders(
      NextResponse.json({ products: [], total: 0, page, pageSize }),
      headers
    );
  }

  // 2) Batch the three rollup reads in parallel.
  const [stockRows, salesRows, trendByProduct] = await Promise.all([
    // (a) GLOBAL current stock SUM per product (independent of date range).
    prisma.product_locations.groupBy({
      by: ["productId"],
      where: { productId: { in: productIds } },
      _sum: { quantity: true },
    }),
    // (b) Sales groupBy productId over [candidate ids, dateRange, member companies].
    //     getSales returns [] when companyIds is empty (hard isolation).
    getSales({ companyIds, from, to, groupBy: "product" }),
    // (c) Per-product stock-trend (NEW aggregate read; <2 distinct days -> null).
    getProductStockTrends(productIds, from, to),
  ]);

  // Merge maps. getSales is groupBy=product => one row per productId in scope.
  const stockByProduct = new Map<number, number>();
  for (const r of stockRows) stockByProduct.set(r.productId, r._sum.quantity ?? 0);

  const salesByProduct = new Map<
    number,
    { units: number; orderCount: number; revenue: string }
  >();
  for (const r of salesRows as unknown as Array<{
    productId: number;
    _sum: { orderedQty: number | null; orderCount: number | null; revenue: unknown };
  }>) {
    salesByProduct.set(r.productId, {
      units: r._sum.orderedQty ?? 0,
      orderCount: r._sum.orderCount ?? 0,
      // Serialize Decimal -> string here; default "0.00" lives in buildHubRows for missing rows.
      revenue: r._sum.revenue != null ? String(r._sum.revenue) : "0.00",
    });
  }

  const body = buildHubRows({
    candidates,
    stockByProduct,
    salesByProduct,
    trendByProduct: trendByProduct as Map<number, StockTrend | null>,
    filter,
    sort,
    dir,
    page,
    pageSize,
  });

  return applyRateLimitHeaders(NextResponse.json(body), headers);
});
