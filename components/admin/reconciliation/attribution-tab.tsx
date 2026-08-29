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
 *
 * THE MATCHES CHIPS ARE A SECOND, SMALLER THING (Part 2, pack CA3), and the
 * difference is the whole reason they are a separate row. The class chips are a
 * SERVER filter over the window; these describe THIS PAGE's orders — the match
 * costs three statements over the page's stamps, so it is computed for the rows
 * that came back and for nothing else. Selecting one therefore filters the rows
 * already on screen and asks the server nothing: the counts beside it stay the
 * page's own, and the window bound says "(unfiltered)" so the two are never
 * read as one number.
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
import {
  FLAGGED_MATCH_CLASSES,
  MATCH_CLASS_KEYS,
  MATCH_CLASS_LABELS,
  MATCH_UNAVAILABLE_REASONS,
  type MatchClassKey,
} from "@/lib/reconciliation/match-keys";
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
  matchFiltered,
}: {
  report: AttributionReport;
  classKey: AttributionClassKey | null;
  /** A match chip is hiding rows the bound below still counts (pack CA3). */
  matchFiltered: boolean;
}) {
  const { coverage, totals, definitions } = report;
  const needsALook =
    coverage.needsALook.stampDisagreesWithLatestAttempt + coverage.needsALook.mixedStamps;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-4" data-testid="coverage">
      <div>
        {/* The WINDOW's total, never the selected class's (OC-7). `report.count`
            is the count AFTER the class filter, so reading it here made every
            chip look like a window that had shrunk to fit the chip.
            A MATCH chip hides rows on the CLIENT and rewrites none of these
            figures (OCa-3), so while one is active every sentence that counts
            rows says "(unfiltered)" — the same idiom the window bound below
            uses, because they are the same claim. */}
        <p className="text-body">
          Showing {coverage.rowsReturned} of {totals.attributable} attributable batches in this
          window ({report.window.from} to {report.window.to}, inclusive UTC)
          {matchFiltered ? " (unfiltered)" : ""}.
        </p>
        <Definition text={definitions.attributable} />
      </div>

      {classKey !== null && (
        <p className="text-body" data-testid="class-count">
          {report.count} in the selected class{matchFiltered ? " (unfiltered)" : ""}.
        </p>
      )}

      {report.moreCount > 0 && (
        <div>
          <p className="text-body" data-testid="more-count">
            {report.moreCount} more in this window{matchFiltered ? " (unfiltered)" : ""}.
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

/**
 * WHICH BUCKET OF THE PAGE'S MATCHES IS SELECTED. A class key and the
 * unavailable bucket cannot collide — `unavailable` is not a class — so one
 * string carries both, and `null` is "the whole page".
 */
type MatchChipKey = MatchClassKey | "unavailable";

/** The rows a chip selects. The unavailable chip reads the REASON, not a class. */
function rowInChip(row: AttributionRow, chip: MatchChipKey): boolean {
  return chip === "unavailable" ? row.matchUnavailable !== null : row.match?.class === chip;
}

function MatchChip({
  chipKey,
  label,
  count,
  unit,
  tone,
  active,
  onToggle,
}: {
  chipKey: MatchChipKey;
  label: string;
  count: number;
  /** The count's grain when it is NOT the row's (FD3-2: the Unavailable chip counts rows). */
  unit?: string;
  tone: string;
  active: boolean;
  onToggle: (chip: MatchChipKey) => void;
}) {
  return (
    <button
      type="button"
      data-testid={`match-chip-${chipKey}`}
      aria-pressed={active}
      onClick={() => onToggle(chipKey)}
      className={cn(
        "rounded-full border px-3 py-1 text-body-sm transition-colors",
        // The tone is the CLASS's, in both states: whether an admin should look
        // at this bucket is a fact about the bucket, not about what is selected.
        tone,
        active
          ? "border-primary bg-surface-hover"
          : "border-border bg-surface hover:bg-surface-hover",
      )}
    >
      {`${label} (${count}${unit ? ` ${unit}` : ""})`}
    </button>
  );
}

/**
 * THE PAGE'S MATCHES. Every number here is `matches.byClass` / `matches.unavailable`
 * as the producer counted it — `byClass` counts ORDERS and `unavailable` counts
 * ROWS, and neither is recoverable by counting what is on screen (two batches
 * stamped with one order are one order). A chip that recounted the rows would
 * quietly disagree with the coverage block above it.
 *
 * A class-less match (`class: null`, the matcher's `unmatchable`) has no bucket
 * here on purpose (pack REV 4): it is a match with nothing to compare, so it is
 * in `matches.orders` and in no chip. The row says so in its own Match cell.
 *
 * THE TWO TOTALS ARE INDEPENDENT (OCa-2 / G2-1). `orders` counts orders that
 * were compared; `unavailable` counts rows that could not be. A page can carry
 * either, both or neither — a page of unstamped batches has fifty of the second
 * and none of the first — so the Unavailable chip renders on its own count, and
 * "Matches: none on this page" is said only when BOTH are zero.
 */
function MatchChips({
  matches,
  active,
  onToggle,
}: {
  matches: AttributionReport["matches"];
  active: MatchChipKey | null;
  onToggle: (chip: MatchChipKey) => void;
}) {
  const unavailable = MATCH_UNAVAILABLE_REASONS.reduce(
    (sum, reason) => sum + matches.unavailable[reason],
    0,
  );
  const classed = MATCH_CLASS_KEYS.reduce((sum, key) => sum + matches.byClass[key], 0);
  const notComparable = Math.max(0, matches.orders - classed);

  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t border-border pt-4"
      data-testid="match-chips"
    >
      {/* The label is ALWAYS the first element (pack CA3), whatever follows it. */}
      {/* QA-5: the chips count ORDERS and the filter shows their BATCHES — the grain is in the label. */}
      <span className="text-body-sm font-medium">Matches (this page, by order)</span>

      {MATCH_CLASS_KEYS.filter((key) => matches.byClass[key] > 0).map((key) => (
        <MatchChip
          key={key}
          chipKey={key}
          label={MATCH_CLASS_LABELS[key]}
          count={matches.byClass[key]}
          tone={
            FLAGGED_MATCH_CLASSES.has(key) ? "text-warning font-medium" : "text-muted-foreground"
          }
          active={active === key}
          onToggle={onToggle}
        />
      ))}

      {/* THE UNAVAILABLE CHIP DOES NOT DEPEND ON `orders` (OCa-2 / G2-1). A page
          of unstamped batches has NO matched order and a full unavailable
          bucket; hanging this chip off `orders > 0` hid fifty rows that each had
          a named reason behind the sentence "none on this page". */}
      {unavailable > 0 && (
        <MatchChip
          chipKey="unavailable"
          label="Unavailable"
          count={unavailable}
          unit={unavailable === 1 ? "row" : "rows"}
          tone="text-muted-foreground"
          active={active === "unavailable"}
          onToggle={onToggle}
        />
      )}

      {/* QA-6: an order the matcher answered with NO class (nothing to compare) has
          no chip; say how many rather than leave a bare label. */}
      {notComparable > 0 && (
        <span className="text-body-sm text-muted-foreground" data-testid="match-chips-unmatchable">
          {notComparable} order(s) with nothing to compare
        </span>
      )}

      {matches.orders === 0 &&
        (unavailable === 0 ? (
          // NOTHING on either side. Never hidden: a page whose rows carry no
          // order at all is a fact about the page, and an absent row would read
          // as "not computed yet".
          <span className="text-body-sm text-muted-foreground" data-testid="match-chips-none">
            Matches: none on this page
          </span>
        ) : (
          // Rows with reasons but no order to compare: the chip above says how
          // many, and this says the other half of the same fact.
          <span className="text-body-sm text-muted-foreground" data-testid="match-chips-no-orders">
            no matched order on this page
          </span>
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

  // THE MATCH CHIP IS ABOUT THE ROWS ON SCREEN, so it cannot outlive them: a
  // cursor step, a class chip, a new window or a new order number all hand back
  // a different report, and a selection made about the old page would filter the
  // new one by a bucket nobody chose for it. Adjusted DURING render (React's
  // "adjusting state when props change") so the stale filter is never committed.
  const [matchChip, setMatchChip] = React.useState<MatchChipKey | null>(null);
  const [reportSeen, setReportSeen] = React.useState<AttributionReport | undefined>(report);
  if (reportSeen !== report) {
    setReportSeen(report);
    setMatchChip(null);
  }

  const visibleRows =
    report === undefined
      ? []
      : matchChip === null
        ? report.rows
        : report.rows.filter((row) => rowInChip(row, matchChip));

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
          <Coverage
            report={report}
            classKey={filters.classKey}
            matchFiltered={matchChip !== null}
          />

          <MatchChips
            matches={report.matches}
            active={matchChip}
            onToggle={(chip) => setMatchChip((current) => (current === chip ? null : chip))}
          />

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
                      <TableHead>Match</TableHead>
                      <TableHead className="text-right">Attribute</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleRows.map((row) => (
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
                {visibleRows.map((row) => (
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
