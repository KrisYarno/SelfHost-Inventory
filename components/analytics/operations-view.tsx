"use client";

import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OperationsRow, OperationsDataStarts, ShrinkageReason } from "@/lib/analytics/queries";
import { OperationsTiles } from "@/components/analytics/operations-tiles";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Clock,
  Info,
  PackageX,
} from "lucide-react";

type ShrinkageByReason = Record<
  ShrinkageReason,
  { units: number; valueAtCurrentCostCents: number | null }
>;

interface OperationsPayload {
  scope: string;
  windowDays: number;
  rows: OperationsRow[];
  dataStarts: OperationsDataStarts;
  shrinkage90: { byReason: ShrinkageByReason; dataStart: string | null };
  valuation: {
    atCurrentCostCents: number;
    atReceiptCostCents: number | null;
    receiptCoverage: { have: number; of: number };
  };
}

async function fetchOperations(signal?: AbortSignal): Promise<OperationsPayload> {
  const res = await fetch("/api/analytics/operations", { signal });
  if (!res.ok) throw new Error("Failed to load operations analytics");
  return res.json();
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const numberFmt = new Intl.NumberFormat("en-US");
const money = (cents: number | null) => (cents === null ? "—" : usd.format(cents / 100));
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "None recorded";

// D-L6 operator copy — an unfulfilled order does NOT subtract the original sale.
const UNITS_OUT_TOOLTIP = "Later un-fulfillments are not subtracted";
const NO_SALE_HISTORY = "No fulfilled-order history yet";

const ATTENTION: Record<OperationsRow["attention"], { tone: StatusTone; label: string; Icon: typeof Info }> = {
  ok: { tone: "positive", label: "OK", Icon: CircleCheck },
  low: { tone: "warning", label: "Low", Icon: AlertTriangle },
  out: { tone: "negative", label: "Out of stock", Icon: PackageX },
  stale: { tone: "neutral", label: "Aging", Icon: Clock },
};

function AttentionBadge({ attention }: { attention: OperationsRow["attention"] }) {
  const a = ATTENTION[attention];
  return (
    <StatusBadge tone={a.tone} className="inline-flex items-center gap-1">
      <a.Icon className="h-3 w-3" aria-hidden />
      {a.label}
    </StatusBadge>
  );
}

function turnsTitle(row: OperationsRow): string | undefined {
  if (row.turns90 !== null) return undefined;
  if (row.turnsCoverage) {
    return `Turns unavailable — stock snapshots cover ${row.turnsCoverage.days} of ${row.turnsCoverage.windowDays} days`;
  }
  return "Turns unavailable — no stock snapshots yet";
}

// The muted, per-cell honesty value for a SALE-derived metric that has no data yet.
function Accrued({ title }: { title?: string }) {
  return (
    <span className="text-muted-foreground" title={title ?? NO_SALE_HISTORY}>
      —
    </span>
  );
}

function DetailGrid({ row }: { row: OperationsRow }) {
  const items: { label: string; value: string; title?: string }[] = [
    { label: "Last inbound movement", value: fmtDate(row.lastInboundAt) },
    { label: "Last outbound movement", value: fmtDate(row.lastOutboundAt) },
    { label: "Last receipt cost", value: money(row.lastReceiptCostCents) },
    {
      label: "Units out (90 days)",
      value: row.unitsOut90 === null ? "—" : numberFmt.format(row.unitsOut90),
      title: row.unitsOut90 === null ? NO_SALE_HISTORY : UNITS_OUT_TOOLTIP,
    },
    {
      label: "Avg daily (30 days)",
      value: row.avgDaily30 === null ? "—" : row.avgDaily30.toFixed(2),
      title: row.avgDaily30 === null ? NO_SALE_HISTORY : undefined,
    },
    { label: "Corrections (90 days)", value: numberFmt.format(row.correctionsIn90) },
  ];
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3">
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <div className="text-body-sm text-muted-foreground">{it.label}</div>
          <div className="tabular-nums text-foreground" title={it.title}>
            {it.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function SaleDataNotice({ saleStart }: { saleStart: string | null }) {
  // D-L4 designed accrual panel: a muted info box in place of a bare em-dash wall
  // when no fulfilled-order data exists yet. Once data is recorded, a subtle
  // provenance line replaces it.
  if (saleStart === null) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-border bg-surface px-4 py-3 text-body-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p>
          <span className="font-medium text-foreground">{NO_SALE_HISTORY}.</span>{" "}
          Metrics appear as fulfilled orders and stock movements record.
        </p>
      </div>
    );
  }
  return (
    <p className="text-body-sm text-muted-foreground">
      Sale data recorded since {fmtDate(saleStart)}.
    </p>
  );
}

export function OperationsView() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["analytics-operations"],
    queryFn: ({ signal }) => fetchOperations(signal),
  });
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-4">
      {/* Persistent scope label — Operations is the GLOBAL physical pool (D-L3). */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-h3 text-foreground">Inventory operations</h2>
        <span className="text-body-sm text-muted-foreground">Global inventory — all companies</span>
      </div>

      {isLoading ? (
        <div data-testid="operations-loading" className="space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : isError || !data ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-8 text-center">
          <p className="text-sm text-destructive">Could not load operations analytics.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()} className="mt-3">
            Retry
          </Button>
        </div>
      ) : data.rows.length === 0 ? (
        <div className="rounded-lg border border-border/70 bg-muted/30 px-4 py-12 text-center text-sm text-muted-foreground">
          No products yet.
        </div>
      ) : (
        <>
          <SaleDataNotice saleStart={data.dataStarts.sale} />
          <OperationsTiles data={data} />

          {/* md+: the per-product decision table with an expandable detail row. */}
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Current stock</TableHead>
                  <TableHead className="text-right">Days of supply</TableHead>
                  <TableHead className="text-right" title={UNITS_OUT_TOOLTIP}>
                    Units out (fulfilled) · 30 days
                  </TableHead>
                  <TableHead className="text-right">Turns · 90 days</TableHead>
                  <TableHead className="text-right">Shrinkage · 90 days</TableHead>
                  <TableHead>Attention</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((row) => {
                  const isOpen = expanded.has(row.productId);
                  return (
                    <Fragment key={row.productId}>
                      <TableRow>
                        <TableCell>
                          <button
                            type="button"
                            onClick={() => toggle(row.productId)}
                            aria-expanded={isOpen}
                            aria-label={`${isOpen ? "Collapse" : "Expand"} details for ${row.name}`}
                            className="inline-flex min-h-[44px] items-center gap-2 text-left font-medium text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                          >
                            {isOpen ? (
                              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                            ) : (
                              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                            )}
                            {row.name}
                          </button>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {numberFmt.format(row.currentStock)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.daysOfSupply === null ? <Accrued /> : Math.round(row.daysOfSupply)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.unitsOut30 === null ? (
                            <Accrued />
                          ) : (
                            <span title={UNITS_OUT_TOOLTIP}>{numberFmt.format(row.unitsOut30)}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.turns90 === null ? (
                            <span className="text-muted-foreground" title={turnsTitle(row)}>
                              —
                            </span>
                          ) : (
                            `${row.turns90.toFixed(1)}x`
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.shrinkage90 === null ? (
                            <Accrued title="No adjustment history yet" />
                          ) : (
                            <span
                              title={`${money(row.shrinkage90.valueAtCurrentCostCents)} at current cost`}
                            >
                              {numberFmt.format(row.shrinkage90.units)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <AttentionBadge attention={row.attention} />
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow>
                          <TableCell colSpan={7} className="bg-surface">
                            <DetailGrid row={row} />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* mobile: compact list rows — attention + two primary measures, tap to expand. */}
          <div data-testid="operations-cards" className="space-y-2 md:hidden">
            {data.rows.map((row) => {
              const isOpen = expanded.has(row.productId);
              return (
                <div key={row.productId} className="rounded-lg border border-border bg-surface">
                  <button
                    type="button"
                    onClick={() => toggle(row.productId)}
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? "Collapse" : "Expand"} details for ${row.name}`}
                    className="flex min-h-[44px] w-full items-center justify-between gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      )}
                      <span className="truncate font-medium text-foreground">{row.name}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <span className="tabular-nums text-body-sm text-muted-foreground">
                        {numberFmt.format(row.currentStock)} in stock
                      </span>
                      <AttentionBadge attention={row.attention} />
                    </span>
                  </button>
                  {isOpen && (
                    <div className="border-t border-border px-4 py-3">
                      <DetailGrid row={row} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
