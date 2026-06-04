const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC calendar day 'YYYY-MM-DD' for an instant. toISOString() is always UTC. */
export function toDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Inclusive lower bound: 00:00:00.000Z of the given UTC day. */
export function dayKeyStart(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00.000Z`);
}

/** Exclusive upper bound: 00:00:00.000Z of the NEXT UTC day (UTC has no DST, so +24h is exact). */
export function nextDayStart(dayKey: string): Date {
  return new Date(dayKeyStart(dayKey).getTime() + DAY_MS);
}

/** Inclusive list of UTC dayKeys from `from` to `to`. */
export function dayKeyRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = dayKeyStart(from).getTime(), end = dayKeyStart(to).getTime(); t <= end; t += DAY_MS) {
    out.push(toDayKey(new Date(t)));
  }
  return out;
}

/** Sale-date dayKey for an order: externalCreatedAt is nullable, so fall back to createdAt. */
export function saleDayKey(o: { externalCreatedAt: Date | null; createdAt: Date }): string {
  return toDayKey(o.externalCreatedAt ?? o.createdAt);
}

/** The last COMPLETED UTC day (yesterday) relative to `now` (defaults to current time). Snapshots only
 *  cover completed days; today's live level comes from product_locations, not a snapshot. */
export function lastCompletedDayKey(now: Date = new Date()): string {
  return toDayKey(new Date(now.getTime() - DAY_MS));
}
