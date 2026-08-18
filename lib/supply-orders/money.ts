import { AppError } from '@/lib/error-handling';

/**
 * ALL the money on a supply-order line (spec D4 / §5.3; contract pack C2a.1).
 *
 * ONE function owns it, deliberately. Verify computes a shortage, stock-in
 * stamps a batch's dollars, analytics sums a loss — three surfaces that must
 * never disagree about the same line, so all three call in here and none of
 * them does arithmetic of its own.
 *
 * Four rules carry the whole contract:
 *
 *   1. ONE UNIT COST PER LINE. `unitCostCents = round-half-even(total / basis)`,
 *      where `basis = orderedQuantity ?? verifiedQuantity`. It is a property of
 *      the LINE, not of a batch: a second batch never re-prices the first, so
 *      the product-cost series stays clean and the D-COST prompt fires once.
 *   2. BATCH DOLLARS ARE EXACT, never a per-unit figure multiplied out.
 *      `cumulative(k) = floor(total * k / basis)` in BigInt, and a batch's share
 *      is `cumulative(after) - cumulative(before)`. The shares of a fully
 *      stocked line therefore sum to `cumulative(verified)` to the cent — the
 *      same exactness discipline the retired freight calculator carried.
 *   3. 0 IS NOT NULL (truthful-data north star). A `lineTotalCents` of 0 means
 *      "free", which no unit cost can express, so `unitCostCents` is NULL — a
 *      $0.00 valuation would be a number nobody can stand behind. An unknown
 *      total and an absent basis are NULL for the same reason. `lossCents` /
 *      `surplusValueCents`, by contrast, are always REAL numbers (never NULL):
 *      "we cannot price this line" is honestly 0 money lost, not unknown money.
 *   4. LOSS AND SURPLUS ARE MUTUALLY EXCLUSIVE AND NEVER NEGATIVE. Short:
 *      `loss = total - cumulative(verified)` (so `loss + cumulative(verified)
 *      == total`). Over: `surplus = cumulative(verified) - total`. Equal, or
 *      unordered, or unpriced: 0 and 0.
 *
 * ERROR SPLIT, the cost-allocation precedent: `cumulative` is the low-level
 * primitive and THROWS on a caller contract violation (a basis of 0, a negative
 * k, a non-integer or unsafe number) because those are wiring bugs, not states a
 * user can reach. `lineMoney` and `batchShareCents` take real column values —
 * including NULLs — and answer with NULL rather than throwing.
 *
 * Pure: no Prisma, no Next, no React. Only `AppError` (itself dependency-free).
 */

/** The three line columns every money answer is derived from. */
export type LineMoneyInput = {
  lineTotalCents: number | null;
  orderedQuantity: number | null;
  verifiedQuantity: number | null;
};

export type LineMoney = {
  /** `orderedQuantity ?? verifiedQuantity` — what the total is divided by. */
  basisQuantity: number | null;
  /** Round-half-even cents per unit; NULL when it cannot be expressed. */
  unitCostCents: number | null;
  /** Money the supplier owes back (short delivery). Never negative. */
  lossCents: number;
  /** Money that arrived unbilled (over delivery). Never negative. */
  surplusValueCents: number;
  /** "$1,250.00 / 100 ordered = $12.50/unit"; NULL alongside a NULL unit cost. */
  derivation: string | null;
};

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);

/** Cents and unit counts are whole numbers inside the exact-integer range. */
function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new AppError(
      `${name} must be a whole number inside the safe-integer range (received ${String(value)}).`,
      'INVALID_LINE_MONEY_INPUT',
      400
    );
  }
}

/**
 * `floor(lineTotalCents * k / basisQuantity)` in BigInt.
 *
 * The product reaches 1e14 at the D4 bound (1e8 cents x 1e6 units) and past 2^53
 * on a wide line, where a double silently rounds the PRODUCT before the division
 * ever runs. BigInt is what makes rule 2 provable rather than approximately true.
 *
 * Floors rather than truncates: BigInt division rounds toward zero, which
 * differs from floor on negative numerators. Real columns are non-negative, but
 * a floor that is only accidentally correct is not a floor.
 */
export function cumulative(lineTotalCents: number, basisQuantity: number, k: number): number {
  assertSafeInteger(lineTotalCents, 'lineTotalCents');
  assertSafeInteger(basisQuantity, 'basisQuantity');
  assertSafeInteger(k, 'k');

  if (basisQuantity <= 0) {
    throw new AppError(
      `Cumulative cost needs a positive basis quantity to divide by (received ${basisQuantity}).`,
      'INVALID_BASIS_QUANTITY',
      400
    );
  }
  if (k < 0) {
    throw new AppError(
      `Cumulative cost needs a non-negative unit count (received ${k}).`,
      'INVALID_UNIT_COUNT',
      400
    );
  }

  const numerator = BigInt(lineTotalCents) * BigInt(k);
  const basis = BigInt(basisQuantity);
  const quotient = numerator / basis;
  // Toward-zero -> floor for a negative numerator that did not divide evenly.
  const floored = numerator < ZERO && quotient * basis !== numerator ? quotient - ONE : quotient;
  return Number(floored);
}

/**
 * Round-half-even (banker's rounding) of `total / basis`, in BigInt.
 *
 * Half-even and not half-up because the unit cost is the number that feeds the
 * product's standing cost: a systematic upward bias on every tie would drift the
 * whole cost series in one direction. Ties are exact ties only — 1/2 -> 0,
 * 3/2 -> 2.
 */
function roundHalfEven(total: bigint, basis: bigint): bigint {
  const quotient = total / basis;
  const remainder = total % basis;
  const twiceRemainder = remainder * TWO;

  if (twiceRemainder > basis) return quotient + ONE;
  if (twiceRemainder < basis) return quotient;
  return quotient % TWO === ZERO ? quotient : quotient + ONE;
}

/** "$1,250.00" — grouped by hand so the string is identical in every runtime. */
function formatCents(cents: number): string {
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${grouped}.${String(remainder).padStart(2, '0')}`;
}

/**
 * A batch's EXACT share of the line total: `cumulative(stockedBefore +
 * batchQuantity) - cumulative(stockedBefore)`. This is what
 * `inventory_logs.receiptCostCents` is stamped with.
 *
 * NULL when the line has no total or no basis to divide by — the batch really
 * did cost an unknown amount, and a 0 there would read as "this batch was free".
 * A total of 0 with a positive basis is a KNOWN zero and returns 0.
 */
export function batchShareCents(
  lineTotalCents: number | null,
  basisQuantity: number | null,
  stockedBefore: number,
  batchQuantity: number
): number | null {
  if (lineTotalCents === null || basisQuantity === null || basisQuantity <= 0) return null;
  return (
    cumulative(lineTotalCents, basisQuantity, stockedBefore + batchQuantity) -
    cumulative(lineTotalCents, basisQuantity, stockedBefore)
  );
}

/**
 * Every money figure a supply-order line has.
 *
 * `basisQuantity = orderedQuantity ?? verifiedQuantity` (D4/PK-5): an UNORDERED
 * arrival is priced by what actually turned up, and the booking never writes
 * `orderedQuantity` — the line stays unordered for every later query, and verify
 * is prohibited from moving the count once anything is stocked, so this basis is
 * frozen the moment the first batch books.
 *
 * Loss and surplus are only meaningful once something has been counted AND the
 * line carries a total: before a verify (`verifiedQuantity === null`) nothing is
 * owed in either direction, and an unordered line cannot be short or over by
 * construction (its basis IS what arrived).
 */
export function lineMoney(input: LineMoneyInput): LineMoney {
  const { lineTotalCents, orderedQuantity, verifiedQuantity } = input;
  const basisQuantity = orderedQuantity ?? verifiedQuantity;

  const priced =
    lineTotalCents !== null &&
    lineTotalCents !== 0 &&
    basisQuantity !== null &&
    basisQuantity > 0;

  if (!priced) {
    return {
      basisQuantity,
      unitCostCents: null,
      lossCents: 0,
      surplusValueCents: 0,
      derivation: null,
    };
  }

  // `priced` narrowed both, but TS cannot carry that through the boolean.
  const total = lineTotalCents as number;
  const basis = basisQuantity as number;

  assertSafeInteger(total, 'lineTotalCents');
  assertSafeInteger(basis, 'basisQuantity');

  const unitCostCents = Number(roundHalfEven(BigInt(total), BigInt(basis)));

  let lossCents = 0;
  let surplusValueCents = 0;

  // Only an ORDERED line can be short or over: the comparison is verified
  // against ordered, and an unordered arrival has nothing to compare against.
  if (orderedQuantity !== null && orderedQuantity > 0 && verifiedQuantity !== null) {
    if (verifiedQuantity < orderedQuantity) {
      lossCents = total - cumulative(total, orderedQuantity, verifiedQuantity);
    } else if (verifiedQuantity > orderedQuantity) {
      surplusValueCents = cumulative(total, orderedQuantity, verifiedQuantity) - total;
    }
  }

  const basisLabel = orderedQuantity !== null ? 'ordered' : 'verified';
  const derivation =
    `${formatCents(total)} / ${basis} ${basisLabel} = ${formatCents(unitCostCents)}/unit`;

  return { basisQuantity, unitCostCents, lossCents, surplusValueCents, derivation };
}
