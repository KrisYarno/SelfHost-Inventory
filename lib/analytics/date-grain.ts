/**
 * lib/analytics/date-grain.ts — the ONE home for calendar-grain bucket keys and the
 * deterministic string-key comparator shared by the sales roll-up (lib/assistant/
 * tools.ts) and the movement series (lib/reports/movement.ts).
 *
 * PRE-W3 DEDUP (both DUAL seam-check halves demanded it — a duplicated `weekStartKey`
 * and an inline month `.slice(0, 7)` in two files is a grain-divergence hazard the
 * moment one is edited without the other). This module is the single definition;
 * tools.ts and movement.ts import from here instead of carrying verbatim copies.
 * Zero behavior change — the existing week/month roll-up and reconciliation tests
 * stay green unchanged.
 *
 * MUST stay Next-free (imported by the assistant-tool + report layers): no `next/*`,
 * no `@/lib/api-utils`.
 */

import { toDayKey } from "@/lib/analytics/dates";

const DAY_MS = 86_400_000;

/**
 * ISO-week bucket key: the Monday (UTC) of the week `dayKey` falls in. `getUTCDay`
 * returns 0=Sun..6=Sat, so `(day + 6) % 7` is the days-since-Monday offset.
 */
export function weekStartKey(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00.000Z`);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  return toDayKey(new Date(d.getTime() - daysSinceMonday * DAY_MS));
}

/** Month bucket key 'YYYY-MM' for a 'YYYY-MM-DD' dayKey. */
export function monthKey(dayKey: string): string {
  return dayKey.slice(0, 7);
}

/**
 * Deterministic ascending comparator for string keys (dayKeys / week-keys /
 * month-keys sort chronologically because 'YYYY-MM-DD' and 'YYYY-MM' are
 * lexicographically ordered). Kept identical to the two inline copies it replaces.
 */
export function byStringKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
