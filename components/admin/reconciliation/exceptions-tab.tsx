"use client";

/**
 * components/admin/reconciliation/exceptions-tab.tsx — the Exceptions FINDER
 * (pack C4b.1; spec REV-7 §4.3 / D5).
 *
 * Part 1 does not settle anything here. The surfaces that RESOLVE these rows
 * already exist — the receiving line, product review, the admin's cost decision
 * — and this tab's whole job is to get a person to the right one, so the only
 * control on a row is its destination.
 *
 * EVERY SENTENCE ON THIS SCREEN WAS COMPUTED BY THE PRODUCER
 * (`lib/reconciliation/exceptions.ts`): the subject summary, the money label or
 * the named reason there is no money, and the link — including the two copies
 * that stand in FOR a link ("removed line", "no order to open …"). This
 * component never reaches into `subject.*`. The renderer table is closed and it
 * lives in one file; a cell here that read one kind's subject would be a second
 * place to update when a kind's shape changes, and the one nobody remembers.
 *
 * THE FILTERS ARE THE SERVER'S, all four of them. `count` and `moreCount` are
 * computed over the whole filtered set (severity is translated to a `kind IN
 * (…)` predicate at query time, never post-filtered), so a filter applied in
 * the browser would leave this header reporting a bound the rows contradict.
 */

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useExceptions, type ExceptionsQueryInput } from "@/hooks/use-admin";
import {
  EXCEPTION_KINDS,
  type ExceptionKind,
  type ExceptionSeverity,
} from "@/lib/exceptions/kinds";
import type { ExceptionRowView } from "@/lib/reconciliation/exceptions";
import { ReconciliationErrorCard } from "./error-card";

/** VERBATIM (pack C4b.1 / spec §4.3) — DAY ONE only: see `emptyStateText`. */
export const EXCEPTIONS_EMPTY_STATE =
  "No exceptions raised yet — receiving and labeling write them as they find them.";

/** The filtered view's empty page (OC-4). */
export const EXCEPTIONS_FILTERED_EMPTY_STATE = "No exceptions match these filters.";

/**
 * WHICH empty state this is (OC-4). The day-one sentence is a claim about the
 * REGISTER — "nothing has ever been written" — and a filtered page with nothing
 * on it is not evidence for it: a kind filter that matches nothing, or a page
 * past the end of a cursor walk, would both have said the register was empty
 * while rows sat behind them.
 *
 * So it is said only when BOTH halves hold: no filter is narrowing the view, and
 * the server counted nothing. Otherwise the copy names the filters and the total
 * they hold, which is the fact the reader needs to act on.
 */
function emptyStateText(filtered: boolean, count: number): string {
  if (!filtered && count === 0) return EXCEPTIONS_EMPTY_STATE;
  return count === 0
    ? EXCEPTIONS_FILTERED_EMPTY_STATE
    : `${EXCEPTIONS_FILTERED_EMPTY_STATE} ${count} match them in total — this page is past the end.`;
}

const PAGE_SIZE = 50;

const SEVERITIES: readonly ExceptionSeverity[] = ["low", "medium", "high"];

/** The age cuts the finder offers; the axis is `lastSeenAt` (the producer's). */
const AGE_CUTS = [7, 30, 90] as const;

const SELECT_CLASS =
  "h-9 rounded-md border border-border bg-background px-2 text-body-sm text-foreground";

/** The `components/analytics/supply-orders-card.tsx` `usd` idiom. */
const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/**
 * Money, or the producer's NAMED reason there is none (R-2). The label and the
 * reason are both the producer's strings; only the AMOUNT is formatted here,
 * because cents on a wire are cents.
 */
function moneyText(money: ExceptionRowView["money"]): string {
  return money.cents === null ? money.reason : `${money.label} ${fmt.format(money.cents / 100)}`;
}

/**
 * Both ends of the row's life (spec §4.3). The age rides with `lastSeenAt`
 * because that is the axis `olderThanDays` cuts — an age measured from the
 * first sighting would answer a different question from the one the filter asked.
 */
function lastSeenText(row: ExceptionRowView): string {
  return `${new Date(row.lastSeenAt).toLocaleString()} · ${row.ageDays} days old`;
}

function firstSeenText(row: ExceptionRowView): string {
  return `first seen ${new Date(row.firstSeenAt).toLocaleString()}`;
}

function statusText(row: ExceptionRowView): string {
  if (row.resolvedAt === null) return "Open";
  const who = row.resolvedBy === null ? "unknown user" : row.resolvedBy.username;
  return `${row.resolution ?? "resolved"} · ${who} · ${new Date(row.resolvedAt).toLocaleString()}`;
}

/**
 * Where this row is settled — or the producer's copy for why there is nowhere
 * to go, which is a fact about the row and not an empty cell. `testIds` is
 * false on the mobile card so one row's ids stay unique across the two
 * presentations the `md:` breakpoint swaps.
 */
function Destination({ row, testIds }: { row: ExceptionRowView; testIds: boolean }) {
  if (row.link.href === null) {
    return (
      <p
        className="text-body-sm text-muted-foreground"
        data-testid={testIds ? `exception-no-link-${row.id}` : undefined}
      >
        {row.link.copy}
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <Link
        href={row.link.href}
        className="text-body-sm underline underline-offset-4"
        data-testid={testIds ? `exception-link-${row.id}` : undefined}
      >
        {row.link.label}
      </Link>
      {row.link.warning !== undefined && (
        <p
          className="text-body-sm text-muted-foreground"
          data-testid={testIds ? `exception-link-warning-${row.id}` : undefined}
        >
          {row.link.warning}
        </p>
      )}
    </div>
  );
}

function ExceptionTableRow({ row }: { row: ExceptionRowView }) {
  return (
    <TableRow data-testid={`exception-row-${row.id}`}>
      <TableCell className="whitespace-nowrap">
        <p>{row.kind}</p>
        <p className="text-body-sm text-muted-foreground">{row.severity}</p>
      </TableCell>
      <TableCell>
        <p>{row.subjectSummary}</p>
        <p className="text-body-sm text-muted-foreground">{row.key}</p>
      </TableCell>
      <TableCell data-testid={`exception-money-${row.id}`}>{moneyText(row.money)}</TableCell>
      <TableCell className="whitespace-nowrap" data-testid={`exception-seen-${row.id}`}>
        <p>{lastSeenText(row)}</p>
        <p className="text-body-sm text-muted-foreground">{firstSeenText(row)}</p>
      </TableCell>
      <TableCell>
        <p>{statusText(row)}</p>
        {row.note !== null && <p className="text-body-sm text-muted-foreground">{row.note}</p>}
      </TableCell>
      <TableCell>
        <Destination row={row} testIds />
      </TableCell>
    </TableRow>
  );
}

function ExceptionMobileCard({ row }: { row: ExceptionRowView }) {
  return (
    <div
      data-testid={`exception-card-${row.id}`}
      className="space-y-2 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="font-medium">{row.kind}</span>
        <span className="text-body-sm text-muted-foreground">{row.severity}</span>
      </div>
      <p className="text-body-sm">{row.subjectSummary}</p>
      <p className="text-body-sm text-muted-foreground">{row.key}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-body-sm">
        <div className="min-w-0">
          <dt className="text-muted-foreground">Money</dt>
          <dd>{moneyText(row.money)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Last seen</dt>
          <dd>{lastSeenText(row)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">First seen</dt>
          <dd>{firstSeenText(row)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Status</dt>
          <dd>{statusText(row)}</dd>
        </div>
      </dl>
      {row.note !== null && <p className="text-body-sm text-muted-foreground">{row.note}</p>}
      <Destination row={row} testIds={false} />
    </div>
  );
}

type Filters = {
  kind: ExceptionKind | "";
  resolved: "open" | "resolved" | "all";
  severity: ExceptionSeverity | "";
  /** The select's value; "" is "any age", never 0. */
  olderThanDays: string;
  cursor: string | undefined;
};

export function ExceptionsTab() {
  const [filters, setFilters] = React.useState<Filters>({
    kind: "",
    resolved: "open",
    severity: "",
    olderThanDays: "",
    cursor: undefined,
  });

  // A cursor belongs to the filter that produced it: page 2 of one filter is
  // not page 2 of another, so every filter change drops it in the SAME update.
  function setFilter(patch: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...patch, cursor: undefined }));
  }

  const input: ExceptionsQueryInput = {
    resolved: filters.resolved,
    limit: PAGE_SIZE,
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.severity ? { severity: filters.severity } : {}),
    ...(filters.olderThanDays ? { olderThanDays: Number(filters.olderThanDays) } : {}),
    ...(filters.cursor ? { cursor: filters.cursor } : {}),
  };
  const query = useExceptions(input);
  const page = query.data;

  // Is anything narrowing the view? `resolved: "open"` is this tab's DEFAULT, so
  // it only counts once the reader moves it; a cursor counts because page two is
  // a bounded view of the same set (OC-4).
  const filtered =
    filters.kind !== "" ||
    filters.severity !== "" ||
    filters.olderThanDays !== "" ||
    filters.resolved !== "open" ||
    filters.cursor !== undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="space-y-1">
          <Label htmlFor="exceptions-kind">Kind</Label>
          <select
            id="exceptions-kind"
            className={SELECT_CLASS}
            value={filters.kind}
            onChange={(event) => setFilter({ kind: event.target.value as ExceptionKind | "" })}
          >
            <option value="">All kinds</option>
            {EXCEPTION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="exceptions-status">Status</Label>
          <select
            id="exceptions-status"
            className={SELECT_CLASS}
            value={filters.resolved}
            onChange={(event) =>
              setFilter({ resolved: event.target.value as Filters["resolved"] })
            }
          >
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="exceptions-severity">Severity</Label>
          <select
            id="exceptions-severity"
            className={SELECT_CLASS}
            value={filters.severity}
            onChange={(event) =>
              setFilter({ severity: event.target.value as ExceptionSeverity | "" })
            }
          >
            <option value="">Any severity</option>
            {SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {severity}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="exceptions-age">Age</Label>
          <select
            id="exceptions-age"
            className={SELECT_CLASS}
            value={filters.olderThanDays}
            onChange={(event) => setFilter({ olderThanDays: event.target.value })}
          >
            <option value="">Any age</option>
            {AGE_CUTS.map((days) => (
              <option key={days} value={String(days)}>
                Last seen {days}+ days ago
              </option>
            ))}
          </select>
        </div>
      </div>

      {query.isLoading && <Skeleton className="h-40 w-full" />}

      {query.isError && (
        <ReconciliationErrorCard
          error={query.error}
          fallback="Could not load the exceptions."
          onRetry={() => query.refetch()}
        />
      )}

      {page && (
        <>
          <div className="space-y-1 rounded-lg border border-border bg-surface p-4">
            <p className="text-body" data-testid="exceptions-count">
              Showing {page.rows.length} of {page.count} exceptions.
            </p>
            {page.moreCount > 0 && (
              <p className="text-body" data-testid="exceptions-more-count">
                {page.moreCount} more match these filters.
              </p>
            )}
          </div>

          {page.rows.length === 0 ? (
            <p
              className="rounded-lg border border-border bg-surface p-6 text-center text-body text-muted-foreground"
              data-testid="exceptions-empty"
            >
              {emptyStateText(filtered, page.count)}
            </p>
          ) : (
            <>
              <div className="hidden md:block" data-testid="exceptions-table-wrap">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Kind</TableHead>
                      <TableHead>What happened</TableHead>
                      <TableHead>Money</TableHead>
                      <TableHead>Last seen</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Where it is settled</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {page.rows.map((row) => (
                      <ExceptionTableRow key={row.id} row={row} />
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="space-y-3 md:hidden" data-testid="exceptions-cards">
                {page.rows.map((row) => (
                  <ExceptionMobileCard key={row.id} row={row} />
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
            {page.nextCursor !== null && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setFilters((current) => ({ ...current, cursor: page.nextCursor ?? undefined }))
                }
              >
                Next page
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
