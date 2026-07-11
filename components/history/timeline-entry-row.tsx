"use client";

/**
 * components/history/timeline-entry-row.tsx — the shared timeline row (Lane 3
 * spec §11 D-L5). One renderer, two scopes (History tab + admin feed).
 *
 * Rail reuses the `activity-timeline` motif: a neutral 8px-ish node (2px
 * `border-border`) with the actionGroup icon muted inside, and a `w-px bg-border`
 * connector. An 'event' entry renders:
 *   - primary line: the core field change (`ChangeDiffList`) when changes exist;
 *   - supporting line: action label · context (muted);
 *   - a compact snapshot/cascade/bulk summary (`EventSummaries`);
 *   - metadata line: `ActorChip` · relative time (exact-ms ISO in `title`);
 *   - a batch chip (drill-down) when a `batchId` + `onBatchClick` are present;
 *   - nested `LedgerRowLine`s under the connector behind an "N movements"
 *     disclosure (`defaultExpanded` seeds it), plus any `unassignedRows` with
 *     the "not linked to a recorded event" caption.
 * A restricted event (R-L5) renders the stub `action` and NO diff content.
 *
 * A 'ledger' orphan entry renders its rows inline (always visible) under a
 * distinct label — `legacy-unlinked` vs `missing-summary-event`.
 */

import * as React from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Boxes,
  Building2,
  ChevronDown,
  CircleHelp,
  Inbox,
  KeyRound,
  Link2,
  MapPin,
  Package,
  PencilLine,
  Plug,
  Server,
  ShoppingCart,
  Sliders,
  User,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/ui/status-badge";
import type { ActionGroup } from "@/lib/change-tracking/taxonomy";
import type { TimelineEntry, RenderableLedgerRow } from "@/lib/history/union-timeline";
import { ChangeDiffList } from "@/components/history/change-diff-list";
import { LedgerRowLine } from "@/components/history/ledger-row-line";
import { ActorChip } from "@/components/history/actor-chip";
import { EventSummaries } from "@/components/history/event-summaries";

const GROUP_ICON: Record<ActionGroup, LucideIcon> = {
  PRODUCT: Package,
  INVENTORY: Boxes,
  ORDER: ShoppingCart,
  STAGING: Inbox,
  SCRATCHPAD: PencilLine,
  USER: User,
  ACCOUNT: KeyRound,
  COMPANY: Building2,
  INTEGRATION: Plug,
  MAPPING: Link2,
  LOCATION: MapPin,
  SETTINGS: Sliders,
  SYSTEM: Server,
  UNKNOWN: CircleHelp,
};

const ORPHAN_LABEL: Record<"legacy-unlinked" | "missing-summary-event", string> = {
  "legacy-unlinked": "Unlinked movement",
  "missing-summary-event": "Movement without a recorded action",
};

function relativeTime(ts: string): string {
  return formatDistanceToNow(new Date(ts), { addSuffix: true });
}

/** The rail column: neutral node + downward connector (activity-timeline motif). */
function Rail({ Icon }: { Icon: LucideIcon }) {
  return (
    <div className="relative flex flex-col items-center self-stretch">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-border bg-background">
        <Icon aria-hidden className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="w-px flex-1 bg-border" />
    </div>
  );
}

function NestedRows({
  ledgerRows,
  unassignedRows,
}: {
  ledgerRows: RenderableLedgerRow[];
  unassignedRows: RenderableLedgerRow[];
}) {
  return (
    <div className="mt-1 space-y-1 border-l border-border pl-3 duration-150 animate-in fade-in-0 motion-reduce:animate-none motion-reduce:transition-none">
      {ledgerRows.map((r) => (
        <LedgerRowLine key={r.id} row={r} />
      ))}
      {unassignedRows.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground">not linked to a recorded event</p>
          {unassignedRows.map((r) => (
            <LedgerRowLine key={r.id} row={r} />
          ))}
        </>
      )}
    </div>
  );
}

export function TimelineEntryRow({
  entry,
  defaultExpanded,
  onBatchClick,
}: {
  entry: TimelineEntry;
  defaultExpanded?: boolean;
  onBatchClick?: (batchId: string) => void;
}) {
  const [expanded, setExpanded] = React.useState(defaultExpanded ?? false);

  if (entry.kind === "ledger") {
    return (
      <div className="flex gap-3">
        <Rail Icon={Boxes} />
        <div className="min-w-0 flex-1 space-y-1 pb-4">
          <p data-testid="orphan-label" className="text-sm text-muted-foreground">
            {ORPHAN_LABEL[entry.orphanKind]}
          </p>
          <time
            dateTime={entry.ts}
            title={entry.ts}
            className="text-xs text-muted-foreground"
          >
            {relativeTime(entry.ts)}
          </time>
          <div className="space-y-1 pt-1">
            {entry.ledgerRows.map((r) => (
              <LedgerRowLine key={r.id} row={r} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const { event, ledgerRows, unassignedRows } = entry;
  const hasChanges = !event.restricted && !!event.changes && Object.keys(event.changes).length > 0;
  const nestedCount = ledgerRows.length + unassignedRows.length;
  const Icon = GROUP_ICON[event.meta.group] ?? CircleHelp;

  return (
    <div className="flex gap-3">
      <Rail Icon={Icon} />
      <div className="min-w-0 flex-1 space-y-1 pb-4">
        {hasChanges && (
          <ChangeDiffList changes={event.changes!} entityHint={event.meta.group} />
        )}

        <p className="text-sm text-muted-foreground">
          {event.restricted ? (
            event.action
          ) : (
            <>
              <span className="text-foreground">{event.meta.label}</span>
              {event.action ? ` · ${event.action}` : ""}
            </>
          )}
        </p>

        {!event.restricted && (
          <EventSummaries
            snapshotFieldCount={event.snapshotFieldCount}
            cascadeCount={event.cascadeCount}
            bulkRowCount={event.bulkRowCount}
          />
        )}

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <ActorChip actorKind={event.actorKind} actorName={event.actorName} />
          <span aria-hidden>·</span>
          <time dateTime={event.ts} title={event.ts}>
            {relativeTime(event.ts)}
          </time>
          {event.batchId && onBatchClick && (
            <button
              type="button"
              onClick={() => onBatchClick(event.batchId!)}
              className="inline-flex min-h-[44px] items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <StatusBadge tone="neutral" className="cursor-pointer">
                View batch
              </StatusBadge>
            </button>
          )}
        </div>

        {nestedCount > 0 && (
          <div>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex min-h-[44px] items-center gap-1 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="tabular-nums">
                {nestedCount} movement{nestedCount === 1 ? "" : "s"}
              </span>
              <ChevronDown
                aria-hidden
                className={cn(
                  "h-4 w-4 transition-transform duration-150 motion-reduce:transition-none",
                  expanded && "rotate-180",
                )}
              />
            </button>
            {expanded && (
              <NestedRows ledgerRows={ledgerRows} unassignedRows={unassignedRows} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
