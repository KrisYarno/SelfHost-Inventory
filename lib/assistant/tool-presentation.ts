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

/** A boolean flag, strictly: only `true` counts (streamed args carry junk). */
function flag(input: unknown, key: string): boolean {
  return (input as Record<string, unknown> | null | undefined)?.[key] === true;
}

/** A boolean flag whose DEFAULT is true, strictly: only an explicit `false` narrows.
 *  Anything else — absent, true, streamed junk — is the default population (FD-8). */
function offFlag(input: unknown, key: string): boolean {
  return (input as Record<string, unknown> | null | undefined)?.[key] === false;
}

/**
 * The bounded-set phrase for a productIds argument (OC-5): "products #1, #2, #3". A
 * disclosure row that omits the set renders a bounded call exactly like the catalog-wide
 * one, which is the scope claim spec C4 exists to prevent. Non-numeric entries are
 * dropped rather than rendered — the phrase must stay inert for streamed/partial args.
 */
function productsPhrase(input: unknown, key: string): string {
  const v = (input as Record<string, unknown> | null | undefined)?.[key];
  if (!Array.isArray(v)) return "";
  const ids = v.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  return ids.length ? `products ${ids.map((n) => `#${n}`).join(", ")}` : "";
}

/** The window phrase for tools whose window resolver defaults to relativeDays 30
 *  (get_sales / get_movement_series / compare_periods' periods). */
const DEFAULT_RELATIVE_WINDOW_PHRASE = "last 30 days (default)";

/**
 * Render a tool call's window as a phrase (spec C4, UI half — review F12). Explicit
 * dates win; `relativeDays` renders "last N days"; when the call carries neither, the
 * caller supplies the PER-TOOL default descriptor — there is no universal fallback,
 * because the tools do not share a default window (get_stock has none at all, and
 * get_operations takes windowDays instead). Returns "" when no default is given.
 */
function dateRangePhrase(input: unknown, dflt?: string): string {
  const from = str(input, "from");
  const to = str(input, "to");
  if (from && to) return `${from} to ${to}`;
  if (from) return `since ${from}`;
  if (to) return `through ${to}`;
  const relativeDays = num(input, "relativeDays");
  if (relativeDays) return `last ${relativeDays} days`;
  return dflt ?? "";
}

/** One compare_periods period ({from,to} | {relativeDays} | {}), same resolver
 *  defaults as the tool (relativeDays 30). */
function periodPhrase(period: unknown): string {
  return dateRangePhrase(period, DEFAULT_RELATIVE_WINDOW_PHRASE);
}

export const TOOL_PRESENTATION: Record<string, ToolPresentation> = {
  find_product: {
    pendingLabel: "Looking up products…",
    successLabel: "Looked up products",
    failureNoun: "products",
    emptyCopy: "No matching products.",
    summarizeArgs: (input) => {
      const q = str(input, "query");
      // OC-5 (QA-3): includeArchived widens the population from the LIVE catalog to live
      // + DELETED products. A row that reads the same either way tells the reader a
      // retired product could not have been among the matches when it could.
      const parts = [
        q ? `matching “${q}”` : "",
        flag(input, "includeArchived") ? "incl. deleted" : "",
      ].filter(Boolean);
      return parts.join(", ");
    },
  },
  get_stock: {
    pendingLabel: "Looking up stock…",
    successLabel: "Looked up stock",
    failureNoun: "stock",
    emptyCopy: "No stock records found.",
    summarizeArgs: (input) => {
      const id = num(input, "productId");
      const locationId = num(input, "locationId");
      // get_stock has NO default window — it pages the whole recorded snapshot history
      // newest-first, so a "last 30 days" fallback here would be a false disclosure.
      const range = dateRangePhrase(input, "all recorded days (paged)");
      const parts = [
        id ? `product #${id}` : "",
        locationId ? `location #${locationId}` : "",
        range,
      ].filter(Boolean);
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
      const range = dateRangePhrase(input, DEFAULT_RELATIVE_WINDOW_PHRASE);
      const groupBy = str(input, "groupBy");
      const parts = [
        id ? `product #${id}` : "",
        range,
        groupBy ? `by ${groupBy}` : "",
        // OC-5: includeZeroRows changes WHICH PRODUCTS the answer covers (the whole
        // approved catalog, not just those with sales), so the row must say so.
        flag(input, "includeZeroRows") ? "incl. zero-sales products" : "",
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
      const id = num(input, "productId");
      // get_operations takes `windowDays` (30 | 90, default 90) — NOT relativeDays and
      // NOT from/to. Rendering "last N days" from an argument this tool ignores would
      // disclose a window it never queried.
      const windowDays = num(input, "windowDays");
      const parts = [
        id ? `product #${id}` : "",
        windowDays ? `${windowDays}-day window` : "90-day window (default)",
      ].filter(Boolean);
      return parts.join(", ");
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
    summarizeArgs: (input) => {
      const id = num(input, "productId");
      const groupBy = str(input, "groupBy");
      const parts = [id ? `product #${id}` : "", groupBy ? `by ${groupBy}` : ""].filter(Boolean);
      return parts.join(", ");
    },
  },
  get_movement_series: {
    pendingLabel: "Building the movement series…",
    successLabel: "Built the movement series",
    failureNoun: "movement series",
    emptyCopy: "No movement in this range.",
    summarizeArgs: (input) => {
      const id = num(input, "productId");
      const locationId = num(input, "locationId");
      const range = dateRangePhrase(input, DEFAULT_RELATIVE_WINDOW_PHRASE);
      const groupBy = str(input, "groupBy");
      const receipts = flag(input, "receipts");
      // OC-5: breakdownBy and productIds are the two arguments that change the SHAPE and
      // the SCOPE of this answer (per-product rows; a bounded set) — rendering neither
      // made a bounded per-product call look identical to a catalog-wide series.
      const breakdown = str(input, "breakdownBy") ? "per product" : "";
      const parts = [
        id ? `product #${id}` : "",
        productsPhrase(input, "productIds"),
        locationId ? `location #${locationId}` : "",
        range,
        receipts ? "receipts" : breakdown || (groupBy ? `by ${groupBy}` : ""),
      ].filter(Boolean);
      return parts.join(", ");
    },
  },
  get_stock_asof: {
    pendingLabel: "Looking up as-of stock…",
    successLabel: "Looked up as-of stock",
    failureNoun: "as-of stock",
    emptyCopy: "No snapshot for that day.",
    summarizeArgs: (input) => {
      const day = str(input, "dayKey");
      const id = num(input, "productId");
      const parts = [day ? `on ${day}` : "", id ? `product #${id}` : ""].filter(Boolean);
      return parts.join(", ");
    },
  },
  compare_periods: {
    pendingLabel: "Comparing periods…",
    successLabel: "Compared periods",
    failureNoun: "period comparison",
    emptyCopy: "Nothing to compare in those periods.",
    summarizeArgs: (input) => {
      const metric = str(input, "metric");
      const id = num(input, "productId");
      // Render BOTH periods (it rendered neither): a comparison disclosure that names
      // no windows tells the reader nothing about what was compared.
      const rec = input as Record<string, unknown> | null | undefined;
      const direction = str(input, "direction");
      const parts = [
        metric ? metric.replace(/_/g, " ") : "",
        `${periodPhrase(rec?.periodA)} vs ${periodPhrase(rec?.periodB)}`,
        id ? `product #${id}` : "",
        // OC-5: groupBy:'product' returns a RANKED ROW SET (not one comparison) and
        // direction FILTERS it before paging — both are scope, not decoration.
        str(input, "groupBy") ? "per product" : "",
        direction ? `${direction} only` : "",
      ].filter(Boolean);
      return parts.join(", ");
    },
  },
  get_order_pipeline: {
    pendingLabel: "Reviewing the order pipeline…",
    successLabel: "Reviewed the order pipeline",
    failureNoun: "order pipeline",
    emptyCopy: "No orders in this range.",
    summarizeArgs: (input) => {
      const range = dateRangePhrase(input);
      const groupBy = str(input, "groupBy");
      const parts = [range, groupBy ? `by ${groupBy}` : ""].filter(Boolean);
      return parts.join(", ");
    },
  },
  get_inventory_summary: {
    pendingLabel: "Summarizing inventory…",
    successLabel: "Summarized inventory",
    failureNoun: "inventory summary",
    emptyCopy: "No inventory to summarize.",
    summarizeArgs: (input) => {
      const rankBy = str(input, "rankBy");
      return rankBy ? `ranked by ${rankBy}` : "";
    },
  },
  get_inventory_policy: {
    pendingLabel: "Looking up policy…",
    successLabel: "Looked up policy",
    failureNoun: "inventory policy",
    emptyCopy: "No policy on file.",
    summarizeArgs: (input) => {
      const id = num(input, "productId");
      return id ? `product #${id}` : "global defaults";
    },
  },
  get_data_freshness: {
    pendingLabel: "Checking data freshness…",
    successLabel: "Checked data freshness",
    failureNoun: "data freshness",
    emptyCopy: "No freshness data available.",
    summarizeArgs: () => "",
  },
  low_stock_report: {
    pendingLabel: "Checking low stock…",
    successLabel: "Checked low stock",
    failureNoun: "low-stock report",
    emptyCopy: "Nothing is low on stock right now.",
    summarizeArgs: () => "",
  },
  reorder_report: {
    pendingLabel: "Building the reorder report…",
    successLabel: "Built the reorder report",
    failureNoun: "reorder report",
    emptyCopy: "Nothing needs reordering right now.",
    // OC-5: this rendered "" for every call, so a NAMED-SET sizing (productIds) was
    // disclosed exactly like the catalog-wide worklist. EVERY argument that changes the
    // population the answer covers is rendered.
    //
    // FD-8: includeOkay is one of them and was omitted. It defaults to TRUE, so
    // `includeOkay:false` is a caller NARROWING the report to the urgent worklist —
    // dropping the APPROACHING rows — and the disclosure row read identically either way.
    // Both states are stated, because "which rows are missing" is not decoration.
    summarizeArgs: (input) => {
      const parts = [
        productsPhrase(input, "productIds"),
        offFlag(input, "includeOkay") ? "worklist only" : "incl. approaching",
        flag(input, "includeHealthy") ? "incl. healthy" : "",
      ].filter(Boolean);
      return parts.join(", ");
    },
  },
  get_product_overview: {
    pendingLabel: "Building the product overview…",
    successLabel: "Built the product overview",
    failureNoun: "product overview",
    emptyCopy: "No overview available for that product.",
    summarizeArgs: (input) => {
      const id = num(input, "productId");
      return id ? `product #${id}` : "";
    },
  },
  get_business_snapshot: {
    pendingLabel: "Building the business snapshot…",
    successLabel: "Built the business snapshot",
    failureNoun: "business snapshot",
    emptyCopy: "No snapshot data available yet.",
    summarizeArgs: () => "",
  },
};
