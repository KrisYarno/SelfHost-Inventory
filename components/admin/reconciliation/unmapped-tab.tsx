"use client";

/**
 * components/admin/reconciliation/unmapped-tab.tsx — the unmapped-aging queue
 * (pack C4b.1; spec REV-7 §4.4).
 *
 * External order lines nobody has mapped to a product, at the grain a person
 * actually maps — integration, external product, variant — because a list at
 * ITEM grain asks somebody to map the same thing forty times. The producer
 * (`lib/reconciliation/unmapped.ts`) does the grouping, the ageing and the
 * banding; this tab renders them and says what it cannot see.
 *
 * THE UNKNOWN BAND IS A BAND (R-2). A group whose oldest order carries no
 * external creation date has no computable age, and it gets its own chip
 * carrying the REASON as its label. Folding it into `90+` would age a group
 * nobody can age, and the number underneath would look like evidence.
 *
 * THE LINK WARNS BEFORE IT COSTS. Following it opens the map page, which loads
 * the live store catalog — a real request to somebody's shop — so the warning
 * is part of the label rather than a tooltip nobody hovers.
 */

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useUnmapped, type UnmappedQueryInput } from "@/hooks/use-admin";
import type { UnmappedGroup } from "@/lib/reconciliation/unmapped";

/**
 * The empty state. Bounded by the filter that produced it on purpose: "nothing
 * is unmapped" and "nothing older than 30 days is unmapped" are different
 * claims, and only one of them is true on a filtered list.
 */
export const UNMAPPED_EMPTY_STATE = "No unmapped external order lines match this filter.";

const PAGE_SIZE = 50;

const AGE_CUTS = [7, 30, 90] as const;

const SELECT_CLASS =
  "h-9 rounded-md border border-border bg-background px-2 text-body-sm text-foreground";

/**
 * The chips, in band order, with the label each one carries. The four dated
 * bands are named by their key; `unknown` is named by its REASON (spec §4.4).
 */
const BUCKET_CHIPS: ReadonlyArray<{ key: UnmappedGroup["bucket"]; label: string }> = [
  { key: "0-7", label: "0-7" },
  { key: "8-30", label: "8-30" },
  { key: "31-90", label: "31-90" },
  { key: "90+", label: "90+" },
  { key: "unknown", label: "unknown age — the order carries no external creation date" },
];

/** The identity triple, as one string — the same triple the producer groups by. */
function groupKey(group: UnmappedGroup): string {
  return `${group.integrationId}::${group.externalProductId}::${group.externalVariantId ?? ""}`;
}

/** The age, or the producer's reason there is none — never a 0 standing in. */
function ageText(group: UnmappedGroup): string {
  return group.ageDays === null ? (group.ageReason ?? "unknown age") : `${group.ageDays} days`;
}

function skuText(group: UnmappedGroup): string {
  return group.sku ?? "no sku";
}

function MapLink({ group, testIds }: { group: UnmappedGroup; testIds: boolean }) {
  return (
    <Link
      href={group.link.href}
      className="text-body-sm underline underline-offset-4"
      data-testid={testIds ? `unmapped-link-${groupKey(group)}` : undefined}
    >
      Map it — {group.link.warning}
    </Link>
  );
}

function UnmappedTableRow({ group }: { group: UnmappedGroup }) {
  const key = groupKey(group);
  return (
    <TableRow data-testid={`unmapped-row-${key}`}>
      <TableCell className="whitespace-nowrap">
        <p>{group.integrationName}</p>
        <p className="text-body-sm text-muted-foreground">{group.platform}</p>
      </TableCell>
      <TableCell>
        <p>{group.name}</p>
        <p className="text-body-sm text-muted-foreground">{skuText(group)}</p>
      </TableCell>
      <TableCell className="tabular-nums">{group.itemCount}</TableCell>
      <TableCell data-testid={`unmapped-age-${key}`} className="whitespace-normal">
        <p>{ageText(group)}</p>
        <p className="text-body-sm text-muted-foreground">{group.bucket}</p>
      </TableCell>
      <TableCell>
        <MapLink group={group} testIds />
      </TableCell>
    </TableRow>
  );
}

function UnmappedMobileCard({ group }: { group: UnmappedGroup }) {
  return (
    <div
      data-testid={`unmapped-card-${groupKey(group)}`}
      className="space-y-2 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="font-medium">{group.name}</span>
        <span className="text-body-sm text-muted-foreground">{group.integrationName}</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-body-sm">
        <div className="min-w-0">
          <dt className="text-muted-foreground">SKU</dt>
          <dd>{skuText(group)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Lines waiting</dt>
          <dd className="tabular-nums">{group.itemCount}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Oldest</dt>
          <dd>{ageText(group)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Band</dt>
          <dd>{group.bucket}</dd>
        </div>
      </dl>
      <MapLink group={group} testIds={false} />
    </div>
  );
}

type Filters = {
  /** The select's value; "" is "any age", never 0. */
  olderThanDays: string;
  cursor: string | undefined;
};

export function UnmappedTab() {
  const [filters, setFilters] = React.useState<Filters>({
    olderThanDays: "",
    cursor: undefined,
  });

  // The cursor belongs to the filter that produced it (the attribution tab's
  // rule, and the same reason: page 2 of one list is not page 2 of another).
  function setFilter(patch: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...patch, cursor: undefined }));
  }

  const input: UnmappedQueryInput = {
    limit: PAGE_SIZE,
    ...(filters.olderThanDays ? { olderThanDays: Number(filters.olderThanDays) } : {}),
    ...(filters.cursor ? { cursor: filters.cursor } : {}),
  };
  const query = useUnmapped(input);
  const page = query.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="space-y-1">
          <Label htmlFor="unmapped-age">Age</Label>
          <select
            id="unmapped-age"
            className={SELECT_CLASS}
            value={filters.olderThanDays}
            onChange={(event) => setFilter({ olderThanDays: event.target.value })}
          >
            <option value="">Any age</option>
            {AGE_CUTS.map((days) => (
              <option key={days} value={String(days)}>
                Oldest order {days}+ days ago
              </option>
            ))}
          </select>
        </div>
      </div>

      {page && (
        <div className="flex flex-wrap gap-2">
          {BUCKET_CHIPS.map((chip) => (
            <span
              key={chip.key}
              data-testid={`bucket-chip-${chip.key}`}
              className="rounded-full border border-border bg-surface px-3 py-1 text-body-sm text-muted-foreground"
            >
              <span>{chip.label}</span>
              {" · "}
              <span className="tabular-nums">{page.buckets[chip.key]}</span>
            </span>
          ))}
        </div>
      )}

      {query.isLoading && <Skeleton className="h-40 w-full" />}

      {query.isError && (
        <div className="rounded-lg border border-negative-border bg-negative-muted p-4 text-negative-foreground">
          <p className="text-body">Could not load the unmapped lines.</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => query.refetch()}>
            Retry
          </Button>
        </div>
      )}

      {page && (
        <>
          <div className="space-y-1 rounded-lg border border-border bg-surface p-4">
            <p className="text-body" data-testid="unmapped-count">
              Showing {page.groups.length} of {page.count} groups.
            </p>
            {page.moreCount > 0 && (
              <p className="text-body" data-testid="unmapped-more-count">
                {page.moreCount} more in this list.
              </p>
            )}
            <p className="text-body-sm text-muted-foreground">
              The bands count every group in this filter, not just the ones on this page.
            </p>
          </div>

          {page.groups.length === 0 ? (
            <p
              className="rounded-lg border border-border bg-surface p-6 text-center text-body text-muted-foreground"
              data-testid="unmapped-empty"
            >
              {UNMAPPED_EMPTY_STATE}
            </p>
          ) : (
            <>
              <div className="hidden md:block" data-testid="unmapped-table-wrap">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Store</TableHead>
                      <TableHead>Line</TableHead>
                      <TableHead>Lines waiting</TableHead>
                      <TableHead>Oldest order</TableHead>
                      <TableHead>Map it</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {page.groups.map((group) => (
                      <UnmappedTableRow key={groupKey(group)} group={group} />
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="space-y-3 md:hidden" data-testid="unmapped-cards">
                {page.groups.map((group) => (
                  <UnmappedMobileCard key={groupKey(group)} group={group} />
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
