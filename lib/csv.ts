// Single source of truth for RFC 4180 CSV serialization, shared by the client
// download path (lib/export-utils.ts) and the server-side export routes.
// Server-safe: no browser globals, no heavy imports.
//
// SECURITY (Lane 5 S7): this DOES neutralize CSV formula injection. A cell whose
// first character is one of = + - @ TAB CR is a formula/DDE trigger in Excel and
// Google Sheets; it is prefixed with a single quote (') so the spreadsheet treats
// the whole cell as literal text. One implementation, both paths (server routes +
// client exportToCSV re-export it), so every export surface is neutralized.

// Leading characters that turn a cell into an executable formula / DDE payload.
const CSV_FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Escape a single CSV cell per RFC 4180, with formula-injection neutralization.
 * - null/undefined => "" (empty field)
 * - prefixes `'` when the first char is = + - @ TAB or CR (formula neutralization),
 *   applied BEFORE quoting so a prefixed value that also contains a delimiter is
 *   still wrapped correctly.
 * - wraps in double quotes and doubles interior quotes when the value contains a
 *   comma, double-quote, CR, or LF (the newline case is the bug the mass-update
 *   route's hand-rolled escaper missed).
 * - `alwaysQuote` forces wrapping even for plain values (preserves the two export
 *   routes that historically quoted every cell — byte-identical output).
 */
export function escapeCSVCell(value: unknown, alwaysQuote = false): string {
  if (value === null || value === undefined) return "";
  let str = String(value);
  if (CSV_FORMULA_LEAD.test(str)) {
    str = `'${str}`;
  }
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
