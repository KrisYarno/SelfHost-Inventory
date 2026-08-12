//
// Phase 0a — calendar bucketing. Mirrors the house convention in
// lib/analytics/date-grain.ts EXACTLY (an ISO week is keyed by its UTC Monday,
// a month by 'YYYY-MM') so a diagnostic figure and a product figure bucket the
// same rows the same way. Duplicated rather than imported because scripts/ is
// plain CommonJS and lib/ is TypeScript compiled by Next.
//

const DAY_MS = 86_400_000;

/** UTC calendar day 'YYYY-MM-DD' for an instant. toISOString() is always UTC. */
function toDayKey(d) {
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * ISO-week bucket key: the Monday (UTC) of the week `dayKey` falls in.
 * getUTCDay returns 0=Sun..6=Sat, so (day + 6) % 7 is days-since-Monday.
 */
function weekStartKey(dayKey) {
  const d = new Date(`${dayKey}T00:00:00.000Z`);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  return toDayKey(new Date(d.getTime() - daysSinceMonday * DAY_MS));
}

/** Month bucket key 'YYYY-MM' for a 'YYYY-MM-DD' dayKey. */
function monthKey(dayKey) {
  return dayKey.slice(0, 7);
}

/** Whole UTC days between two dayKeys (b - a). Both are 'YYYY-MM-DD'. */
function daysBetween(aDayKey, bDayKey) {
  const a = new Date(`${aDayKey}T00:00:00.000Z`).getTime();
  const b = new Date(`${bDayKey}T00:00:00.000Z`).getTime();
  return Math.round((b - a) / DAY_MS);
}

module.exports = { DAY_MS, toDayKey, weekStartKey, monthKey, daysBetween };
