"use client";

import { useState, useCallback, useMemo, useRef } from "react";
import { useParams } from "next/navigation";
import { useProductAnalytics, type StockPoint } from "@/hooks/use-analytics";
import { TrendingUp, TrendingDown, Minus, Download, ImageIcon } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkline } from "@/components/ui/sparkline";
import { CompanyScopeSelect } from "@/components/analytics/company-scope-select";
import {
  LineChartComponent,
  BarChartComponent,
} from "@/components/reports/inventory-chart";
import {
  exportToCSV,
  exportChartAsImage,
  generateExportFilename,
} from "@/lib/export-utils";

// Payload types (StockPoint, ProductAnalytics, SalesByDay, ...) live with the query hook
// in @/hooks/use-analytics; StockPoint is imported above for toStockChartData's signature.
const numberFormatter = new Intl.NumberFormat("en-US");
const formatUnits = (value?: number | null) => numberFormatter.format(value ?? 0);

// revenue arrives as a string (or null). Show it verbatim when present so we never
// reformat/round a value the API serialized deliberately; show a dash when absent.
function formatRevenue(value?: string | null) {
  if (value == null || value === "") return "—";
  return value;
}

// UTC-safe YYYY-MM-DD for the date-range default (never date-fns format(); dayKey is TZ-safe).
function toDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function daysAgoDayKey(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return toDayKey(d);
}

// Sum the per-location snapshot rows into ONE GLOBAL total per dayKey, day-ascending.
// The recharts LineChartComponent wrapper expects x-key `date` + series key `quantity`.
function toStockChartData(series: StockPoint[]): Array<{ date: string; quantity: number }> {
  const byDay = new Map<string, number>();
  for (const p of series) byDay.set(p.dayKey, (byDay.get(p.dayKey) ?? 0) + p.quantity);
  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, quantity]) => ({ date, quantity }));
}

export default function ProductAnalyticsPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  // Sales scope (memberships sum by default) + date-range (last 90 days, UTC YYYY-MM-DD).
  const [companyId, setCompanyId] = useState<string | undefined>(undefined);
  const [from, setFrom] = useState<string>(() => daysAgoDayKey(90));
  const [to, setTo] = useState<string>(() => toDayKey(new Date()));

  // One query drives both reads (per-product payload + best-effort sales-by-day), keyed by
  // [id, {from, to, companyId}] so a scope/date change refetches and is cached per scope.
  const analyticsQuery = useProductAnalytics(id, { from, to, companyId });
  const data = analyticsQuery.data?.product ?? null;
  const salesByDay = analyticsQuery.data?.salesByDay ?? null;
  const loading = analyticsQuery.isLoading;
  const error = analyticsQuery.isError ? "Could not load analytics for this product." : null;

  const stockSeries = useMemo(() => data?.stock.series ?? [], [data]);
  const salesSeries = useMemo(() => data?.sales.series ?? [], [data]);
  const hasData = stockSeries.length > 0 || salesSeries.length > 0;

  // Per-day GLOBAL stock totals -> chart data + trend (computed from the real series).
  const stockChartData = useMemo(() => toStockChartData(stockSeries), [stockSeries]);
  const stockTrend = useMemo(() => {
    if (stockChartData.length < 2) return null;
    const earliest = stockChartData[0].quantity;
    const latest = stockChartData[stockChartData.length - 1].quantity;
    const direction: "up" | "down" | "stable" =
      latest > earliest ? "up" : latest < earliest ? "down" : "stable";
    // Percent change vs the earliest day; guard divide-by-zero.
    const value =
      earliest === 0 ? 0 : Math.round((Math.abs(latest - earliest) / earliest) * 100);
    return { value, direction, levels: stockChartData.map((d) => d.quantity) };
  }, [stockChartData]);

  // Sales units-over-time for the bar chart (day grain). The wrapper's series keys are
  // stockIn/stockOut; relabel by mapping units onto stockIn so a single bar renders.
  const salesChartData = useMemo(
    () =>
      (salesByDay?.series ?? [])
        .slice()
        .sort((a, b) => a.dayKey.localeCompare(b.dayKey))
        .map((r) => ({ date: r.dayKey, stockIn: r._sum?.orderedQty ?? 0 })),
    [salesByDay],
  );

  // T9 export surface. The chart-PNG export needs a real DOM element: attach a ref to
  // the wrapping div around the stock line chart (mirrors the Reports page's chartRefs
  // pattern) and hand ref.current to exportChartAsImage (which runs html2canvas).
  const stockChartRef = useRef<HTMLDivElement | null>(null);

  const handleExportChart = useCallback(async () => {
    const el = stockChartRef.current;
    if (!el) return;
    await exportChartAsImage(el, generateExportFilename("product-analytics", "png"));
  }, []);

  // CSV of the per-day stock level joined with that day's ordered units (the two real
  // series on this page). Honest columns only: stock level (GLOBAL) + ordered units
  // (companies-scoped). Bundle revenue is deliberately NOT emitted (see the page note).
  const handleExportCsv = useCallback(() => {
    const ordersByDay = new Map<string, number>();
    for (const d of salesChartData) ordersByDay.set(d.date, d.stockIn);
    const days = new Set<string>([
      ...stockChartData.map((d) => d.date),
      ...salesChartData.map((d) => d.date),
    ]);
    const rows = Array.from(days)
      .sort((a, b) => a.localeCompare(b))
      .map((date) => ({
        date,
        stockQuantity: stockChartData.find((d) => d.date === date)?.quantity ?? "",
        orderedUnits: ordersByDay.get(date) ?? "",
      }));
    if (rows.length === 0) return;
    exportToCSV(
      rows,
      [
        { key: "date", label: "Date" },
        { key: "stockQuantity", label: "Stock Quantity" },
        { key: "orderedUnits", label: "Ordered Units" },
      ],
      generateExportFilename("product-analytics", "csv"),
    );
  }, [stockChartData, salesChartData]);

  return (
    <div className="flex flex-col h-full overflow-x-hidden">
      <div className="container mx-auto p-4 sm:p-6 space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Product Analytics</h1>
            <p className="text-sm text-muted-foreground">
              Stock and sales history for product #{id}.
            </p>
          </div>

          {/* Scope controls: company (sales only) + date range (both reads). */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">Company</label>
              <CompanyScopeSelect
                value={companyId}
                onChange={setCompanyId}
                className="w-full sm:w-56"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="from" className="text-xs font-medium text-muted-foreground">
                From
              </label>
              <input
                id="from"
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="to" className="text-xs font-medium text-muted-foreground">
                To
              </label>
              <input
                id="to"
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>
          </div>
        </div>

        {loading && (
          <div className="space-y-6">
            <Skeleton className="h-[380px] w-full rounded-2xl" />
            <Skeleton className="h-[380px] w-full rounded-2xl" />
          </div>
        )}

        {!loading && error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {!loading && !error && !hasData && (
          <div className="rounded-lg border border-border/70 bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
            No analytics yet for this product.
          </div>
        )}

        {!loading && !error && hasData && data && (
          <>
            {/* Export toolbar: chart PNG (of the stock chart) + series CSV. Only shown
                when there is real data to export (this whole block is hasData-gated). */}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleExportChart}
                disabled={stockChartData.length === 0}
              >
                <ImageIcon className="h-4 w-4" aria-hidden="true" />
                <span className="ml-1">Export chart (PNG)</span>
              </Button>
              <Button variant="outline" size="sm" onClick={handleExportCsv}>
                <Download className="h-4 w-4" aria-hidden="true" />
                <span className="ml-1">Export CSV</span>
              </Button>
            </div>

            {/* Stock level over time (per-day GLOBAL total) + trend indicator. */}
            {stockChartData.length === 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>Stock level over time</CardTitle>
                  <CardDescription>{data.stock.mode}</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    No stock snapshots recorded in this range.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-muted-foreground">
                    Stock trend
                  </span>
                  {stockTrend ? (
                    <span
                      className="inline-flex items-center gap-1 text-sm font-medium"
                      aria-label={`Stock trend ${stockTrend.direction} ${stockTrend.value} percent`}
                    >
                      {stockTrend.direction === "up" && (
                        <TrendingUp className="h-4 w-4 text-emerald-600" />
                      )}
                      {stockTrend.direction === "down" && (
                        <TrendingDown className="h-4 w-4 text-red-600" />
                      )}
                      {stockTrend.direction === "stable" && (
                        <Minus className="h-4 w-4 text-muted-foreground" />
                      )}
                      <span>{stockTrend.value}%</span>
                      <Sparkline data={stockTrend.levels} className="ml-1" />
                    </span>
                  ) : (
                    <span className="text-sm text-muted-foreground" aria-label="Stock trend unavailable">
                      —
                    </span>
                  )}
                </div>
                <div ref={stockChartRef}>
                  <LineChartComponent
                    data={stockChartData}
                    title="Stock level over time"
                    description={data.stock.mode}
                  />
                </div>
              </div>
            )}

            {/* Sales over time (day grain). Units only; revenue is direct-only (see note). */}
            <div className="space-y-2">
              {salesChartData.length === 0 ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Sales over time</CardTitle>
                    <CardDescription>{data.sales.mode}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <p className="text-sm text-muted-foreground">{data.sales.note}</p>
                    <p className="text-sm text-muted-foreground">
                      No sales recorded for your companies in this range.
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <>
                  <BarChartComponent
                    data={salesChartData}
                    title="Sales over time (ordered units)"
                    description={data.sales.mode}
                  />
                  <p className="px-1 text-sm text-muted-foreground">{data.sales.note}</p>
                </>
              )}
            </div>

            {/* Sales totals for the selected scope/range. Fulfilled is structurally 0 and is
                omitted entirely (truthful-data); we surface a one-line note instead. */}
            <Card>
              <CardHeader>
                <CardTitle>Sales totals</CardTitle>
                <CardDescription>{data.sales.mode}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {salesSeries.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No sales recorded for your companies in this range.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    {salesSeries.map((row, i) => (
                      <div key={`${row.productId ?? "row"}-${i}`} className="contents">
                        <div className="rounded-lg border border-border/70 p-4">
                          <p className="text-xs text-muted-foreground">Ordered units</p>
                          <p className="text-lg font-semibold">
                            {formatUnits(row._sum?.orderedQty)}
                          </p>
                        </div>
                        <div className="rounded-lg border border-border/70 p-4">
                          <p className="text-xs text-muted-foreground">Orders</p>
                          <p className="text-lg font-semibold">
                            {formatUnits(row._sum?.orderCount)}
                          </p>
                        </div>
                        <div className="rounded-lg border border-border/70 p-4">
                          <p className="text-xs text-muted-foreground">Revenue (direct)</p>
                          <p className="text-lg font-semibold">
                            {formatRevenue(row._sum?.revenue)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Fulfilled units are not yet populated in source data and are omitted.
                </p>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
