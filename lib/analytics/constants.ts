/**
 * lib/analytics/constants.ts — shared analytics response constants.
 *
 * U9 (Lane 5 polish): the revenue-caveat note was duplicated verbatim in the
 * sales route and the per-product route. A single source of truth keeps the
 * two responses honest and identical (analytics truthful-data principle).
 */

/**
 * The caveat attached to every sales response: units are fully attributed, but
 * revenue is direct (non-bundle) only. Bundle units count; bundle revenue does
 * not — we never present a number we can't stand behind.
 */
export const REVENUE_CAVEAT_NOTE =
  "revenue = direct (non-bundle) sales only; bundle units are included, bundle revenue is not represented";
