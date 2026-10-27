/**
 * components/assistant/code-copy.ts — what a fenced block's Copy button writes
 * (assistant A1 pack C2b). React-free and Next-free, so it loads under the root
 * jest transform and is bundled (not external) into the markdown render probe.
 *
 * Contract:
 *   - `text/plain` is ALWAYS the exact block text, never altered;
 *   - a `csv` block ALSO carries a `text/html` table of the same cells, because
 *     spreadsheets (Excel, Numbers, Sheets) paste an HTML table as cells but paste
 *     CSV text into a single column. Cell values are unaltered — only HTML-escaped;
 *     the table carries NO attributes (a formula-leading value such as `=SUM(...)`
 *     is registered, not rewritten: values are never altered);
 *   - any failure of the rich write, a missing API, or any other language falls
 *     back to `writeText(value)`.
 */

/**
 * RFC-4180 parse: comma-separated fields; a double-quoted field may hold commas,
 * `""` (one literal quote) and CR/LF; rows end at CRLF, LF or CR; a single trailing
 * line break adds no row; an empty text has no rows. Lenient on malformed input —
 * a quote that does not open a field is literal, text after a closing quote is kept,
 * and an unterminated quote runs to the end — so a value is never dropped.
 *
 * One leniency beyond RFC 4180 (A1 pack C11): at a field start, spaces and tabs
 * followed by a `"` are skipped and the field parses as quoted, so a model's
 * `Alpha 5mg, "1,234.50", 10` is three cells, not four. Spaces before an UNQUOTED
 * value are kept as written.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let atFieldStart = true;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (atFieldStart && (ch === " " || ch === "\t")) {
      let j = i;
      while (text[j] === " " || text[j] === "\t") j++;
      if (text[j] === '"') {
        i = j;
        quoted = true;
        atFieldStart = false;
        continue;
      }
    }
    if (ch === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      atFieldStart = true;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      atFieldStart = true;
      continue;
    }
    field += ch;
    atFieldStart = false;
  }

  // A row is open unless the text ended exactly at a line break (or was empty).
  if (row.length > 0 || !atFieldStart) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * The rows as a bare HTML table: row 1 is the header (`th`), the rest are body rows
 * (`td`); every cell HTML-escaped; no attributes anywhere. No rows -> "".
 */
export function rowsToHtmlTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const cells = (row: string[], tag: "th" | "td") =>
    row.map((cell) => `<${tag}>${escapeHtml(cell)}</${tag}>`).join("");
  const [header, ...body] = rows;
  return (
    `<table><thead><tr>${cells(header, "th")}</tr></thead>` +
    `<tbody>${body.map((row) => `<tr>${cells(row, "td")}</tr>`).join("")}</tbody></table>`
  );
}

/**
 * Copy a fenced block. A `csv` block (the language matched case-insensitively, so
 * ```CSV too) with the rich clipboard API available and at least one parsed row is
 * written ONCE as `text/plain` (the exact value) plus `text/html` (its table); if
 * that write rejects — or for any other language or a missing API — the exact value
 * is written with `writeText`. Rejects only when `writeText` itself does (the caller
 * shows "Could not copy").
 */
export async function copyCodeBlock(
  value: string,
  language: string,
  env: {
    clipboard: { writeText(t: string): Promise<void>; write?(items: unknown[]): Promise<void> };
    ClipboardItem?: new (items: Record<string, Blob>) => unknown;
  },
): Promise<void> {
  const { clipboard, ClipboardItem } = env;
  if (language.toLowerCase() === "csv" && typeof clipboard.write === "function" && typeof ClipboardItem === "function") {
    const rows = parseCsv(value);
    if (rows.length > 0) {
      try {
        await clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([value], { type: "text/plain" }),
            "text/html": new Blob([rowsToHtmlTable(rows)], { type: "text/html" }),
          }),
        ]);
        return;
      } catch {
        // The rich write is refused (permissions, an unsupported type): fall back to
        // the plain text below — the exact block is still copied.
      }
    }
  }
  await clipboard.writeText(value);
}
