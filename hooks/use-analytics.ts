"use client";

import { useQuery } from "@tanstack/react-query";

// --- rebuild-state note (analytics hub) ------------------------------------

export interface RebuildState {
  unattributed: number;
}

// The single GLOBAL unattributed-orders note (last rebuild). Best-effort: a non-2xx is
// not an error, it just means "no note", so the hub is never blocked on it.
export function useAnalyticsRebuildState() {
  return useQuery<RebuildState>({
    queryKey: ["analytics-rebuild-state"],
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/analytics/rebuild-state", { signal });
      if (!res.ok) return { unattributed: 0 };
      const d = await res.json();
      return { unattributed: d?.unattributed ?? 0 };
    },
  });
}

// --- per-product analytics (product page) ----------------------------------

// Shape of GET /api/analytics/product/[id]. revenue is serialized to a string per-row
// by the API (Prisma Decimal -> string); other _sum fields are numbers.
export type StockPoint = { dayKey: string; locationId: number; quantity: number };
export type SalesRow = {
  productId?: number;
  _sum?: {
    orderedQty?: number | null;
    fulfilledQty?: number | null;
    revenue?: string | null;
    orderCount?: number | null;
  };
};
// Product identity for the D-L2 History-host header (added by the T5 route
// alongside the existing stock/sales payload). currentStock = GLOBAL sum across
// all locations (the physical pool). Optional so an older payload never crashes.
export type ProductIdentity = {
  name: string | null;
  baseName: string | null;
  variant: string | null;
  currentStock: number;
};
export type ProductAnalytics = {
  productId: number;
  product?: ProductIdentity | null;
  stock: { series: StockPoint[]; mode: string };
  sales: { series: SalesRow[]; mode: string; note: string };
};

// Shape of GET /api/analytics/sales?groupBy=day (one row per dayKey).
export type SalesDayRow = {
  dayKey: string;
  _sum?: { orderedQty?: number | null; revenue?: string | null };
};
export type SalesByDay = { series: SalesDayRow[]; mode: string; note: string };

export interface ProductAnalyticsScope {
  from?: string;
  to?: string;
  companyId?: string;
}

export interface ProductAnalyticsResult {
  product: ProductAnalytics;
  salesByDay: SalesByDay | null;
}

// Both reads for the per-product page in ONE query so they share a single loading/error
// gate keyed by [id, scope]. The per-product payload is required; the sales-by-day series
// is best-effort — a rejected fetch (null) OR a non-2xx must never blank the page.
export function useProductAnalytics(id: string | undefined, scope: ProductAnalyticsScope) {
  const { from, to, companyId } = scope;
  return useQuery<ProductAnalyticsResult>({
    queryKey: ["analytics-product", id, { from, to, companyId }],
    enabled: !!id,
    queryFn: async ({ signal }) => {
      // Thread the selected company + date range into BOTH reads (T5 route accepts them).
      const qp = new URLSearchParams();
      if (from) qp.set("from", from);
      if (to) qp.set("to", to);
      if (companyId) qp.set("companyId", companyId);

      // Sales as a time series for the chart (per-product payload's sales.series is a single
      // groupBy=product aggregate, not a day grain). groupBy=day gives one row per dayKey.
      const salesQp = new URLSearchParams(qp);
      salesQp.set("productId", id!);
      salesQp.set("groupBy", "day");

      const [productRes, salesRes] = await Promise.all([
        fetch(`/api/analytics/product/${id}?${qp.toString()}`, { signal }),
        // Best-effort: swallow a network rejection so a sales failure never blanks the page.
        fetch(`/api/analytics/sales?${salesQp.toString()}`, { signal }).catch(() => null),
      ]);

      if (!productRes.ok) throw new Error("Failed to load analytics");
      const product = (await productRes.json()) as ProductAnalytics;

      const salesByDay =
        salesRes && salesRes.ok ? ((await salesRes.json()) as SalesByDay) : null;

      return { product, salesByDay };
    },
  });
}
