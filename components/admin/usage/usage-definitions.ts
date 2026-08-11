/**
 * components/admin/usage/usage-definitions.ts — the prose that rides with the numbers
 * on the assistant usage page (spec C8).
 *
 * House convention: a definition string travels with every rate/aggregate. These are
 * the ONE copy of those definitions, so the table header, the totals row and the
 * incomplete-requests disclosure can never describe the same column two ways.
 *
 * Two prohibitions are enforced BY THE WORDING here, not just by the API:
 *   - tokens only — no dollar/price vocabulary appears on this page (Kris decision 2);
 *   - no private conversation text — the page speaks in ids, counts and tokens.
 */

/** Column definitions for the per-user/day rollup table. Keys match the T11 fields. */
export const USAGE_DEFINITIONS = {
  requests:
    "Requests — every model call attributed to this user, day, model and kind, whatever its outcome.",
  inputTokens: "Input tokens — as reported by the provider. Never estimated, never derived.",
  outputTokens: "Output tokens — as reported by the provider. Never estimated, never derived.",
  totalTokens:
    "Total tokens — the provider's own total, not input plus output re-added here.",
  aborted: "Aborted — the user stopped the answer mid-stream. Real usage, still attributed.",
  errored:
    "Errored — the call failed, including the 60-second provider timeout. Real usage, still attributed.",
  running:
    "Running — never finalized: still streaming, or the process died mid-turn. Incomplete, not lost.",
  nullUsageRequests:
    "No usage reported — requests whose token columns are NULL: the call ended (or is still running) without the provider reporting any. OVERLAPS Running: a still-running request counts in both until it finalizes. Counted as attempts, never as 0 tokens.",
} as const;

export const TOOL_MIX_DEFINITION =
  "Tool calls — one row per tool invocation, across BOTH assistant surfaces (web chat " +
  "and MCP). Broader than the request rollups above, which count web-chat requests " +
  "only: MCP tool runs have no request row.";

export const TOKENS_ONLY_NOTE =
  "Tokens only. Token counts are provider-reported facts; this page never estimates money.";

export const PRIVACY_NOTE =
  "Ids, counts and token totals only — the text of anyone's chats never appears on this page.";

/** Shown wherever a nullable token figure has no reported value. */
export const NOT_REPORTED_LABEL = "not reported";

export const EMPTY_ROLLUP_REASON =
  "No assistant requests fall in this range — there is nothing to roll up, which is not the same as zero tokens.";

export const EMPTY_TOOL_MIX_REASON = "No tool calls recorded in this range.";

/**
 * MOUNT POINT id for the C9 bounded-eval + user-report section, which task 3.2 owns.
 * 3.1 renders the empty anchor and nothing else; 3.2 fills it.
 */
export const EVAL_SECTION_MOUNT_ID = "assistant-eval";
