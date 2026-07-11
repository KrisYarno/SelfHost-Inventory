"use client";

/**
 * components/history/ledger-row-line.tsx — one inventory-ledger movement line
 * (Lane 3 spec §11 D-L5). Nested under an event's rail node (or standalone for
 * an orphan entry):
 *   - a `ValueChip` signed delta (positive/negative tone),
 *   - exactly ONE `StatusBadge` for the logType (via `getInventoryLogTone`),
 *   - plain-text reason / location / cost (`tabular-nums` money).
 * When `unassigned`, a muted caption "not linked to a recorded event" — the
 * batch had rows the correlation could not attribute to a specific event
 * (informative, never alarming).
 */

import * as React from "react";
import { cn, formatDelta } from "@/lib/utils";
import { StatusBadge } from "@/components/ui/status-badge";
import { ValueChip } from "@/components/ui/value-chip";
import { getInventoryLogTone } from "@/components/logs/log-style";
import type { RenderableLedgerRow } from "@/lib/history/union-timeline";

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function LedgerRowLine({
  row,
  unassigned,
}: {
  row: RenderableLedgerRow;
  unassigned?: boolean;
}) {
  const logTone = getInventoryLogTone(row.logType, row.delta);

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 text-sm",
        unassigned && "opacity-90",
      )}
    >
      <ValueChip data-testid="ledger-delta-chip" tone={row.delta >= 0 ? "positive" : "negative"}>
        {formatDelta(row.delta)}
      </ValueChip>
      <StatusBadge data-testid="ledger-logtype-badge" tone={logTone.tone}>
        {logTone.label}
      </StatusBadge>
      {row.reasonCode && <span className="text-muted-foreground">{row.reasonCode}</span>}
      {row.locationName && <span className="text-muted-foreground">{row.locationName}</span>}
      {row.unitCostCents != null && (
        <span className="tabular-nums text-muted-foreground">{formatCents(row.unitCostCents)}</span>
      )}
      {unassigned && (
        <span className="w-full text-xs text-muted-foreground">not linked to a recorded event</span>
      )}
    </div>
  );
}
