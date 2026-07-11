"use client";

import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { CheckCircle2, XCircle, Loader2, MinusCircle } from "lucide-react";
import type { RebuildRunRow } from "@/hooks/use-admin";

// Dense run-history table (spec §11 D-L1: a separate "Rebuild history" table,
// distinct from the current-health rows). Telemetry read-only; newest first.

function toneFor(status: string): { tone: StatusTone; Icon: typeof CheckCircle2 } {
  switch (status) {
    case "SUCCEEDED":
      return { tone: "positive", Icon: CheckCircle2 };
    case "FAILED":
      return { tone: "negative", Icon: XCircle };
    case "RUNNING":
      return { tone: "info", Icon: Loader2 };
    default: // ABORTED / unknown
      return { tone: "warning", Icon: MinusCircle };
  }
}

function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function duration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function RebuildHistoryTable({ runs }: { runs: RebuildRunRow[] }) {
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No rebuild runs recorded yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-medium">Job</th>
            <th className="px-3 py-2 font-medium">Mode</th>
            <th className="px-3 py-2 font-medium">Source</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Started</th>
            <th className="px-3 py-2 font-medium">Duration</th>
            <th className="px-3 py-2 font-medium">Window</th>
            <th className="px-3 py-2 font-medium text-right tabular-nums">Rows +/−</th>
            <th className="px-3 py-2 font-medium">Detail</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {runs.map((r) => {
            const { tone, Icon } = toneFor(r.status);
            return (
              <tr key={r.id} className="align-top">
                <td className="px-3 py-2 font-medium">{r.job}</td>
                <td className="px-3 py-2 text-muted-foreground">{r.mode}</td>
                <td className="px-3 py-2 text-muted-foreground">{r.source}</td>
                <td className="px-3 py-2">
                  <StatusBadge tone={tone} className="inline-flex items-center gap-1">
                    <Icon className="h-3 w-3" aria-hidden />
                    {r.status}
                  </StatusBadge>
                </td>
                <td className="px-3 py-2 text-muted-foreground" title={new Date(r.startedAt).toISOString()}>
                  {relative(r.startedAt)}
                </td>
                <td className="px-3 py-2 tabular-nums text-muted-foreground">{duration(r.durationMs)}</td>
                <td className="px-3 py-2 tabular-nums text-muted-foreground">
                  {r.windowFrom || r.windowTo ? `${r.windowFrom ?? "—"} → ${r.windowTo ?? "—"}` : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  <span className="text-positive">+{r.rowsInserted}</span>
                  {" / "}
                  <span className="text-negative">−{r.rowsDeleted}</span>
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {r.error ? (
                    <span className="text-negative">{r.error}</span>
                  ) : r.skippedReason ? (
                    r.skippedReason
                  ) : r.unattributed > 0 ? (
                    `${r.unattributed} unattributed`
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
