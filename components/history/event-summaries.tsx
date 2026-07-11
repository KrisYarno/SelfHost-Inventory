/**
 * components/history/event-summaries.tsx — the snapshot/cascade/bulk one-liner
 * (Lane 3 spec §11 D-L5 / D4).
 *
 * The renderable event carries only redaction-safe COUNTS (raw snapshot/cascade
 * JSON is stripped upstream by the allowlist projection), so this is a compact
 * muted summary — "Captured N fields · Cascaded M children · K rows". Renders
 * only the counts that are present; nothing when every count is null/zero.
 */

import * as React from "react";

export function EventSummaries({
  snapshotFieldCount,
  cascadeCount,
  bulkRowCount,
}: {
  snapshotFieldCount: number | null;
  cascadeCount: number | null;
  bulkRowCount: number | null;
}) {
  const parts: string[] = [];

  if (snapshotFieldCount && snapshotFieldCount > 0) {
    parts.push(`Captured ${snapshotFieldCount} field${snapshotFieldCount === 1 ? "" : "s"}`);
  }
  if (cascadeCount && cascadeCount > 0) {
    parts.push(`Cascaded ${cascadeCount} ${cascadeCount === 1 ? "child" : "children"}`);
  }
  if (bulkRowCount && bulkRowCount > 0) {
    parts.push(`${bulkRowCount} row${bulkRowCount === 1 ? "" : "s"}`);
  }

  if (parts.length === 0) return null;

  return <span className="text-xs text-muted-foreground">{parts.join(" · ")}</span>;
}
