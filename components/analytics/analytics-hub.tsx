"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { CompanyScopeSelect } from "@/components/analytics/company-scope-select";
import { useAnalyticsProducts } from "@/hooks/use-analytics-products";
import type { HubProductRow, HubSort, HubDir, HubFilter, StockTrend } from "@/lib/analytics/hub";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable } from "@/components/ui/data-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { exportToCSV, generateExportFilename } from "@/lib/export-utils";
import { cn } from "@/lib/utils";
import { Search, X, Download, ArrowUp, ArrowDown, Minus, ArrowUpDown } from "lucide-react";

const PAGE_SIZE = 25;

// Last-90-days default window in UTC YYYY-MM-DD (dayKey-safe; never date-fns format()).
function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 90);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

const numberFormatter = new Intl.NumberFormat("en-US");
const fmt = (n: number) => numberFormatter.format(n);

// The trend is a {value, direction} object (NOT a numeric series), so render a directional
// arrow + percentage rather than a sparkline. null => "—" (under 2 distinct snapshot days).
function TrendCell({ trend }: { trend: StockTrend | null }) {
  if (!trend) return <span className="text-muted-foreground">—</span>;
  const { direction, value } = trend;
  if (direction === "stable" || value === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Minus className="h-3.5 w-3.5" aria-hidden />
        <span className="sr-only">stable</span>
        {value}%
      </span>
    );
  }
  const up = direction === "up";
  return (
    <span
      className={`inline-flex items-center gap-1 ${up ? "text-green-600" : "text-red-600"}`}
    >
      {up ? (
        <ArrowUp className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <ArrowDown className="h-3.5 w-3.5" aria-hidden />
      )}
      <span className="sr-only">{up ? "up" : "down"}</span>
      {value}%
    </span>
  );
}

// One labeled metric inside a mobile card's 2-col grid. `min-w-0` lets the revenue value
// truncate inside the grid track; counts use `fmt`, revenue is passed through verbatim.
function Metric({
  label,
  value,
  isRevenue,
}: {
  label: string;
  value: string;
  isRevenue?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn("tabular-nums text-foreground", isRevenue && "truncate")}
        title={isRevenue ? value : undefined}
      >
        {value}
      </dd>
    </div>
  );
}

// Mobile presentation of a hub row (shown md:hidden; the table is the md+ presentation).
// The WHOLE card is the link to the same per-product page the table/movers use, so it is a
// single 44px+ focus target. Trend reuses TrendCell and is explicitly labeled "Stock trend"
// so the % is not mis-attributed to a metric. Revenue is rendered verbatim (never reformat).
function MobileProductCard({ product }: { product: HubProductRow }) {
  return (
    <Link
      href={`/analytics/product/${product.productId}`}
      className="block rounded-lg border border-border bg-surface p-4 shadow-sm transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-medium text-primary">{product.name}</span>
        <span className="shrink-0 inline-flex items-center gap-1 text-xs text-muted-foreground">
          Stock trend <TrendCell trend={product.productStockTrend} />
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <Metric label="Current stock" value={fmt(product.currentStock)} />
        <Metric label="Units sold" value={fmt(product.units)} />
        <Metric label="Orders" value={fmt(product.orderCount)} />
        <Metric label="Revenue" value={product.revenue} isRevenue />
      </dl>
    </Link>
  );
}

const SORT_LABELS: Record<HubSort, string> = {
  units: "Units sold",
  revenue: "Revenue",
  name: "Name",
  stock: "Current stock",
};

const FILTER_LABELS: Record<HubFilter, string> = {
  all: "All stock",
  in: "In stock",
  low: "Low stock",
  out: "Out of stock",
};

// The hub CSV column contract (T9), kept as an exported pure helper so the column
// set is unit-testable without rendering the hub. Mirrors the visible table's core
// metrics; the stock-trend (a {direction,value} object, not a scalar) is appended
// as a serialized label in the export handler below, not part of this contract.
export function buildHubCsvColumns(): { key: string; label: string }[] {
  return [
    { key: "name", label: "Product" },
    { key: "currentStock", label: "Current Stock" },
    { key: "units", label: "Units Sold" },
    { key: "orderCount", label: "Orders" },
    { key: "revenue", label: "Revenue (direct)" },
  ];
}

export function AnalyticsHub() {
  const initial = useMemo(() => defaultRange(), []);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<HubFilter>("all");
  const [sort, setSort] = useState<HubSort>("units");
  const [dir, setDir] = useState<HubDir>("desc");
  const [page, setPage] = useState(1);
  const [companyId, setCompanyId] = useState<string | undefined>(undefined);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);

  // The single GLOBAL unattributed-orders note (last rebuild). Surfaced once, not per row.
  const [unattributed, setUnattributed] = useState(0);
  useEffect(() => {
    let active = true;
    fetch("/api/analytics/rebuild-state")
      .then((r) => (r.ok ? r.json() : { unattributed: 0 }))
      .then((d) => {
        if (active) setUnattributed(d?.unattributed ?? 0);
      })
      .catch(() => {
        /* note is best-effort; never block the hub on it */
      });
    return () => {
      active = false;
    };
  }, []);

  const { data, isLoading, isError, isFetching, refetch } = useAnalyticsProducts({
    search,
    filter,
    sort,
    dir,
    page,
    pageSize: PAGE_SIZE,
    companyId,
    from,
    to,
  });

  const products = data?.products ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasActiveQuery = search.trim() !== "" || filter !== "all";

  // Honest "not yet materialized" signal: products exist but every row has zero sales AND no
  // trend. Covers both pre-backfill and a zero-membership caller (who sees stock, no sales).
  const noSalesData =
    products.length > 0 &&
    products.every(
      (p) => p.units === 0 && Number(p.revenue) === 0 && p.productStockTrend === null
    );

  const handleExport = () => {
    if (products.length === 0) return;
    const rowsForCsv = products.map((p) => ({
      ...p,
      trendLabel: p.productStockTrend
        ? `${p.productStockTrend.direction} ${p.productStockTrend.value}%`
        : "n/a",
    }));
    // Core columns are the testable T9 contract; the serialized stock-trend is appended.
    const columns = [...buildHubCsvColumns(), { key: "trendLabel", label: "Stock Trend" }];
    exportToCSV(rowsForCsv, columns, generateExportFilename("analytics-products", "csv"));
  };

  const toggleDir = () => {
    setDir((d) => (d === "asc" ? "desc" : "asc"));
    setPage(1);
  };

  // Top-N movers: the list is already sorted by the active sort (default units desc) and is
  // post-filter, so the head of the page is the top movers under the current scope/filter.
  const movers = products.slice(0, 5);

  const columns = [
    {
      key: "name",
      header: "Product",
      cell: (p: HubProductRow) => (
        <Link
          href={`/analytics/product/${p.productId}`}
          className="font-medium text-primary hover:underline"
        >
          {p.name}
        </Link>
      ),
    },
    {
      key: "currentStock",
      header: "Current stock",
      className: "text-right",
      cell: (p: HubProductRow) => fmt(p.currentStock),
    },
    {
      key: "units",
      header: "Units sold",
      className: "text-right",
      cell: (p: HubProductRow) => fmt(p.units),
    },
    {
      key: "orderCount",
      header: "Orders",
      className: "text-right",
      cell: (p: HubProductRow) => fmt(p.orderCount),
    },
    {
      key: "revenue",
      header: "Revenue",
      className: "text-right",
      // revenue is a deliberately-serialized string; show verbatim, never reformat/round.
      cell: (p: HubProductRow) => p.revenue,
    },
    {
      key: "productStockTrend",
      header: "Stock trend",
      className: "text-right",
      cell: (p: HubProductRow) => <TrendCell trend={p.productStockTrend} />,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search products..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="pl-10 pr-10"
              aria-label="Search products"
            />
            {search && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch("");
                  setPage(1);
                }}
                className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 p-0"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>

          <CompanyScopeSelect
            value={companyId}
            onChange={(id) => {
              setCompanyId(id);
              setPage(1);
            }}
            className="w-full sm:w-48"
          />

          <Select
            value={filter}
            onValueChange={(v) => {
              setFilter(v as HubFilter);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-full sm:w-40" aria-label="Stock status filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(FILTER_LABELS) as HubFilter[]).map((f) => (
                <SelectItem key={f} value={f}>
                  {FILTER_LABELS[f]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-1">
            <Select
              value={sort}
              onValueChange={(v) => {
                setSort(v as HubSort);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Sort by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SORT_LABELS) as HubSort[]).map((s) => (
                  <SelectItem key={s} value={s}>
                    {SORT_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={toggleDir}
              aria-label={dir === "asc" ? "Sort ascending" : "Sort descending"}
              title={dir === "asc" ? "Ascending" : "Descending"}
            >
              <ArrowUpDown className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
              className="w-full sm:w-40"
              aria-label="From date"
            />
            <span className="text-muted-foreground">to</span>
            <Input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(1);
              }}
              className="w-full sm:w-40"
              aria-label="To date"
            />
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={handleExport}
          disabled={products.length === 0}
          className="shrink-0"
        >
          <Download className="h-4 w-4" />
          <span className="ml-1 hidden sm:inline">Export CSV</span>
        </Button>
      </div>

      {/* Global unattributed-orders note (single, hub-level; only when > 0). */}
      {unattributed > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-300">
          {fmt(unattributed)} {unattributed === 1 ? "order" : "orders"} unattributed in the last
          rebuild (could not be matched to a product, so they are not counted in the totals below).
        </div>
      )}

      {/* Not-yet-backfilled / zero-membership note: stock shows, sales are all zero. */}
      {!isLoading && !isError && noSalesData && (
        <div className="rounded-lg border border-border/70 bg-muted/30 px-4 py-2 text-sm text-muted-foreground">
          No sales analytics for this scope and date range yet. Stock is shown; sales totals will
          appear once orders are attributed for your companies.
        </div>
      )}

      {/* Top-N movers card */}
      {!isLoading && !isError && movers.length > 0 && (
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-sm">
              Top movers by {SORT_LABELS[sort].toLowerCase()}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <ol className="space-y-1.5">
              {movers.map((p, i) => (
                <li
                  key={p.productId}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="w-4 text-right text-muted-foreground">{i + 1}</span>
                    <Link
                      href={`/analytics/product/${p.productId}`}
                      className="truncate text-primary hover:underline"
                    >
                      {p.name}
                    </Link>
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {sort === "revenue"
                      ? p.revenue
                      : sort === "stock"
                        ? `${fmt(p.currentStock)} in stock`
                        : sort === "name"
                          ? `${fmt(p.units)} units`
                          : `${fmt(p.units)} units`}
                  </span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}

      {/* Body: loading / error / empty / table */}
      {isLoading ? (
        <div data-testid="analytics-hub-loading" className="space-y-2">
          <Skeleton className="h-10 w-full" />
          {[...Array(8)].map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : isError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-8 text-center">
          <p className="text-sm text-destructive">Could not load analytics.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()} className="mt-3">
            Retry
          </Button>
        </div>
      ) : total === 0 && !hasActiveQuery ? (
        <div className="rounded-lg border border-border/70 bg-muted/30 px-4 py-12 text-center text-sm text-muted-foreground">
          No products yet.
        </div>
      ) : (
        <>
          {/* md+: the table. */}
          <div className="hidden md:block">
            <DataTable
              data={products as unknown as Record<string, unknown>[]}
              columns={columns as never}
              emptyMessage={
                hasActiveQuery ? "No products match your filters." : "No products yet."
              }
            />
          </div>

          {/* mobile: stacked cards (same data/links/values, swapped at the md breakpoint).
              Mirrors the DataTable emptyMessage so a no-match filter shows the same copy
              on mobile. Under jsdom both presentations render — that is expected. */}
          <div data-testid="analytics-hub-cards" className="space-y-3 md:hidden">
            {products.length === 0 ? (
              <div className="rounded-lg border border-border/70 bg-muted/30 px-4 py-12 text-center text-sm text-muted-foreground">
                {hasActiveQuery ? "No products match your filters." : "No products yet."}
              </div>
            ) : (
              products.map((p) => <MobileProductCard key={p.productId} product={p} />)
            )}
          </div>

          {/* Pagination */}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-center gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1 || isFetching}
              >
                Previous
              </Button>
              <span className="px-2 text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= totalPages || isFetching}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
