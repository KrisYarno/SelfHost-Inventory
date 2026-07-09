// Single source of truth for RFC 4180 CSV serialization, shared by the client
// download path (lib/export-utils.ts) and the server-side export routes.
// Server-safe: no browser globals, no heavy imports.
//
// NOTE: this intentionally does NOT neutralize CSV formula injection (leading
// '=', '+', '-', '@'). The prior client behavior did not either; adding it would
// change output for such cells and is out of scope for this consolidation.

/**
 * Escape a single CSV cell per RFC 4180.
 * - null/undefined => "" (empty field)
 * - wraps in double quotes and doubles interior quotes when the value contains a
 *   comma, double-quote, CR, or LF (the newline case is the bug the mass-update
 *   route's hand-rolled escaper missed).
 * - `alwaysQuote` forces wrapping even for plain values (preserves the two export
 *   routes that historically quoted every cell — byte-identical output).
 */
export function escapeCSVCell(value: unknown, alwaysQuote = false): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (
    alwaysQuote ||
    str.includes(",") ||
    str.includes('"') ||
    str.includes("\n") ||
    str.includes("\r")
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Serialize a matrix of rows (caller includes the header row) to a CSV string.
 * Rows are joined with "\n"; cells with `escapeCSVCell`.
 */
export function rowsToCSV(rows: unknown[][], opts: { alwaysQuote?: boolean } = {}): string {
  return rows
    .map((row) => row.map((cell) => escapeCSVCell(cell, opts.alwaysQuote)).join(","))
    .join("\n");
}
