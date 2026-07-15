/**
 * lib/assistant/window.ts — the ONE window resolver every windowed tool uses
 * (assistant toolsuite breadth, spec §4 W0-WIN + plan-gate #10).
 *
 * Fixes the R2-M6 window ambiguities in one place:
 *   - `relativeDays: N` means EXACTLY N day-keys, so `from = to − (N−1)` (an off-by-one
 *     that made "last 7 days" cover 8).
 *   - `to` without `from` anchors `from` to `to`, not to today.
 *   - `from` + `relativeDays` together is a contradiction and is REJECTED (the schema
 *     registered follow-up — echoed here as a hard AppError so no tool silently picks
 *     one).
 *   - the resolved window echoes its `source` so the model can cite how it was derived.
 *
 * MUST stay Next-free (imported by the assistant-tool layer): no `next/*`, no
 * `@/lib/api-utils`.
 */

import { AppError } from "@/lib/error-handling";
import { toDayKey, dayKeyStart } from "@/lib/analytics/dates";

const DAY_MS = 86_400_000;

export type ResolvedWindow = {
  from: string;
  to: string;
  /** Inclusive day-key count (from..to). For relative/default this equals N. */
  days: number;
  source: "explicit" | "relative" | "default";
};

/** Inclusive day-key count between two ISO day-keys. */
function inclusiveDays(from: string, to: string): number {
  return Math.round((dayKeyStart(to).getTime() - dayKeyStart(from).getTime()) / DAY_MS) + 1;
}

/** Shift an ISO day-key by whole days (UTC, DST-free). */
function shiftDays(dayKey: string, deltaDays: number): string {
  return toDayKey(new Date(dayKeyStart(dayKey).getTime() + deltaDays * DAY_MS));
}

/**
 * Resolve an explicit / relative / default window.
 *
 *  - `from` + `relativeDays` together THROWS (they are mutually exclusive).
 *  - `from` present ⇒ explicit (`to` defaults to today when absent).
 *  - `relativeDays: N` present ⇒ N day-keys ending at `to` (or today): `from = to − (N−1)`.
 *  - neither ⇒ `defaultRelativeDays` day-keys ending at `to` (or today); `source: "default"`.
 */
export function resolveWindow(
  args: { from?: string; to?: string; relativeDays?: number },
  now: Date,
  defaultRelativeDays?: number,
): ResolvedWindow {
  if (args.from != null && args.relativeDays != null) {
    throw new AppError("from and relativeDays are mutually exclusive", "VALIDATION", 400);
  }

  const to = args.to ?? toDayKey(now);

  if (args.from != null) {
    return { from: args.from, to, days: inclusiveDays(args.from, to), source: "explicit" };
  }

  if (args.relativeDays != null) {
    const from = shiftDays(to, -(args.relativeDays - 1));
    return { from, to, days: args.relativeDays, source: "relative" };
  }

  const n = defaultRelativeDays ?? 1;
  const from = shiftDays(to, -(n - 1));
  return { from, to, days: n, source: "default" };
}
