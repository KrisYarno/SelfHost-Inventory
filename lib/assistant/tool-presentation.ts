/**
 * lib/assistant/tool-presentation.ts — CLIENT-SAFE humanized tool copy (spec §12
 * D-B3 / D-B7, codex #2).
 *
 * This module is imported by the chat UI (T3). It MUST NOT import prisma, tools.ts,
 * or anything server-only — it carries no data access, only presentation strings and
 * pure `summarizeArgs` formatters. Raw tool names and JSON NEVER reach the UI; the
 * disclosure rows render these labels instead.
 *
 * `summarizeArgs` renders a phrase-form summary of a tool call's arguments. The
 * returned string is inert text (the UI escapes it); it never interpolates tool
 * OUTPUT, only the (user-derived) call arguments.
 */

export interface ToolPresentation {
  /** In-flight label, e.g. "Looking up sales…". */
  pendingLabel: string;
  /** Completed label, phrase-form, e.g. "Looked up sales". */
  successLabel: string;
  /** Noun for the failure row, e.g. "sales" -> "Assistant could not read sales." */
  failureNoun: string;
  /** Copy shown when the tool succeeded but returned nothing. */
  emptyCopy: string;
  /** Phrase-form summary of the call arguments (no raw JSON, no tool name). */
  summarizeArgs(input: unknown): string;
}

function str(input: unknown, key: string): string | undefined {
  const v = (input as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(input: unknown, key: string): number | undefined {
  const v = (input as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function dateRangePhrase(input: unknown): string {
  const from = str(input, "from");
  const to = str(input, "to");
  if (from && to) return `${from} to ${to}`;
  if (from) return `since ${from}`;
  if (to) return `through ${to}`;
  return "";
}

export const TOOL_PRESENTATION: Record<string, ToolPresentation> = {
  find_product: {
    pendingLabel: "Looking up products…",
    successLabel: "Looked up products",
    failureNoun: "products",
    emptyCopy: "No matching products.",
    summarizeArgs: (input) => {
      const q = str(input, "query");
      return q ? `matching “${q}”` : "";
    },
  },
  get_stock: {
    pendingLabel: "Looking up stock…",
    successLabel: "Looked up stock",
    failureNoun: "stock",
    emptyCopy: "No stock records found.",
    summarizeArgs: (input) => {
      const id = num(input, "productId");
      const range = dateRangePhrase(input);
      const parts = [id ? `product #${id}` : "", range].filter(Boolean);
      return parts.join(", ");
    },
  },
  get_sales: {
    pendingLabel: "Looking up sales…",
    successLabel: "Looked up sales",
    failureNoun: "sales",
    emptyCopy: "No sales in this range.",
    summarizeArgs: (input) => {
      const id = num(input, "productId");
      const range = dateRangePhrase(input);
      const groupBy = str(input, "groupBy");
      const parts = [
        id ? `product #${id}` : "",
        range,
        groupBy ? `by ${groupBy}` : "",
      ].filter(Boolean);
      return parts.join(", ");
    },
  },
  get_operations: {
    pendingLabel: "Reviewing operations…",
    successLabel: "Reviewed operations",
    failureNoun: "operations",
    emptyCopy: "No operations data yet.",
    summarizeArgs: (input) => {
      const windowDays = num(input, "windowDays");
      return windowDays ? `last ${windowDays} days` : "";
    },
  },
  get_shrinkage: {
    pendingLabel: "Looking up shrinkage…",
    successLabel: "Looked up shrinkage",
    failureNoun: "shrinkage",
    emptyCopy: "No shrinkage recorded.",
    summarizeArgs: (input) => {
      const days = num(input, "days");
      return days ? `last ${days} days` : "";
    },
  },
  get_valuation: {
    pendingLabel: "Calculating valuation…",
    successLabel: "Looked up valuation",
    failureNoun: "valuation",
    emptyCopy: "No valuation available.",
    summarizeArgs: () => "",
  },
  low_stock_report: {
    pendingLabel: "Checking low stock…",
    successLabel: "Checked low stock",
    failureNoun: "low-stock report",
    emptyCopy: "Nothing is low on stock right now.",
    summarizeArgs: () => "",
  },
};
