/**
 * THE MATCH VOCABULARY (reconciliation lane Part 2, spec REV-8 §2.3/§2.4a;
 * pack CA1.1) — its OWN module with NO imports at all, the `class-keys.ts`
 * idiom: the admin chips and (from P2-C) the assistant tool value-import these
 * keys, and a vocabulary module that reached for `lib/prisma` — even
 * transitively, even for a string helper — would put the Prisma singleton back
 * in the /admin/reconciliation client chunk.
 *
 * Everything here is a DEFINITION, not a setting. A class the UI cannot name is
 * a class nobody can act on, so the words the surface prints live here too
 * (seam S-A11) rather than being re-spelled in a component.
 *
 * Next-free, Prisma-free and textually write-free (pack cross-wave rule 2):
 * this module is on the assistant's read path.
 */

/** The CLOSED class vocabulary — one order gets exactly one of these, or null. */
export const MATCH_CLASS_KEYS = [
  'exact', 'substitution-equivalent', 'substitution-declared',
  'missing-product', 'short', 'over', 'extra-product', 'substitution',
  'correction-overrun', 'mixed',
] as const;
export type MatchClassKey = (typeof MATCH_CLASS_KEYS)[number];

/** The classes an admin should look at. `exact` and the two tolerated substitutions are not flagged. */
export const FLAGGED_MATCH_CLASSES: ReadonlySet<MatchClassKey> = new Set<MatchClassKey>([
  'substitution', 'missing-product', 'short', 'over', 'extra-product', 'mixed', 'correction-overrun',
]);

/** The per-product differences a class is derived from (spec §2.3(2)). */
export const MATCH_KINDS = ['missing', 'short', 'over', 'extra', 'overrun'] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

/**
 * Why a ROW has no match at all (the producer's reasons — never the matcher's).
 *
 * `match-error` is the fifth and the only one that is not about the ORDER: the
 * matcher refused this order's line data, and the row says so instead of the
 * whole page failing for one bad row (pack REV-7).
 */
export const MATCH_UNAVAILABLE_REASONS = [
  'unstamped', 'mixed-stamps', 'order-missing', 'order-redacted', 'match-error',
] as const;
export type MatchUnavailableReason = (typeof MATCH_UNAVAILABLE_REASONS)[number];

/** The ONLY reason the matcher itself returns `class: null` (spec §2.3 rule 1). */
export const UNMATCHABLE = 'unmatchable' as const;

/**
 * Raw-string unit admission (spec §2.4a): exactly these, after trim + lower +
 * whitespace fold. NO alias table — `canonicalUnit` folds `pack` into `ct` and
 * `normalizeText` strips the micro sign, and either fold would balance two
 * masses that are not equal.
 */
export const MATCHER_UNITS = ['mg', 'mcg', 'ml', 'iu', 'g'] as const;
export type MatcherUnit = (typeof MATCHER_UNITS)[number];

const ADMITTED_UNITS: ReadonlySet<string> = new Set(MATCHER_UNITS);

/** The admitted unit, or null — a product whose unit is refused never enters a mass group. */
export function matcherUnit(raw: string | null | undefined): MatcherUnit | null {
  if (typeof raw !== 'string') return null;
  const folded = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  return ADMITTED_UNITS.has(folded) ? (folded as MatcherUnit) : null;
}

/**
 * The family key. A VERBATIM inline of `lib/matching/normalize.ts`
 * `normalizeText` (lower -> `[^a-z0-9\s]+` -> ' ' -> whitespace fold -> trim)
 * so this module stays import-free and the read-path lists do not widen for a
 * string helper. A unit PARITY pin runs both over a fixture set (the
 * `classifyMassUpdateBatch` port idiom): an inlined copy that drifts is caught
 * there, not in production.
 *
 * A whitespace-only baseName yields `''`, which the matcher treats as
 * undecomposable.
 */
export function familyKey(baseName: string): string {
  return baseName
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The sentence that rides with every class and every reason (truthful-data
 * north star: a class without its definition is a rumour). `grain` and
 * `tolerance` state the two rules a reader needs to interpret any of them.
 */
export const MATCH_DEFINITIONS: Readonly<
  Record<MatchClassKey | MatchUnavailableReason | typeof UNMATCHABLE | 'grain' | 'tolerance', string>
> = Object.freeze({
  exact:
    'every product the order asked for left stock against this order in the quantity it asked for',
  'substitution-equivalent':
    'the shortfall and the surplus balanced to the same mass within one product family and unit, so the swap is treated as filled',
  'substitution-declared':
    'the operator declared the swap at deduction time and the declared amounts cover the difference',
  'missing-product':
    'a product the order asked for has no stock movement against this order at all',
  short: 'less left stock against this order than it asked for, on at least one product',
  over: 'more left stock against this order than it asked for, on at least one product',
  'extra-product': 'a product the order never asked for left stock against it',
  substitution:
    'one product is missing and another was taken in its place, and the two did not balance by mass',
  'correction-overrun':
    'corrections against this order give back more than ever left stock for at least one product',
  mixed: 'more than one kind of difference is present on this order',
  unstamped: 'the ledger rows carry no order stamp, so there is no order to compare against',
  'mixed-stamps': 'the rows name more than one order, so no single order can be compared',
  'order-missing': 'the stamp names an order this database no longer holds',
  'order-redacted': "the order belongs to another company, so its lines are not readable here",
  'match-error':
    "the matcher refused this order's line data (a non-integer or negative quantity) — the order is listed without a match; see the server log",
  [UNMATCHABLE]:
    'the order has no mapped line and no resolvable bundle line, so there is nothing to compare the movement against',
  grain:
    'attribution is batch grain and matching is ORDER grain: a batch row carries the match of the order its rows name',
  tolerance:
    'mg-equivalent swaps balance in integer hundredths within one (product family, unit) group; a partial balance changes nothing',
});

/**
 * The ONE home for the words the UI and the tool print (seam S-A11) — never
 * re-spelled in a component.
 */
export const MATCH_CLASS_LABELS: Readonly<Record<MatchClassKey, string>> = Object.freeze({
  exact: 'Exact',
  'substitution-equivalent': 'Swap — mg-equivalent',
  'substitution-declared': 'Swap — declared',
  'missing-product': 'Missing product',
  short: 'Short',
  over: 'Over',
  'extra-product': 'Extra product',
  substitution: 'Substitution',
  'correction-overrun': 'Correction overrun',
  mixed: 'Mixed',
});

/** The same, for the rows that carry no match at all. */
export const MATCH_UNAVAILABLE_COPY: Readonly<Record<MatchUnavailableReason, string>> = Object.freeze({
  unstamped: 'no order to compare',
  'mixed-stamps': 'mixed stamps',
  'order-missing': 'order missing',
  'order-redacted': "another company's order",
  'match-error': 'could not be matched (bad line data)',
});
