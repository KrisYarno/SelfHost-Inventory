"use client";

/**
 * components/admin/usage/token-rollup-table.tsx — the per-user/day token table with
 * the model + kind breakdown (spec C8).
 *
 * The one rule that shapes every cell: a NULL token column means "the provider never
 * reported usage for these requests", which is NOT the same fact as zero tokens. Nulls
 * render as the named reason, and the totals row adds only the REPORTED values — a
 * column whose contributors are all null totals to the reason too.
 *
 * Counts (requests / aborted / errored / running / no-usage) are measured zeroes and
 * render as 0, because a counted zero IS the truth.
 */

import { USAGE_DEFINITIONS, NOT_REPORTED_LABEL, EMPTY_ROLLUP_REASON } from "./usage-definitions";
import type { AssistantUsageRollup } from "@/hooks/use-assistant-usage";

type TokenColumn = "inputTokens" | "outputTokens" | "totalTokens";
type CountColumn = "requests" | "aborted" | "errored" | "running" | "nullUsageRequests";

const COUNT_COLUMNS: Array<{ key: CountColumn; label: string }> = [
  { key: "requests", label: "Requests" },
  { key: "aborted", label: "Aborted" },
  { key: "errored", label: "Errored" },
  { key: "running", label: "Running" },
  { key: "nullUsageRequests", label: "No usage" },
];

const TOKEN_COLUMNS: Array<{ key: TokenColumn; label: string }> = [
  { key: "inputTokens", label: "Input" },
  { key: "outputTokens", label: "Output" },
  { key: "totalTokens", label: "Total" },
];

/** Null-PRESERVING addition — the table-side twin of the route's `addReported`. */
function addReported(accumulated: number | null, next: number | null): number | null {
  if (next === null) return accumulated;
  return (accumulated ?? 0) + next;
}

function TokenCell({ value, testId }: { value: number | null; testId: string }) {
  return (
    <td className="px-3 py-2 text-right tabular-nums" data-testid={testId}>
      {value === null ? (
        <span className="text-muted-foreground">{NOT_REPORTED_LABEL}</span>
      ) : (
        value.toLocaleString("en-US")
      )}
    </td>
  );
}

export function TokenRollupTable({ rollups }: { rollups: AssistantUsageRollup[] }) {
  if (rollups.length === 0) {
    return <p className="p-4 text-body-sm text-muted-foreground sm:p-6">{EMPTY_ROLLUP_REASON}</p>;
  }

  const totals = rollups.reduce(
    (acc, row) => ({
      requests: acc.requests + row.requests,
      aborted: acc.aborted + row.aborted,
      errored: acc.errored + row.errored,
      running: acc.running + row.running,
      nullUsageRequests: acc.nullUsageRequests + row.nullUsageRequests,
      inputTokens: addReported(acc.inputTokens, row.inputTokens),
      outputTokens: addReported(acc.outputTokens, row.outputTokens),
      totalTokens: addReported(acc.totalTokens, row.totalTokens),
    }),
    {
      requests: 0,
      aborted: 0,
      errored: 0,
      running: 0,
      nullUsageRequests: 0,
      inputTokens: null as number | null,
      outputTokens: null as number | null,
      totalTokens: null as number | null,
    },
  );

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] text-body-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Day (UTC)</th>
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium">Kind</th>
              {TOKEN_COLUMNS.map((column) => (
                <th
                  key={column.key}
                  className="px-3 py-2 text-right font-medium"
                  title={USAGE_DEFINITIONS[column.key]}
                >
                  {column.label}
                </th>
              ))}
              {COUNT_COLUMNS.map((column) => (
                <th
                  key={column.key}
                  className="px-3 py-2 text-right font-medium"
                  title={USAGE_DEFINITIONS[column.key]}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rollups.map((row) => (
              <tr key={`${row.userId}-${row.dayKey}-${row.model}-${row.kind}`}>
                <td className="px-3 py-2 font-medium">{row.displayName}</td>
                <td className="px-3 py-2 tabular-nums text-muted-foreground">{row.dayKey}</td>
                <td className="px-3 py-2 text-muted-foreground">{row.model}</td>
                <td className="px-3 py-2 text-muted-foreground">{row.kind}</td>
                {TOKEN_COLUMNS.map((column) => (
                  <TokenCell
                    key={column.key}
                    value={row[column.key]}
                    testId={`cell-${column.key}`}
                  />
                ))}
                {COUNT_COLUMNS.map((column) => (
                  <td
                    key={column.key}
                    className="px-3 py-2 text-right tabular-nums"
                    data-testid={`cell-${column.key}`}
                  >
                    {row[column.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border font-medium" data-testid="rollup-totals">
              <td className="px-3 py-2" colSpan={4}>
                All rows in range
              </td>
              {TOKEN_COLUMNS.map((column) => (
                <TokenCell
                  key={column.key}
                  value={totals[column.key]}
                  testId={`cell-${column.key}`}
                />
              ))}
              {COUNT_COLUMNS.map((column) => (
                <td
                  key={column.key}
                  className="px-3 py-2 text-right tabular-nums"
                  data-testid={`cell-${column.key}`}
                >
                  {totals[column.key]}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Definitions ride with the numbers (house convention). */}
      <dl className="space-y-1 border-t border-border p-4 text-body-sm text-muted-foreground sm:p-6">
        {[...TOKEN_COLUMNS, ...COUNT_COLUMNS].map((column) => (
          <div key={column.key} className="flex flex-wrap gap-x-2">
            <dt className="sr-only">{column.label}</dt>
            <dd>{USAGE_DEFINITIONS[column.key]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
