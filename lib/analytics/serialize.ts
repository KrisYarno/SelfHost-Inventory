// lib/analytics/serialize.ts — Next-free Decimal serialization for sales rows.
//
// Extracted from lib/analytics/company-scope.ts (codex #4) so the shared assistant
// tool layer (lib/assistant/**) and the MCP sidecar can serialize sales revenue
// WITHOUT dragging Next server internals (lib/api-utils) into their module graph.
// company-scope.ts re-exports this verbatim for the existing analytics routes, so
// their behavior is byte-identical.
//
// This file MUST stay Next-free: no `next/*`, no `@/lib/api-utils`. Enforced by
// the trunk import-walk gate (__tests__/integration/lane4-next-free-gate.test.ts).

/**
 * Serialize the Prisma Decimal `revenue` sum on each sales-groupBy row to a string,
 * leaving every other field untouched, so NextResponse.json (or a tool boundary)
 * never emits a raw Decimal object. Rows without a revenue sum pass through unchanged.
 */
export function serializeSalesRows<T extends object>(rows: T[]): T[] {
  return rows.map((row) => {
    const sum = (row as { _sum?: { revenue?: unknown } })._sum;
    if (sum && sum.revenue != null) {
      return {
        ...row,
        _sum: { ...sum, revenue: (sum.revenue as { toString(): string }).toString() },
      } as T;
    }
    return row;
  });
}
