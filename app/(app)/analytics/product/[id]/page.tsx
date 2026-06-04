"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";

// Shape of GET /api/analytics/product/[id]. revenue is serialized to a string
// per-row by the API (Prisma Decimal -> string); other _sum fields are numbers.
type StockPoint = { dayKey: string; locationId: number; quantity: number };
type SalesRow = {
  productId?: number;
  _sum?: {
    orderedQty?: number | null;
    fulfilledQty?: number | null;
    revenue?: string | null;
    orderCount?: number | null;
  };
};
type ProductAnalytics = {
  productId: number;
  stock: { series: StockPoint[]; mode: string };
  sales: { series: SalesRow[]; mode: string; note: string };
};

const numberFormatter = new Intl.NumberFormat("en-US");
const formatUnits = (value?: number | null) => numberFormatter.format(value ?? 0);

// revenue arrives as a string (or null). Show it verbatim when present so we never
// reformat/round a value the API serialized deliberately; show a dash when absent.
function formatRevenue(value?: string | null) {
  if (value == null || value === "") return "—";
  return value;
}

export default function ProductAnalyticsPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [data, setData] = useState<ProductAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAnalytics = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/analytics/product/${id}`);
      if (!response.ok) throw new Error("Failed to load analytics");
      const json = (await response.json()) as ProductAnalytics;
      setData(json);
    } catch (err) {
      console.error("Error fetching product analytics:", err);
      setError("Could not load analytics for this product.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  const stockSeries = data?.stock.series ?? [];
  const salesSeries = data?.sales.series ?? [];
  const hasData = stockSeries.length > 0 || salesSeries.length > 0;

  return (
    <div className="flex flex-col h-full overflow-x-hidden">
      <div className="container mx-auto p-4 sm:p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Product Analytics</h1>
          <p className="text-sm text-muted-foreground">
            Stock and sales history for product #{id}.
          </p>
        </div>

        {loading && (
          <p className="text-sm text-muted-foreground">Loading analytics…</p>
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
            {/* Stock level over time */}
            <Card>
              <CardHeader>
                <CardTitle>Stock level over time</CardTitle>
                <CardDescription>{data.stock.mode}</CardDescription>
              </CardHeader>
              <CardContent>
                {stockSeries.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No stock snapshots recorded yet.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Day</TableHead>
                        <TableHead>Location</TableHead>
                        <TableHead className="text-right">Quantity</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {stockSeries.map((point, i) => (
                        <TableRow key={`${point.dayKey}-${point.locationId}-${i}`}>
                          <TableCell>{point.dayKey}</TableCell>
                          <TableCell>{point.locationId}</TableCell>
                          <TableCell className="text-right">
                            {formatUnits(point.quantity)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            {/* Units in/out + net — not in this payload yet. Do not fabricate. */}
            <Card>
              <CardHeader>
                <CardTitle>Units in / out + net</CardTitle>
                <CardDescription>Movement flows</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Movement flows: coming in a later pass. The current analytics payload
                  reports stock snapshots and sales totals only.
                </p>
              </CardContent>
            </Card>

            {/* Sales */}
            <Card>
              <CardHeader>
                <CardTitle>Sales</CardTitle>
                <CardDescription>{data.sales.mode}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">{data.sales.note}</p>
                {salesSeries.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No sales recorded for your companies yet.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-right">Ordered units</TableHead>
                        <TableHead className="text-right">Fulfilled units</TableHead>
                        <TableHead className="text-right">Orders</TableHead>
                        <TableHead className="text-right">Revenue (direct)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {salesSeries.map((row, i) => (
                        <TableRow key={`${row.productId ?? "row"}-${i}`}>
                          <TableCell className="text-right">
                            {formatUnits(row._sum?.orderedQty)}
                          </TableCell>
                          <TableCell className="text-right">
                            {formatUnits(row._sum?.fulfilledQty)}
                          </TableCell>
                          <TableCell className="text-right">
                            {formatUnits(row._sum?.orderCount)}
                          </TableCell>
                          <TableCell className="text-right">
                            {formatRevenue(row._sum?.revenue)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
