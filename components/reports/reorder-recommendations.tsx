"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { AlertTriangle, Package, Download, Info } from "lucide-react";
import { useReportsReorder } from "@/hooks/use-reports";
import type { ReorderRow, ReorderUrgency } from "@/lib/reports/reorder";

const URGENCY_CONFIG: Record<
  ReorderUrgency,
  { label: string; variant: "destructive" | "warning" | "secondary" | "default"; rank: number }
> = {
  OUT: { label: "Out of stock", variant: "destructive", rank: 4 },
  CRITICAL: { label: "Critical", variant: "destructive", rank: 3 },
  REORDER_NOW: { label: "Reorder now", variant: "warning", rank: 2 },
  APPROACHING: { label: "Approaching", variant: "secondary", rank: 1 },
};

const REASON_LABEL: Record<"no_demand_signal" | "insufficient_history", string> = {
  no_demand_signal: "No demand signal — no outbound movement to base a suggestion on",
  insufficient_history: "Insufficient history — too few movements to stand behind a number",
};

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

function num(n: number, digits = 1): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}

export function ReorderRecommendations() {
  const [urgencyFilter, setUrgencyFilter] = useState<"all" | ReorderUrgency>("all");
  const { data, isLoading, error: queryError } = useReportsReorder({ includeOkay: true });
  const error = queryError instanceof Error ? queryError.message : null;

  const suggested = useMemo(
    () =>
      (data?.rows ?? []).filter(
        (r): r is Extract<ReorderRow, { status: "suggested" }> => r.status === "suggested",
      ),
    [data],
  );
  const unavailable = useMemo(
    () =>
      (data?.rows ?? []).filter(
        (r): r is Extract<ReorderRow, { status: "unavailable" }> => r.status === "unavailable",
      ),
    [data],
  );

  const filteredSuggested = useMemo(
    () => (urgencyFilter === "all" ? suggested : suggested.filter((r) => r.urgency === urgencyFilter)),
    [suggested, urgencyFilter],
  );

  const counts = useMemo(() => {
    const c: Record<ReorderUrgency, number> = { OUT: 0, CRITICAL: 0, REORDER_NOW: 0, APPROACHING: 0 };
    for (const r of suggested) c[r.urgency] += 1;
    return c;
  }, [suggested]);

  const orderValueTotal = useMemo(
    () => suggested.reduce((sum, r) => sum + (r.orderValue ?? 0), 0),
    [suggested],
  );
  const uncostedCount = suggested.filter((r) => r.orderValue === null).length;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Reorder report</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <Skeleton className="h-[60px] w-full" />
            <Skeleton className="h-[400px] w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Reorder report</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Error: {error}</p>
        </CardContent>
      </Card>
    );
  }

  const assumptions = data?.assumptions;

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-4">
        <Card className={cn(counts.OUT + counts.CRITICAL > 0 && "border-negative bg-negative-muted/30")}>
          <CardContent className="p-4">
            <div className="text-2xl font-bold">{counts.OUT + counts.CRITICAL}</div>
            <div className="text-xs text-muted-foreground">Out / Critical</div>
          </CardContent>
        </Card>
        <Card className={cn(counts.REORDER_NOW > 0 && "border-warning bg-warning-muted/30")}>
          <CardContent className="p-4">
            <div className="text-2xl font-bold">{counts.REORDER_NOW}</div>
            <div className="text-xs text-muted-foreground">Reorder now</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-2xl font-bold">{counts.APPROACHING}</div>
            <div className="text-xs text-muted-foreground">Approaching</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-2xl font-bold">{currency.format(orderValueTotal)}</div>
            <div className="text-xs text-muted-foreground">
              Order value{uncostedCount > 0 ? ` (${uncostedCount} uncosted)` : ""}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Suggested worklist */}
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Package className="h-5 w-5" />
                Reorder report
              </CardTitle>
              <CardDescription>
                Suggested order quantities from demand — every input shown so you can audit the number.
              </CardDescription>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <Select value={urgencyFilter} onValueChange={(v) => setUrgencyFilter(v as "all" | ReorderUrgency)}>
                <SelectTrigger className="w-full sm:w-[170px]">
                  <SelectValue placeholder="All urgencies" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All urgencies</SelectItem>
                  <SelectItem value="OUT">Out of stock</SelectItem>
                  <SelectItem value="CRITICAL">Critical</SelectItem>
                  <SelectItem value="REORDER_NOW">Reorder now</SelectItem>
                  <SelectItem value="APPROACHING">Approaching</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" asChild>
                <a href="/api/reports/reorder-recommendations/export">
                  <Download className="h-4 w-4 mr-2" />
                  Export CSV
                </a>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 mb-4 text-xs text-muted-foreground">
            <Info className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              Suggested quantities are <strong>gross</strong> — they do not subtract stock already on
              order (no purchase-order tracking yet). Order value is blank when a product&apos;s cost is
              unknown; it is never shown as $0.
            </span>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-center">Urgency</TableHead>
                  <TableHead className="text-right hidden sm:table-cell">Stock</TableHead>
                  <TableHead className="text-right hidden md:table-cell">Avg/day</TableHead>
                  <TableHead className="text-right hidden lg:table-cell">Lead</TableHead>
                  <TableHead className="text-right hidden lg:table-cell">Buffer</TableHead>
                  <TableHead className="text-right hidden sm:table-cell">Reorder pt</TableHead>
                  <TableHead className="text-right">Suggest qty</TableHead>
                  <TableHead className="text-right hidden md:table-cell">Order value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredSuggested.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                      No products match the selected urgency.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredSuggested.map((r) => {
                    const cfg = URGENCY_CONFIG[r.urgency];
                    return (
                      <TableRow key={r.productId}>
                        <TableCell className="font-medium">
                          <span className="truncate max-w-[200px] inline-block align-middle">{r.productName}</span>
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge variant={cfg.variant}>{cfg.label}</Badge>
                        </TableCell>
                        <TableCell className="text-right hidden sm:table-cell">{r.currentStock}</TableCell>
                        <TableCell className="text-right hidden md:table-cell">{num(r.avgDailyDemand)}</TableCell>
                        <TableCell className="text-right hidden lg:table-cell">
                          {r.leadTimeDays}
                          <span className="text-muted-foreground text-xs ml-1">
                            {r.leadTimeSource === "product" ? "(set)" : "(dflt)"}
                          </span>
                        </TableCell>
                        <TableCell className="text-right hidden lg:table-cell">{r.bufferDays}</TableCell>
                        <TableCell className="text-right hidden sm:table-cell">{r.reorderPoint}</TableCell>
                        <TableCell className="text-right font-medium">{r.grossReplenishmentNeed}</TableCell>
                        <TableCell className="text-right hidden md:table-cell">
                          {r.orderValue === null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            currency.format(r.orderValue)
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
          {assumptions && (
            <p className="text-xs text-muted-foreground mt-4">
              Demand window: {assumptions.windowDays} days · default buffer: {assumptions.bufferDaysDefault} days ·
              target: {assumptions.targetCoverageMultiple}× lead time. {assumptions.demandDefinition}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Unavailable — truthful "we can't suggest" section */}
      {unavailable.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4" />
              Not enough signal to suggest an order ({unavailable.length})
            </CardTitle>
            <CardDescription>
              These products have no reliable demand signal, so no quantity is invented for them.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Stock</TableHead>
                    <TableHead>Why</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unavailable.map((r) => (
                    <TableRow key={r.productId}>
                      <TableCell className="font-medium">{r.productName}</TableCell>
                      <TableCell className="text-right">{r.currentStock}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">{REASON_LABEL[r.reason]}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
