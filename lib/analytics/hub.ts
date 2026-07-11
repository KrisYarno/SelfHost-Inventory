import { effectiveLowStockThreshold, isLowStock } from "@/lib/stock-threshold";

// Canonical owner of StockTrend (shared with lib/analytics/product-trends.ts).
export type StockTrend = { value: number; direction: "up" | "down" | "stable" };

export interface HubProductRow {
  productId: number;
  name: string;
  currentStock: number;          // SUM(product_locations.quantity), GLOBAL, as-of-now
  units: number;                 // SUM(orderedQty) over [companies, dateRange]; 0 when no sales
  orderCount: number;            // SUM(orderCount) at groupBy=product = "orders containing this product"; 0 when none
  revenue: string;               // Decimal-serialized string; "0.00" (never null) when no sales
  productStockTrend: StockTrend | null;  // null when <2 distinct snapshot days in range
}

export interface HubResponse {
  products: HubProductRow[];
  total: number;
  page: number;
  pageSize: number;
}

export type HubSort = "units" | "revenue" | "name" | "stock";
export type HubDir = "asc" | "desc";
export type HubFilter = "all" | "in" | "low" | "out";

export interface HubMergeInput {
  candidates: Array<{ id: number; name: string; lowStockThreshold: number | null }>;
  stockByProduct: Map<number, number>;             // productId -> SUM(quantity)
  salesByProduct: Map<number, { units: number; orderCount: number; revenue: string }>;
  trendByProduct: Map<number, StockTrend | null>;
  filter: HubFilter;
  sort: HubSort;
  dir: HubDir;
  page: number;
  pageSize: number;
  // System-wide default a product inherits when its lowStockThreshold is NULL
  // (spec R-L13). The route resolves it via getLowStockDefault().
  lowStockDefault: number;
}

// Merge the batched reads into rows, apply the stock-status filter over the FULL set,
// sort the FULL set, THEN paginate. Never paginate before sort (units/revenue would be wrong).
export function buildHubRows(input: HubMergeInput): HubResponse {
  const { candidates, stockByProduct, salesByProduct, trendByProduct } = input;

  const merged: HubProductRow[] = candidates.map((p) => {
    const sales = salesByProduct.get(p.id);
    return {
      productId: p.id,
      name: p.name,
      currentStock: stockByProduct.get(p.id) ?? 0,
      units: sales?.units ?? 0,
      orderCount: sales?.orderCount ?? 0,
      revenue: sales?.revenue ?? "0.00",
      productStockTrend: trendByProduct.get(p.id) ?? null,
    };
  });

  // Stock-status filter via the shared inheritance model + INCLUSIVE predicate
  // (spec R-L13): low ⇔ isLowStock over the product's effective threshold, so a
  // product at exactly its threshold now counts (unified with every other surface).
  const filtered = merged.filter((r) => {
    const productThreshold =
      candidates.find((c) => c.id === r.productId)?.lowStockThreshold;
    const effective = effectiveLowStockThreshold(productThreshold, input.lowStockDefault);
    switch (input.filter) {
      case "in":
        return r.currentStock > 0;
      case "low":
        return isLowStock(r.currentStock, effective);
      case "out":
        return r.currentStock === 0;
      default:
        return true;
    }
  });

  // Sort the FULL filtered set. revenue is a numeric string -> compare as Number.
  const factor = input.dir === "asc" ? 1 : -1;
  filtered.sort((a, b) => {
    let cmp: number;
    switch (input.sort) {
      case "name":
        cmp = a.name.localeCompare(b.name);
        break;
      case "stock":
        cmp = a.currentStock - b.currentStock;
        break;
      case "revenue":
        cmp = Number(a.revenue) - Number(b.revenue);
        break;
      case "units":
      default:
        cmp = a.units - b.units;
        break;
    }
    // Deterministic tiebreak so equal/zero metrics keep a stable order across pages.
    if (cmp === 0) return a.productId - b.productId;
    return cmp * factor;
  });

  const total = filtered.length;
  const start = (input.page - 1) * input.pageSize;
  const products = filtered.slice(start, start + input.pageSize);
  return { products, total, page: input.page, pageSize: input.pageSize };
}
