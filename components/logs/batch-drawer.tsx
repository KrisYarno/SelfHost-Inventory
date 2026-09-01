"use client";

/**
 * components/logs/batch-drawer.tsx (Lane 3 R-L8 / D-L4 / D-L7 / D-L8) — the admin
 * batch drill-down drawer. Opened from a batch chip in the Audit or Change tab;
 * fetches GET /api/admin/batch/[batchId] and renders two independently paginated
 * sections — "Events" (audit events with their field diff) and "Inventory
 * movements" (ledger rows). Uses the trunk `sheet.tsx` with motion="quick"
 * (desktop side sheet 520-600px, mobile full-screen). Focus returns to the
 * invoking chip on close (Radix Dialog focus management); the underlying feed's
 * scroll + row-expansion state is preserved because the tab stays mounted.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, Copy } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { ChangeDiffList } from "@/components/history/change-diff-list";
import { LedgerRowLine } from "@/components/history/ledger-row-line";
import { ActorChip } from "@/components/history/actor-chip";
import { getInventoryLogTone } from "@/components/logs/log-style";
import { formatDateTime, formatDelta } from "@/lib/utils";
import type { ActionGroup, ActionMeta } from "@/lib/change-tracking/taxonomy";
import type { ChangePair } from "@/lib/change-tracking/extract-changes";
import type { RenderableLedgerRow } from "@/lib/history/union-timeline";

const SECTION_LIMIT = 25;

interface BatchEvent {
  id: number;
  createdAt: string;
  actionType: string;
  meta: ActionMeta;
  actorKind: string;
  actorName: string | null;
  action: string;
  changes: Record<string, ChangePair> | null;
  entityType: string;
  entityId: string | null;
  affectedCount: number;
}

interface BatchLedgerRow {
  id: number;
  changeTime: string;
  delta: number;
  logType: string;
  reasonCode: string | null;
  unitCostCents: number | null;
  productName: string | null;
  locationName: string | null;
  transferId: string | null;
  userName: string | null;
}

interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** The TOTAL shape of the batch (P2-B1.5b) — never the section page's slice. */
interface BatchSummary {
  rowCount: number;
  productCount: number;
  netUnits: number;
  logTypes: string[];
  actors: string[];
  orders: Array<{ id: string; orderNumber: string }>;
}

interface BatchResponse {
  events: Paged<BatchEvent>;
  ledgerRows: Paged<BatchLedgerRow>;
  summary: BatchSummary;
}

/**
 * The header's one-line answer to "what did this whole batch do?" (P2-B1.5b) —
 * "Sale · 2 products · -4 units · derek · order #23716". The order segment is
 * present ONLY when the batch's rows are stamped with an order, so a count or an
 * adjustment batch never grows a dangling separator.
 */
function summaryLine(summary: BatchSummary): string {
  // G2s-9: the three arrays are `?? []`-guarded HERE, one level deeper than the
  // caller's `data?.summary` belt. A version-skewed body that carries a summary
  // without one of them would otherwise throw inside render and take the whole
  // drawer down — the opposite of what the belt is for.
  const logTypes = summary.logTypes ?? [];
  const actors = summary.actors ?? [];
  const orders = summary.orders ?? [];
  const segments = [
    // getInventoryLogTone's second argument is a per-ROW delta that only steers the
    // tone; the LABEL is what is read here, so a fixed 0 is correct.
    logTypes.map((t) => getInventoryLogTone(t, 0).label).join(" / "),
    // FD2-4: the two NUMBERS get the same version-skew belt the arrays got. An
    // absent count used to render "undefined products · undefined units" — a
    // segment an operator reads as data. No number, no segment (the
    // `filter(Boolean)` below drops the empty string, separator and all).
    Number.isFinite(summary.productCount)
      ? `${summary.productCount} product${summary.productCount === 1 ? "" : "s"}`
      : "",
    Number.isFinite(summary.netUnits) ? `${formatDelta(summary.netUnits)} units` : "",
    actors.join(", "),
  ];
  if (orders.length > 0) {
    segments.push(
      orders.length === 1
        ? `order #${orders[0].orderNumber}`
        : `orders ${orders.map((o) => `#${o.orderNumber}`).join(", ")}`
    );
  }
  // FD1-8: the order segment's discipline, extended to ALL of them. An empty
  // `logTypes` or `actors` joins to "" and used to render as a dangling " · " —
  // the same trailing separator the order segment was written to avoid, just at
  // the front and in the middle of the line.
  return segments.filter(Boolean).join(" · ");
}

function toRenderableRow(r: BatchLedgerRow): RenderableLedgerRow {
  return {
    id: r.id,
    ts: r.changeTime,
    delta: r.delta,
    logType: r.logType,
    reasonCode: r.reasonCode,
    unitCostCents: r.unitCostCents,
    locationName: r.locationName,
    transferId: r.transferId,
    userName: r.userName,
  };
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable — no-op */
        }
      }}
      aria-label="Copy batch id"
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? <Check className="h-4 w-4 text-positive-foreground" /> : <Copy className="h-4 w-4" />}
    </button>
  );
}

function SectionPager({
  offset,
  limit,
  total,
  onPrev,
  onNext,
  label,
}: {
  offset: number;
  limit: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  label: string;
}) {
  if (total <= limit) return null;
  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
      <span className="tabular-nums">
        {from}-{to} of {total}
      </span>
      <div className="flex gap-1">
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          onClick={onPrev}
          disabled={offset === 0}
          aria-label={`Previous ${label}`}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          onClick={onNext}
          disabled={to >= total}
          aria-label={`Next ${label}`}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function EventCard({ event }: { event: BatchEvent }) {
  const hasChanges = !!event.changes && Object.keys(event.changes).length > 0;
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={event.meta.tone}>{event.meta.label}</StatusBadge>
        {event.affectedCount > 1 && (
          <span className="text-xs text-muted-foreground tabular-nums">
            x{event.affectedCount}
          </span>
        )}
      </div>
      {hasChanges && (
        <div className="mt-2">
          <ChangeDiffList changes={event.changes!} entityHint={event.meta.group as ActionGroup} />
        </div>
      )}
      {event.action && <p className="mt-1 text-sm text-muted-foreground">{event.action}</p>}
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <ActorChip actorKind={event.actorKind} actorName={event.actorName} />
        <span aria-hidden>·</span>
        <time dateTime={event.createdAt} title={event.createdAt} className="tabular-nums">
          {formatDateTime(event.createdAt)}
        </time>
      </div>
    </div>
  );
}

function MovementRow({ row }: { row: BatchLedgerRow }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      {row.productName && (
        <div className="mb-1 truncate text-sm font-medium" title={row.productName}>
          {row.productName}
        </div>
      )}
      <LedgerRowLine row={toRenderableRow(row)} />
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {row.userName && <span>{row.userName}</span>}
        {row.userName && <span aria-hidden>·</span>}
        <time dateTime={row.changeTime} title={row.changeTime} className="tabular-nums">
          {formatDateTime(row.changeTime)}
        </time>
      </div>
    </div>
  );
}

export function BatchDrawer({
  batchId,
  onOpenChange,
}: {
  batchId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = batchId != null;
  const [eventsOffset, setEventsOffset] = React.useState(0);
  const [ledgerOffset, setLedgerOffset] = React.useState(0);

  // Reset paging whenever a NEW batch is opened.
  React.useEffect(() => {
    setEventsOffset(0);
    setLedgerOffset(0);
  }, [batchId]);

  const query = useQuery<BatchResponse>({
    queryKey: ["admin-batch", batchId, eventsOffset, ledgerOffset],
    queryFn: async () => {
      const params = new URLSearchParams({
        eventsLimit: String(SECTION_LIMIT),
        eventsOffset: String(eventsOffset),
        ledgerLimit: String(SECTION_LIMIT),
        ledgerOffset: String(ledgerOffset),
      });
      const res = await fetch(`/api/admin/batch/${batchId}?${params}`);
      if (!res.ok) throw new Error("Failed to load batch details");
      return res.json();
    },
    enabled: open,
  });

  const data = query.data;
  const totalEntries = (data?.events.total ?? 0) + (data?.ledgerRows.total ?? 0);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        motion="quick"
        className="w-full p-0 sm:w-[560px] sm:max-w-[600px]"
      >
        {/* sticky header — batch id + copy + counts + close (built-in X, top-right) */}
        <div className="sticky top-0 z-10 border-b border-border bg-background px-4 py-3 pr-12">
          <SheetTitle className="text-base">Batch details</SheetTitle>
          <div className="mt-1 flex items-center gap-1">
            <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {batchId}
            </code>
            {batchId && <CopyButton value={batchId} />}
          </div>
          {data && (
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              {data.events.total} event{data.events.total === 1 ? "" : "s"} ·{" "}
              {data.ledgerRows.total} movement{data.ledgerRows.total === 1 ? "" : "s"}
            </p>
          )}
          {/* Hidden entirely for an events-only batch — the counts line above has
              already said there are no movements to summarise. */}
          {data?.summary && data.summary.rowCount > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">{summaryLine(data.summary)}</p>
          )}
        </div>

        <div className="px-4 py-4">
          {query.isLoading ? (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : query.isError ? (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
              <p className="text-sm text-destructive">Couldn&apos;t load this batch.</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => query.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : totalEntries === 0 ? (
            <p className="text-sm text-muted-foreground">No entries in this batch.</p>
          ) : (
            <div className="space-y-6">
              {/* Events */}
              <section>
                <h3 className="mb-2 text-sm font-semibold">Events</h3>
                {data!.events.items.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No events in this batch.</p>
                ) : (
                  <div className="space-y-2">
                    {data!.events.items.map((e) => (
                      <EventCard key={e.id} event={e} />
                    ))}
                  </div>
                )}
                <SectionPager
                  offset={data!.events.offset}
                  limit={data!.events.limit}
                  total={data!.events.total}
                  label="events"
                  onPrev={() => setEventsOffset((o) => Math.max(0, o - SECTION_LIMIT))}
                  onNext={() => setEventsOffset((o) => o + SECTION_LIMIT)}
                />
              </section>

              {/* Inventory movements */}
              <section>
                <h3 className="mb-2 text-sm font-semibold">Inventory movements</h3>
                {data!.ledgerRows.items.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No inventory movements in this batch.</p>
                ) : (
                  <div className="space-y-2">
                    {data!.ledgerRows.items.map((r) => (
                      <MovementRow key={r.id} row={r} />
                    ))}
                  </div>
                )}
                <SectionPager
                  offset={data!.ledgerRows.offset}
                  limit={data!.ledgerRows.limit}
                  total={data!.ledgerRows.total}
                  label="movements"
                  onPrev={() => setLedgerOffset((o) => Math.max(0, o - SECTION_LIMIT))}
                  onNext={() => setLedgerOffset((o) => o + SECTION_LIMIT)}
                />
              </section>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
