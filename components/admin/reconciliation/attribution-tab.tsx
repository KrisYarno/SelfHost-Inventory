"use client";

/**
 * components/admin/reconciliation/attribution-tab.tsx — the Attribution tab
 * (pack C4a.2; spec REV-7 §4.2).
 *
 * The table is the small half of this screen. The big half is the COVERAGE
 * block above it, because every figure here is bounded: batches the report is
 * not allowed to speak about (R0), outbound rows that carry no batch id and so
 * cannot be grouped at all, a share of classes that were computed at read time
 * rather than recorded, and a page bound that says how much of the window is
 * still behind it. A report that showed the rows without those sentences would
 * be read as "this is what happened", and it is not — it is what can be seen
 * from here.
 *
 * THE CHIPS ARE THE FILTER (spec §4.2): each chip carries `totals.byClass`,
 * which the producer computes BEFORE the active class filter, so selecting one
 * never rewrites the numbers on the others. No dependent selects, no impossible
 * combination.
 */

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useDebounce } from "@/hooks/use-debounce";
import { useAttributionReport, type AttributionReportInput } from "@/hooks/use-admin";
import { ATTRIBUTION_CLASS_KEYS } from "@/lib/reconciliation/class-keys";
import type {
  AttributionClassKey,
  AttributionReport,
  AttributionRow,
} from "@/lib/reconciliation/attribution";
import { AttributionMobileCard, AttributionTableRow } from "./attribution-row";
import { AttributionDrilldown } from "./attribution-drilldown";
import { AttributePicker } from "./attribute-picker";
import { ReconciliationErrorCard } from "./error-card";

/** VERBATIM (pack C4a.2). */
export const ATTRIBUTION_EMPTY_STATE = "No attributable outbound batches in this window.";

const DEFAULT_WINDOW_DAYS = 14;
const PAGE_SIZE = 50;
const FILTER_DEBOUNCE_MS = 250;
const DAY_MS = 86_400_000;

/**
 * The default window, as INCLUSIVE UTC day keys. Mirrored from the usage
 * picker's `rangeForDays` rather than imported: the route's `from`/`to` are day
 * keys placed on a UTC axis, and local-time arithmetic would ask for a window
 * different from the one displayed.
 */
function defaultWindow(now: Date = new Date()): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${to}T00:00:00.000Z`) - (DEFAULT_WINDOW_DAYS - 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);
  return { from, to };
}

/** 0.25 -> "25", 0.333 -> "33.3". Never a trailing ".0" pretending to precision. */
function sharePercent(share: number): string {
  return String(Number((share * 100).toFixed(1)));
}

type Filters = {
  from: string;
  to: string;
  classKey: AttributionClassKey | null;
  orderNumber: string;
  cursor: string | undefined;
};

function Definition({ text }: { text: string | undefined }) {
  if (!text) return null;
  return <p className="text-body-sm text-muted-foreground">{text}</p>;
}

function Coverage({
  report,
  classKey,
}: {
  report: AttributionReport;
  classKey: AttributionClassKey | null;
}) {
  const { coverage, totals, definitions } = report;
  const needsALook =
    coverage.needsALook.stampDisagreesWithLatestAttempt + coverage.needsALook.mixedStamps;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-4" data-testid="coverage">
      <div>
        {/* The WINDOW's total, never the selected class's (OC-7). `report.count`
            is the count AFTER the class filter, so reading it here made every
            chip look like a window that had shrunk to fit the chip. */}
        <p className="text-body">
          Showing {coverage.rowsReturned} of {totals.attributable} attributable batches in this
          window ({report.window.from} to {report.window.to}, inclusive UTC).
        </p>
        <Definition text={definitions.attributable} />
      </div>

      {classKey !== null && (
        <p className="text-body" data-testid="class-count">
          {report.count} in the selected class.
        </p>
      )}

      {report.moreCount > 0 && (
        <div>
          <p className="text-body" data-testid="more-count">
            {report.moreCount} more in this window.
          </p>
          <Definition text={definitions.moreCount} />
        </div>
      )}

      <div>
        <p className="text-body">
          {totals.exclusions.nonAttributable} non-attributable batches,{" "}
          {totals.exclusions.historicalMassUpdate} R0 pre-lane mass updates and{" "}
          {totals.exclusions.noBatchRows} rows without a batch id are outside this report.
        </p>
        <Definition text={definitions.nonAttributable} />
        <Definition text={definitions.historicalMassUpdate} />
        <Definition text={definitions.noBatchRows} />
      </div>

      <div>
        <p className="text-body">
          {coverage.derivedShare === null
            ? "Derived share unavailable."
            : `Derived share ${sharePercent(coverage.derivedShare)}%.`}
        </p>
        <Definition text={definitions.derivedShare} />
      </div>

      <p className="text-body">
        {coverage.ledgerUnstamped} fulfillment-derived batches whose ledger was never stamped.
      </p>

      {needsALook > 0 && (
        <div>
          <p className="text-body" data-testid="needs-a-look">
            {needsALook} batches need a look —{" "}
            {coverage.needsALook.stampDisagreesWithLatestAttempt} where the stamp disagrees with the
            latest recorded attempt, {coverage.needsALook.mixedStamps} carrying different order ids.
          </p>
          <Definition text={definitions.needsALook} />
        </div>
      )}

      <div>
        <p className="text-body">
          {coverage.recordingSince === null
            ? "No attempt has ever been recorded, so every class here was derived at read time."
            : `Attempts have been recorded since ${new Date(coverage.recordingSince).toLocaleString()}.`}
        </p>
        <Definition text={definitions.recordingSince} />
      </div>

      <p className="text-body">Order scope: {coverage.orderFilterScope}.</p>

      {coverage.notes.map((note) => (
        <p key={note} className="text-body-sm text-muted-foreground">
          {note}
        </p>
      ))}
    </div>
  );
}

export function AttributionTab() {
  const [filters, setFilters] = React.useState<Filters>(() => ({
    ...defaultWindow(),
    classKey: null,
    orderNumber: "",
    cursor: undefined,
  }));
  const [orderNumberInput, setOrderNumberInput] = React.useState("");
  const [openRow, setOpenRow] = React.useState<AttributionRow | null>(null);
  const [attributeRow, setAttributeRow] = React.useState<AttributionRow | null>(null);

  const debouncedOrderNumber = useDebounce(orderNumberInput.trim(), FILTER_DEBOUNCE_MS);
  React.useEffect(() => {
    setFilters((current) =>
      current.orderNumber === debouncedOrderNumber
        ? current
        : { ...current, orderNumber: debouncedOrderNumber, cursor: undefined },
    );
  }, [debouncedOrderNumber]);

  const input: AttributionReportInput = {
    from: filters.from,
    to: filters.to,
    limit: PAGE_SIZE,
    ...(filters.classKey ? { classKey: filters.classKey } : {}),
    ...(filters.orderNumber ? { orderNumber: filters.orderNumber } : {}),
    ...(filters.cursor ? { cursor: filters.cursor } : {}),
  };
  const query = useAttributionReport(input);
  const report = query.data;

  // A cursor belongs to the filter that produced it: page 2 of one window is
  // not page 2 of another, so every filter change drops it in the SAME update.
  function setFilter(patch: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...patch, cursor: undefined }));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="flex items-center gap-2">
          <Input
            type="date"
            value={filters.from}
            onChange={(event) => setFilter({ from: event.target.value })}
            className="w-full sm:w-40"
            aria-label="From date"
          />
          <span className="text-muted-foreground">to</span>
          <Input
            type="date"
            value={filters.to}
            onChange={(event) => setFilter({ to: event.target.value })}
            className="w-full sm:w-40"
            aria-label="To date"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="attribution-order-number">Order number (exact)</Label>
          <Input
            id="attribution-order-number"
            value={orderNumberInput}
            onChange={(event) => setOrderNumberInput(event.target.value)}
            className="w-full sm:w-48"
            placeholder="e.g. 1009"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {ATTRIBUTION_CLASS_KEYS.map((key) => {
          const active = filters.classKey === key;
          return (
            <button
              key={key}
              type="button"
              data-testid={`class-chip-${key}`}
              aria-pressed={active}
              onClick={() => setFilter({ classKey: active ? null : key })}
              className={cn(
                "rounded-full border px-3 py-1 text-body-sm transition-colors",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-surface text-muted-foreground hover:bg-surface-hover",
              )}
            >
              <span>{key}</span>
              {" · "}
              <span className="tabular-nums">{report ? report.totals.byClass[key] : 0}</span>
            </button>
          );
        })}
      </div>

      {query.isLoading && <Skeleton className="h-40 w-full" />}

      {query.isError && (
        <ReconciliationErrorCard
          error={query.error}
          fallback="Could not load the attribution report."
          onRetry={() => query.refetch()}
        />
      )}

      {report && (
        <>
          <Coverage report={report} classKey={filters.classKey} />

          {report.rows.length === 0 ? (
            <p
              className="rounded-lg border border-border bg-surface p-6 text-center text-body text-muted-foreground"
              data-testid="attribution-empty"
            >
              {ATTRIBUTION_EMPTY_STATE}
            </p>
          ) : (
            <>
              <div className="hidden md:block" data-testid="attribution-table-wrap">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Who</TableHead>
                      <TableHead>How</TableHead>
                      <TableHead>Rows</TableHead>
                      <TableHead>Products</TableHead>
                      <TableHead>Order</TableHead>
                      <TableHead className="text-right">Attribute</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.rows.map((row) => (
                      <AttributionTableRow
                        key={row.batchId}
                        row={row}
                        onOpen={setOpenRow}
                        onAttribute={setAttributeRow}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="space-y-3 md:hidden" data-testid="attribution-cards">
                {report.rows.map((row) => (
                  <AttributionMobileCard
                    key={row.batchId}
                    row={row}
                    onOpen={setOpenRow}
                    onAttribute={setAttributeRow}
                  />
                ))}
              </div>
            </>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {filters.cursor !== undefined && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setFilters((current) => ({ ...current, cursor: undefined }))}
              >
                First page
              </Button>
            )}
            {report.nextCursor !== null && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setFilters((current) => ({ ...current, cursor: report.nextCursor ?? undefined }))
                }
              >
                Next page
              </Button>
            )}
          </div>
        </>
      )}

      {openRow !== null && (
        <AttributionDrilldown
          row={openRow}
          open
          onOpenChange={(next) => {
            if (!next) setOpenRow(null);
          }}
          onAttribute={(row) => {
            setOpenRow(null);
            setAttributeRow(row);
          }}
        />
      )}

      {attributeRow !== null && (
        <AttributePicker
          row={attributeRow}
          open
          onOpenChange={(next) => {
            if (!next) setAttributeRow(null);
          }}
        />
      )}
    </div>
  );
}
