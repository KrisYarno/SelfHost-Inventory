// Canonical UTC day-bucketing + query-param date-range parsing for report routes.
//
// House decision (2026-07 platform audit follow-up): all day bucketing is done in
// UTC. The container runs TZ=UTC today, so this is byte-identical to the previous
// date-fns (server-local) behavior — see docs/reviews/2026-07-platform-audit/
// day-bucketing-groundtruth.md. Reports and lib/analytics now agree by contract,
// not by accident of the base image.
//
// DAY_TZ is the single point of future configurability: if the business ever wants
// a real business timezone, this constant is the one seam to change (and would then
// require a TZ-aware date lib + a historical rebuild of any persisted dayKey grain —
// deliberately NOT built now, per owner decision).
export const DAY_TZ = "UTC" as const;

const DAY_MS = 24 * 60 * 60 * 1000;

// A bare calendar day with no time component, e.g. "2026-07-08".
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC calendar day 'YYYY-MM-DD' for an instant. toISOString() is always UTC.
 *  Under TZ=UTC this equals date-fns format(d, "yyyy-MM-dd"). */
export function formatDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Parse a 'YYYY-MM-DD' dayKey to its UTC 00:00:00.000 instant. */
export function parseDayKey(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00.000Z`);
}

/** Start of the UTC day containing `d` (00:00:00.000Z). Equals date-fns startOfDay under UTC. */
export function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

/** End of the UTC day containing `d` (23:59:59.999Z). Equals date-fns endOfDay under UTC. */
export function endOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

/** Add `n` UTC days (may be negative). UTC has no DST, so +/- n*24h is exact. */
export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

/** UTC-midnight Date for every day in [start, end] inclusive of any day whose start <= end.
 *  Byte-identical to date-fns eachDayOfInterval({ start, end }) under TZ=UTC:
 *  begins at startOfDay(start), steps one day, includes each day whose 00:00 <= end. */
export function eachDayUTC(start: Date, end: Date): Date[] {
  const out: Date[] = [];
  const endMs = end.getTime();
  for (let t = startOfDayUTC(start).getTime(); t <= endMs; t += DAY_MS) {
    out.push(new Date(t));
  }
  return out;
}

/** Parse a single date param that may be a bare day ("2026-07-08") or a full ISO
 *  instant. A bare day resolves to that UTC day's 00:00:00.000Z. Under TZ=UTC this
 *  is byte-identical to date-fns parseISO()/`new Date()` for both forms. */
export function parseDayParam(value: string): Date {
  return DATE_ONLY_RE.test(value) ? parseDayKey(value) : new Date(value);
}

// --- Canonical query-param date-range parser -------------------------------
//
// Reads `startDate` / `endDate` off the query string. Inclusivity contract
// (unifies the divergence the audit found across report routes): a bare-day
// `endDate` ("YYYY-MM-DD") is INCLUSIVE of that whole UTC day (-> 23:59:59.999Z),
// matching the admin/logs `setHours(23,59,59,999)` convention rather than the
// exclusive `new Date("YYYY-MM-DD")` = 00:00:00Z the report routes used. A full
// ISO `endDate` is honored EXACTLY as sent (the live UI computes an endOfDay
// instant client-side and serializes it) so production output is unchanged.

export interface ParsedDateRange {
  start?: Date;
  end?: Date;
}
export interface DefaultedDateRange {
  start: Date;
  end: Date;
}

function parseEndInclusive(value: string): Date {
  // Bare day => inclusive end-of-day; full timestamp => the exact instant sent.
  return DATE_ONLY_RE.test(value) ? endOfDayUTC(parseDayKey(value)) : new Date(value);
}

/**
 * Parse `startDate`/`endDate` query params into a { start, end } range.
 *
 * With `defaultLastDays` set, a missing bound defaults to a last-N-days window
 * ending "now" (end = now; start = end - (N-1) days) and both bounds are always
 * defined. Without it, a missing bound is left `undefined` (caller applies
 * gte/lte only when present).
 */
export function parseReportDateRange(
  params: URLSearchParams,
  opts: { defaultLastDays: number; now?: Date }
): DefaultedDateRange;
export function parseReportDateRange(
  params: URLSearchParams,
  opts?: { now?: Date }
): ParsedDateRange;
export function parseReportDateRange(
  params: URLSearchParams,
  opts: { defaultLastDays?: number; now?: Date } = {}
): ParsedDateRange {
  const startRaw = params.get("startDate");
  const endRaw = params.get("endDate");
  const now = opts.now ?? new Date();

  let end: Date | undefined;
  if (endRaw) end = parseEndInclusive(endRaw);
  else if (opts.defaultLastDays != null) end = now;

  let start: Date | undefined;
  if (startRaw) start = parseDayParam(startRaw);
  else if (opts.defaultLastDays != null && end) start = addDays(end, -(opts.defaultLastDays - 1));

  return { start, end };
}
