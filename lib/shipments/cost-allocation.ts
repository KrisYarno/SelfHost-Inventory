import { AppError } from '@/lib/error-handling';

/**
 * Freight/fee allocation across receiving lines (contract pack REV-3 T3, W1-4a).
 *
 * A shipment arrives with one freight bill and many lines. Landed cost means
 * that bill has to end up ON the lines — and the only defensible way to split
 * it is by what each line is WORTH (quantity x base cost), because freight
 * tracks value, not line count.
 *
 * Four rules carry the whole contract:
 *
 *   1. THE INVARIANT: `sum(allocatedCents) === freightTotalCents` on EVERY `ok`
 *      result. Not "close enough" — exact. A cent invented or lost here becomes
 *      a cent of permanently wrong inventory valuation, so the arithmetic runs
 *      in BigInt and the function re-checks itself before returning.
 *   2. LARGEST REMAINDER: proportional shares almost never land on whole cents.
 *      Each line takes its floor, and the leftover cents go one apiece to the
 *      lines with the largest fractional remainders. This is the apportionment
 *      method that keeps every line within one cent of its exact share while
 *      still summing to the total.
 *   3. NEVER DIVIDE BY ZERO: if every line is NULL-costed or worthless the
 *      denominator is 0, and there is no honest split to compute. The
 *      calculator REFUSES with a named reason instead of fabricating one
 *      (truthful-data north star: no number you cannot stand behind).
 *   4. RESIDUAL SHOWN: the leftover cents are not hidden. Every line reports
 *      `roundingDeltaCents` — the residual cent it absorbed, 0 or 1 — so the
 *      UI can explain why two identical lines differ by a penny.
 *
 * ERROR SPLIT, deliberate and load-bearing:
 *   - A BUSINESS outcome (nothing to allocate against) returns `{status:
 *     'refused', reason}`. Callers render it; nothing is thrown.
 *   - A PROGRAMMER error (negative freight, fractional cents, duplicate ids)
 *     THROWS an AppError. These are contract violations by the caller, not
 *     states a user can reach through the UI, and swallowing them would let a
 *     wiring bug quietly produce wrong money.
 *
 * Pure: no Prisma, no Next, no React, no dependencies — W1-4b mounts it.
 */

/** A receiving line as the calculator sees it. `baseCents` NULL = unpriced. */
export type FreightLine = {
  id: string | number;
  qty: number;
  /** Per-unit base cost in cents; NULL when the line has no cost recorded. */
  baseCents: number | null;
};

export type LineAllocation = {
  id: string | number;
  /** This line's share of the freight bill, in whole cents. */
  allocatedCents: number;
  /** Residual cent this line absorbed under largest-remainder: 0 or 1. */
  roundingDeltaCents: number;
};

/** The only refusal T3 names: there was nothing to allocate against. */
export type AllocationRefusalReason = 'zero_value_denominator';

export type AllocationResult =
  | { status: 'ok'; allocations: LineAllocation[]; disclosures: string[] }
  | { status: 'refused'; reason: AllocationRefusalReason; disclosures: string[] };

export type SuggestedUnitCostReason = 'no_base_cost';

export type SuggestedUnitCost = {
  id: string | number;
  /** base + floor(allocated / qty); NULL when the line has no base cost. */
  suggestedUnitCostCents: number | null;
  /** Allocated cents that no uniform per-unit cost can express (shown, not dropped). */
  unitRoundingRemainderCents: number;
  reason: SuggestedUnitCostReason | null;
};

export type EditedAllocation = {
  id: string | number;
  allocatedCents: number;
};

export type EditedAllocationInvalidReason =
  | 'non_integer_allocation'
  | 'negative_allocation'
  | 'duplicate_line_id'
  | 'total_mismatch';

export type EditedAllocationValidation =
  | { status: 'ok'; totalCents: number }
  | {
      status: 'invalid';
      reason: EditedAllocationInvalidReason;
      /** The edited sum, or NULL when a structural fault made it meaningless. */
      totalCents: number | null;
      /** edited sum - freight total; NULL alongside a NULL total. */
      differenceCents: number | null;
    };

const ZERO = BigInt(0);

/** A line carries a base cost (undefined tolerated alongside null, as elsewhere). */
function hasBaseCost(line: FreightLine): line is FreightLine & { baseCents: number } {
  return line.baseCents !== null && line.baseCents !== undefined;
}

/** Cents are whole, non-negative, and inside the exact-integer range. */
function isCents(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertFreightTotal(freightTotalCents: number): void {
  if (!isCents(freightTotalCents)) {
    throw new AppError(
      `Freight total must be a non-negative whole number of cents (received ${String(freightTotalCents)}).`,
      'INVALID_FREIGHT_TOTAL',
      400
    );
  }
}

/**
 * Validate the line set. Duplicate ids are fatal: every downstream join —
 * `suggestedUnitCosts`, the W1-4b edit grid — keys on id, and an ambiguous key
 * would silently allocate freight to the wrong product.
 */
function assertLineInputs(lines: readonly FreightLine[]): void {
  const seen = new Set<string | number>();

  for (const line of lines) {
    if (!isCents(line.qty)) {
      throw new AppError(
        `Line ${String(line.id)}: quantity must be a non-negative whole number (received ${String(line.qty)}).`,
        'INVALID_LINE_QUANTITY',
        400
      );
    }
    if (hasBaseCost(line) && !isCents(line.baseCents)) {
      throw new AppError(
        `Line ${String(line.id)}: base cost must be a non-negative whole number of cents (received ${String(line.baseCents)}).`,
        'INVALID_LINE_BASE_COST',
        400
      );
    }
    if (seen.has(line.id)) {
      throw new AppError(
        `Duplicate line id ${String(line.id)}: freight allocation joins on id and cannot disambiguate it.`,
        'DUPLICATE_LINE_ID',
        400
      );
    }
    seen.add(line.id);
  }
}

function unpricedDisclosure(nullCostCount: number, lineCount: number): string {
  return (
    `${nullCostCount} of ${lineCount} line(s) have no base cost recorded: excluded from the ` +
    `freight denominator and allocated 0 cent(s).`
  );
}

/**
 * Allocate a freight/fee total across lines by line VALUE (qty x base cost).
 *
 * Returns `refused` — never throws — when the value denominator is zero.
 * Throws only on caller contract violations (see the module header).
 */
export function allocateFreight(
  lines: readonly FreightLine[],
  freightTotalCents: number
): AllocationResult {
  assertFreightTotal(freightTotalCents);
  assertLineInputs(lines);

  const nullCostCount = lines.reduce((count, line) => count + (hasBaseCost(line) ? 0 : 1), 0);

  // Zero freight short-circuits BEFORE the denominator test, deliberately. With
  // nothing to allocate there is nothing to divide, so rule 3 has no bite: the
  // honest answer is "every line got 0", not a refusal the user cannot act on.
  // This is why an all-NULL shipment with no freight bill is still `ok`.
  if (freightTotalCents === 0) {
    const disclosures = ['No freight or fees were entered; every line was allocated 0 cent(s).'];
    if (nullCostCount > 0) disclosures.push(unpricedDisclosure(nullCostCount, lines.length));
    return {
      status: 'ok',
      allocations: lines.map((line) => ({
        id: line.id,
        allocatedCents: 0,
        roundingDeltaCents: 0,
      })),
      disclosures,
    };
  }

  // Line value in BigInt: qty x baseCents can reach 1e13 on a real pallet, and
  // `freight * value` then overflows the exact range of a double. BigInt keeps
  // the floor and the remainder EXACT, which is what makes rule 1 provable
  // rather than approximately true.
  const values: (bigint | null)[] = lines.map((line) =>
    hasBaseCost(line) ? BigInt(line.qty) * BigInt(line.baseCents) : null
  );
  const denominator = values.reduce<bigint>((total, value) => total + (value ?? ZERO), ZERO);

  if (denominator === ZERO) {
    const disclosures = [
      lines.length === 0
        ? 'No lines were supplied, so there is no value to allocate freight against.'
        : `All ${lines.length} line(s) have zero value (no base cost, or a quantity or base ` +
          `cost of 0), so freight cannot be allocated by value.`,
    ];
    if (nullCostCount > 0 && lines.length > 0) {
      disclosures.push(unpricedDisclosure(nullCostCount, lines.length));
    }
    return { status: 'refused', reason: 'zero_value_denominator', disclosures };
  }

  const freight = BigInt(freightTotalCents);
  const floors: bigint[] = [];
  const remainders: bigint[] = [];

  for (const value of values) {
    if (value === null) {
      floors.push(ZERO);
      remainders.push(ZERO);
      continue;
    }
    const scaled = freight * value;
    floors.push(scaled / denominator);
    remainders.push(scaled % denominator);
  }

  const distributedFloor = floors.reduce<bigint>((total, floor) => total + floor, ZERO);
  const residual = Number(freight - distributedFloor);

  // Largest remainder, with a fully deterministic tie-break: remainder desc,
  // then line value desc, then original index asc. Determinism matters — two
  // identical lines must not swap their penny between renders.
  //
  // Only lines with a POSITIVE remainder are candidates, which is also what
  // keeps NULL-cost and zero-value lines at exactly 0: their remainder is 0, so
  // they can never absorb a residual cent. (The residual is always strictly
  // less than the candidate count, so the cents always find a home.)
  const candidates = values
    .map((_value, index) => index)
    .filter((index) => values[index] !== null && remainders[index] > ZERO)
    .sort((a, b) => {
      if (remainders[a] !== remainders[b]) return remainders[a] > remainders[b] ? -1 : 1;
      const valueA = values[a] as bigint;
      const valueB = values[b] as bigint;
      if (valueA !== valueB) return valueA > valueB ? -1 : 1;
      return a - b;
    });

  const absorbers = new Set<number>(candidates.slice(0, Math.max(residual, 0)));

  const allocations: LineAllocation[] = lines.map((line, index) => {
    const roundingDeltaCents = absorbers.has(index) ? 1 : 0;
    return {
      id: line.id,
      allocatedCents: Number(floors[index]) + roundingDeltaCents,
      roundingDeltaCents,
    };
  });

  // Rule 1, re-checked. If this ever fires the arithmetic above is wrong, and
  // failing loudly is strictly better than returning a wrong money split.
  const allocatedTotal = allocations.reduce((total, line) => total + line.allocatedCents, 0);
  if (allocatedTotal !== freightTotalCents) {
    throw new AppError(
      `Freight allocation invariant violated: allocated ${allocatedTotal} of ${freightTotalCents} cent(s).`,
      'ALLOCATION_INVARIANT_VIOLATED',
      500
    );
  }

  const disclosures = [
    `Freight of ${freightTotalCents} cent(s) was allocated across ${lines.length} line(s) by ` +
      `line value (quantity x base cost).`,
  ];
  if (nullCostCount > 0) disclosures.push(unpricedDisclosure(nullCostCount, lines.length));

  const zeroValueCount = values.reduce<number>(
    (count, value) => count + (value !== null && value === ZERO ? 1 : 0),
    0
  );
  if (zeroValueCount > 0) {
    disclosures.push(
      `${zeroValueCount} line(s) have zero value (a quantity or base cost of 0) and were ` +
        `allocated 0 cent(s).`
    );
  }
  if (residual > 0) {
    disclosures.push(
      `${residual} cent(s) of rounding residual could not divide evenly and were distributed ` +
        `one apiece to the ${residual} largest-remainder line(s); see roundingDeltaCents per line.`
    );
  }

  return { status: 'ok', allocations, disclosures };
}

/**
 * Turn an allocation into the per-unit cost each line would be stamped with:
 * `base + allocated/qty`, floored to whole cents.
 *
 * Largest remainder applies WITHIN the line too — `allocated` rarely divides
 * evenly across `qty` units — but a single suggested unit cost cannot express a
 * split where some units carry one more cent than others. So the unexpressible
 * remainder is REPORTED (`unitRoundingRemainderCents`) rather than rounded away:
 * the line's true landed total is always
 * `qty * suggestedUnitCostCents + unitRoundingRemainderCents`.
 *
 * A NULL-cost line suggests NULL with a named reason — never 0, which would
 * read as "this product is free".
 */
export function suggestedUnitCosts(
  lines: readonly FreightLine[],
  allocations: readonly LineAllocation[]
): SuggestedUnitCost[] {
  assertLineInputs(lines);

  const byId = new Map<string | number, LineAllocation>();
  for (const allocation of allocations) {
    if (!isCents(allocation.allocatedCents)) {
      throw new AppError(
        `Line ${String(allocation.id)}: allocated cents must be a non-negative whole number ` +
          `(received ${String(allocation.allocatedCents)}).`,
        'INVALID_ALLOCATION_CENTS',
        400
      );
    }
    byId.set(allocation.id, allocation);
  }

  return lines.map((line) => {
    const allocation = byId.get(line.id);
    if (!allocation) {
      throw new AppError(
        `Line ${String(line.id)} has no matching allocation: the line set and the allocation ` +
          `set disagree.`,
        'ALLOCATION_LINE_MISMATCH',
        400
      );
    }

    const allocated = allocation.allocatedCents;

    if (!hasBaseCost(line)) {
      // No base to build on, so none of the allocation is expressible.
      return {
        id: line.id,
        suggestedUnitCostCents: null,
        unitRoundingRemainderCents: allocated,
        reason: 'no_base_cost',
      };
    }

    // qty 0 cannot carry a per-unit share; the whole allocation stays visible
    // as remainder instead of dividing by zero.
    const perUnit = line.qty > 0 ? Math.floor(allocated / line.qty) : 0;
    return {
      id: line.id,
      suggestedUnitCostCents: line.baseCents + perUnit,
      unitRoundingRemainderCents: allocated - perUnit * line.qty,
      reason: null,
    };
  });
}

/**
 * Re-validate a hand-edited allocation against the freight total (T3: "edited
 * outputs re-validated").
 *
 * The whole point is that a user can drag cents between lines in W1-4b, and the
 * invariant must survive their edits. Everything about `edited` is USER DATA and
 * comes back as `{status:'invalid', reason}` — this function never throws over
 * it. `freightTotalCents` is the CALLER's own parameter, so a malformed total is
 * still a contract violation and still throws.
 */
export function validateEditedAllocations(
  edited: readonly EditedAllocation[],
  freightTotalCents: number
): EditedAllocationValidation {
  assertFreightTotal(freightTotalCents);

  const structural = (reason: EditedAllocationInvalidReason): EditedAllocationValidation => ({
    status: 'invalid',
    reason,
    totalCents: null,
    differenceCents: null,
  });

  const seen = new Set<string | number>();
  let totalCents = 0;

  for (const entry of edited) {
    if (!Number.isSafeInteger(entry.allocatedCents)) {
      return structural('non_integer_allocation');
    }
    if (entry.allocatedCents < 0) {
      return structural('negative_allocation');
    }
    if (seen.has(entry.id)) {
      return structural('duplicate_line_id');
    }
    seen.add(entry.id);
    totalCents += entry.allocatedCents;
  }

  if (totalCents !== freightTotalCents) {
    return {
      status: 'invalid',
      reason: 'total_mismatch',
      totalCents,
      differenceCents: totalCents - freightTotalCents,
    };
  }

  return { status: 'ok', totalCents };
}
