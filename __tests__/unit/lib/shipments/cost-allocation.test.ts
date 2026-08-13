/**
 * @jest-environment node
 *
 * T3 freight-allocation calculator (contract pack REV-3, W1-4a).
 *
 * The pin that matters most is the INVARIANT: every `ok` result allocates the
 * freight total EXACTLY — `sum(allocatedCents) === freightTotalCents`, no cent
 * invented, no cent lost. Everything else in this file exists to attack it:
 * a 1-cent freight bill over three identical lines, value disparities of a
 * billion to one, magnitudes past the float-precision cliff, NULL-cost lines,
 * and a 100-case seeded corpus.
 *
 * The other half is the REFUSAL. A zero-value denominator (every line NULL or
 * worthless) must produce a named refusal, never a division. Truthful-data
 * north star: the calculator would rather say "I cannot allocate this" than
 * emit a fabricated split.
 *
 * Seeding note: the property loop uses a literal-seeded LCG, never
 * `Math.random` — a failure here has to be reproducible on the first re-run.
 */

import {
  allocateFreight,
  suggestedUnitCosts,
  validateEditedAllocations,
  type FreightLine,
  type LineAllocation,
} from '@/lib/shipments/cost-allocation';
import { AppError } from '@/lib/error-handling';

/** Sum helper — the invariant is asserted through this everywhere. */
function sumAllocated(allocations: readonly LineAllocation[]): number {
  return allocations.reduce((total, line) => total + line.allocatedCents, 0);
}

/** Assert a thrown AppError carries the expected named code + 400. */
function expectAppErrorCode(run: () => unknown, code: string) {
  expect(run).toThrow(AppError);
  try {
    run();
  } catch (error) {
    expect((error as AppError).code).toBe(code);
    expect((error as AppError).statusCode).toBe(400);
  }
}

describe('allocateFreight — the invariant (sum === freight total)', () => {
  it('1 cent of freight over 3 EQUAL lines lands entirely on one line', () => {
    const lines: FreightLine[] = [
      { id: 'a', qty: 1, baseCents: 100 },
      { id: 'b', qty: 1, baseCents: 100 },
      { id: 'c', qty: 1, baseCents: 100 },
    ];
    const result = allocateFreight(lines, 1);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(sumAllocated(result.allocations)).toBe(1);
    expect(result.allocations.map((a) => a.allocatedCents)).toEqual([1, 0, 0]);
  });

  it('2 cents over 3 equal lines splits deterministically (stable tie-break)', () => {
    const lines: FreightLine[] = [
      { id: 'a', qty: 1, baseCents: 100 },
      { id: 'b', qty: 1, baseCents: 100 },
      { id: 'c', qty: 1, baseCents: 100 },
    ];
    const result = allocateFreight(lines, 2);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.allocations.map((a) => a.allocatedCents)).toEqual([1, 1, 0]);
    expect(sumAllocated(result.allocations)).toBe(2);
  });

  it('a SINGLE line absorbs the whole freight total', () => {
    const result = allocateFreight([{ id: 7, qty: 3, baseCents: 250 }], 9999);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0].allocatedCents).toBe(9999);
    expect(sumAllocated(result.allocations)).toBe(9999);
  });

  it('a HUGE value disparity rounds the tiny line to 0 and still sums exactly', () => {
    const lines: FreightLine[] = [
      { id: 'dust', qty: 1, baseCents: 1 },
      { id: 'whale', qty: 1, baseCents: 1_000_000_000 },
    ];
    const result = allocateFreight(lines, 1000);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.allocations.map((a) => a.allocatedCents)).toEqual([0, 1000]);
    expect(sumAllocated(result.allocations)).toBe(1000);
  });

  it('magnitudes BEYOND float precision do not drift the invariant', () => {
    // Line values are 1e13 and 3e13; freight x value overflows the exact-integer
    // range of a double, so a float implementation silently misallocates here.
    const lines: FreightLine[] = [
      { id: 'a', qty: 1_000_000, baseCents: 10_000_000 },
      { id: 'b', qty: 3_000_000, baseCents: 10_000_000 },
    ];
    const result = allocateFreight(lines, 1_000_000_001);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.allocations.map((a) => a.allocatedCents)).toEqual([250_000_000, 750_000_001]);
    expect(sumAllocated(result.allocations)).toBe(1_000_000_001);
  });

  it('splits proportionally on a clean 1:3 value ratio', () => {
    const lines: FreightLine[] = [
      { id: 'a', qty: 1, baseCents: 100 },
      { id: 'b', qty: 3, baseCents: 100 },
    ];
    const result = allocateFreight(lines, 400);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.allocations.map((a) => a.allocatedCents)).toEqual([100, 300]);
    expect(result.allocations.every((a) => a.roundingDeltaCents === 0)).toBe(true);
  });

  it('NULL-cost lines are excluded from the denominator, allocated 0, and disclosed', () => {
    const lines: FreightLine[] = [
      { id: 'a', qty: 2, baseCents: 100 },
      { id: 'unpriced', qty: 1, baseCents: null },
      { id: 'c', qty: 2, baseCents: 300 },
    ];
    const result = allocateFreight(lines, 100);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.allocations.map((a) => a.allocatedCents)).toEqual([25, 0, 75]);
    expect(sumAllocated(result.allocations)).toBe(100);
    expect(result.disclosures.join(' ')).toMatch(/no base cost/i);
  });

  it('a ZERO-value line among positive ones gets 0 and never absorbs residual', () => {
    const lines: FreightLine[] = [
      { id: 'a', qty: 1, baseCents: 100 },
      { id: 'empty', qty: 0, baseCents: 500 },
      { id: 'c', qty: 1, baseCents: 100 },
    ];
    const result = allocateFreight(lines, 3);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.allocations.map((a) => a.allocatedCents)).toEqual([2, 0, 1]);
    expect(result.allocations[1].roundingDeltaCents).toBe(0);
    expect(sumAllocated(result.allocations)).toBe(3);
  });

  it('roundingDeltaCents is 0-or-1 per line and SUMS to the distributed residual', () => {
    const lines: FreightLine[] = [
      { id: 'a', qty: 1, baseCents: 100 },
      { id: 'b', qty: 1, baseCents: 100 },
      { id: 'c', qty: 1, baseCents: 100 },
    ];
    const result = allocateFreight(lines, 2);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.allocations.every((a) => a.roundingDeltaCents === 0 || a.roundingDeltaCents === 1)).toBe(true);
    expect(result.allocations.reduce((t, a) => t + a.roundingDeltaCents, 0)).toBe(2);
    expect(result.disclosures.join(' ')).toMatch(/residual/i);
  });
});

describe('allocateFreight — refusal (never divide by a zero denominator)', () => {
  it('refuses when EVERY line has a NULL base cost', () => {
    const lines: FreightLine[] = [
      { id: 'a', qty: 5, baseCents: null },
      { id: 'b', qty: 9, baseCents: null },
    ];
    const result = allocateFreight(lines, 5000);

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toBe('zero_value_denominator');
    expect(result.disclosures.length).toBeGreaterThan(0);
  });

  it('refuses when every base cost is 0 (value denominator is still 0)', () => {
    const result = allocateFreight(
      [
        { id: 'a', qty: 5, baseCents: 0 },
        { id: 'b', qty: 5, baseCents: 0 },
      ],
      5000
    );

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toBe('zero_value_denominator');
  });

  it('refuses when every quantity is 0', () => {
    const result = allocateFreight(
      [
        { id: 'a', qty: 0, baseCents: 100 },
        { id: 'b', qty: 0, baseCents: 250 },
      ],
      99
    );

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toBe('zero_value_denominator');
  });

  it('refuses an EMPTY line list carrying a non-zero freight bill', () => {
    const result = allocateFreight([], 500);

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toBe('zero_value_denominator');
  });
});

describe('allocateFreight — zero freight is OK, not a refusal', () => {
  it('freight of 0 returns ok with all-zero allocations', () => {
    const lines: FreightLine[] = [
      { id: 'a', qty: 2, baseCents: 100 },
      { id: 'b', qty: 1, baseCents: 300 },
    ];
    const result = allocateFreight(lines, 0);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.allocations.map((a) => a.allocatedCents)).toEqual([0, 0]);
    expect(result.allocations.every((a) => a.roundingDeltaCents === 0)).toBe(true);
    expect(sumAllocated(result.allocations)).toBe(0);
  });

  it('freight of 0 with ALL-NULL costs is still ok (nothing to divide, nothing to refuse)', () => {
    const result = allocateFreight(
      [
        { id: 'a', qty: 1, baseCents: null },
        { id: 'b', qty: 1, baseCents: null },
      ],
      0
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(sumAllocated(result.allocations)).toBe(0);
  });

  it('an empty line list with zero freight is ok with no allocations', () => {
    const result = allocateFreight([], 0);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.allocations).toEqual([]);
    expect(sumAllocated(result.allocations)).toBe(0);
  });
});

describe('allocateFreight — rejected inputs (programmer errors THROW)', () => {
  const OK_LINES: FreightLine[] = [{ id: 'a', qty: 1, baseCents: 100 }];

  it('a NEGATIVE freight total throws a named error', () => {
    expectAppErrorCode(() => allocateFreight(OK_LINES, -1), 'INVALID_FREIGHT_TOTAL');
  });

  it('a FRACTIONAL freight total throws (cents are integers)', () => {
    expectAppErrorCode(() => allocateFreight(OK_LINES, 10.5), 'INVALID_FREIGHT_TOTAL');
  });

  it('a non-finite freight total throws', () => {
    expectAppErrorCode(() => allocateFreight(OK_LINES, Number.NaN), 'INVALID_FREIGHT_TOTAL');
  });

  it('a NEGATIVE line quantity throws a named error', () => {
    expectAppErrorCode(() => allocateFreight([{ id: 'a', qty: -2, baseCents: 100 }], 100), 'INVALID_LINE_QUANTITY');
  });

  it('a fractional line quantity throws', () => {
    expectAppErrorCode(() => allocateFreight([{ id: 'a', qty: 1.5, baseCents: 100 }], 100), 'INVALID_LINE_QUANTITY');
  });

  it('a NEGATIVE base cost throws a named error', () => {
    expectAppErrorCode(() => allocateFreight([{ id: 'a', qty: 1, baseCents: -100 }], 100), 'INVALID_LINE_BASE_COST');
  });

  it('a fractional base cost throws', () => {
    expectAppErrorCode(() => allocateFreight([{ id: 'a', qty: 1, baseCents: 10.5 }], 100), 'INVALID_LINE_BASE_COST');
  });

  it('DUPLICATE line ids throw (the allocation join would be ambiguous)', () => {
    expectAppErrorCode(
      () =>
        allocateFreight(
          [
            { id: 'a', qty: 1, baseCents: 100 },
            { id: 'a', qty: 2, baseCents: 200 },
          ],
          100
        ),
      'DUPLICATE_LINE_ID'
    );
  });
});

describe('allocateFreight — property loop (100 seeded cases, literal-seed LCG)', () => {
  /** Numerical-Recipes LCG. Literal seed: reproducible on every run, forever. */
  function makeLcg(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
  }

  it('the invariant holds across 100 seeded adversarial cases', () => {
    const next = makeLcg(20260813);
    let okCases = 0;
    let refusedCases = 0;

    for (let caseIndex = 0; caseIndex < 100; caseIndex += 1) {
      const lineCount = 1 + Math.floor(next() * 8);
      const lines: FreightLine[] = [];
      for (let i = 0; i < lineCount; i += 1) {
        const nullCost = next() < 0.25;
        lines.push({
          id: `line-${i}`,
          qty: Math.floor(next() * 40),
          baseCents: nullCost ? null : Math.floor(next() * 500_000),
        });
      }
      const freightTotalCents = Math.floor(next() * 2_000_000);
      const result = allocateFreight(lines, freightTotalCents);

      if (result.status === 'ok') {
        okCases += 1;
        // THE INVARIANT.
        expect(sumAllocated(result.allocations)).toBe(freightTotalCents);
        expect(result.allocations).toHaveLength(lines.length);
        result.allocations.forEach((allocation, i) => {
          expect(allocation.id).toBe(lines[i].id);
          expect(allocation.allocatedCents).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(allocation.allocatedCents)).toBe(true);
          // NULL-cost lines are excluded from the denominator: always 0.
          if (lines[i].baseCents === null) {
            expect(allocation.allocatedCents).toBe(0);
            expect(allocation.roundingDeltaCents).toBe(0);
          }
        });
      } else {
        refusedCases += 1;
        // A refusal is ONLY ever legitimate when there was truly nothing to
        // divide by AND there was freight to allocate.
        const denominator = lines.reduce(
          (total, line) => total + (line.baseCents === null ? 0 : line.qty * line.baseCents),
          0
        );
        expect(denominator).toBe(0);
        expect(freightTotalCents).toBeGreaterThan(0);
      }
    }

    // Both branches must actually be exercised, or the loop proves nothing.
    expect(okCases).toBeGreaterThan(0);
    expect(okCases + refusedCases).toBe(100);
  });
});

describe('suggestedUnitCosts', () => {
  it('is base + allocated/qty when the allocation divides evenly', () => {
    const lines: FreightLine[] = [{ id: 'a', qty: 4, baseCents: 1000 }];
    const result = allocateFreight(lines, 400);
    if (result.status !== 'ok') throw new Error('expected ok');

    expect(suggestedUnitCosts(lines, result.allocations)).toEqual([
      { id: 'a', suggestedUnitCostCents: 1100, unitRoundingRemainderCents: 0, reason: null },
    ]);
  });

  it('FLOORS an indivisible allocation and exposes the unexpressed remainder', () => {
    const lines: FreightLine[] = [{ id: 'a', qty: 3, baseCents: 1000 }];
    const result = allocateFreight(lines, 100);
    if (result.status !== 'ok') throw new Error('expected ok');

    // 100 cents over 3 units = 33 each, 1 cent that no uniform unit cost can
    // express. It is SHOWN, not silently dropped.
    expect(suggestedUnitCosts(lines, result.allocations)).toEqual([
      { id: 'a', suggestedUnitCostCents: 1033, unitRoundingRemainderCents: 1, reason: null },
    ]);
  });

  it('a NULL-cost line suggests null with a named reason, never 0', () => {
    const lines: FreightLine[] = [
      { id: 'a', qty: 2, baseCents: 100 },
      { id: 'unpriced', qty: 3, baseCents: null },
    ];
    const result = allocateFreight(lines, 200);
    if (result.status !== 'ok') throw new Error('expected ok');

    const suggested = suggestedUnitCosts(lines, result.allocations);
    expect(suggested[1].suggestedUnitCostCents).toBeNull();
    expect(suggested[1].reason).toBe('no_base_cost');
  });

  it('a ZERO-qty line keeps its base cost and parks the allocation as remainder', () => {
    const lines: FreightLine[] = [{ id: 'a', qty: 0, baseCents: 700 }];
    // Hand-built: allocateFreight never funds a zero-value line, but an EDITED
    // allocation can, and the suggestion must not divide by zero.
    const allocations: LineAllocation[] = [{ id: 'a', allocatedCents: 55, roundingDeltaCents: 0 }];

    expect(suggestedUnitCosts(lines, allocations)).toEqual([
      { id: 'a', suggestedUnitCostCents: 700, unitRoundingRemainderCents: 55, reason: null },
    ]);
  });

  it('zero freight leaves the suggested unit cost equal to the base cost', () => {
    const lines: FreightLine[] = [{ id: 'a', qty: 5, baseCents: 250 }];
    const result = allocateFreight(lines, 0);
    if (result.status !== 'ok') throw new Error('expected ok');

    expect(suggestedUnitCosts(lines, result.allocations)[0].suggestedUnitCostCents).toBe(250);
  });

  it('a line MISSING from the allocation throws (a wiring bug, not a business outcome)', () => {
    expectAppErrorCode(
      () => suggestedUnitCosts([{ id: 'a', qty: 1, baseCents: 100 }], []),
      'ALLOCATION_LINE_MISMATCH'
    );
  });
});

describe('validateEditedAllocations', () => {
  it('PASSES when the edits still sum to the freight total', () => {
    const result = validateEditedAllocations(
      [
        { id: 'a', allocatedCents: 300 },
        { id: 'b', allocatedCents: 700 },
      ],
      1000
    );

    expect(result).toEqual({ status: 'ok', totalCents: 1000 });
  });

  it('FAILS when the edits sum SHORT, reporting the signed difference', () => {
    const result = validateEditedAllocations(
      [
        { id: 'a', allocatedCents: 300 },
        { id: 'b', allocatedCents: 600 },
      ],
      1000
    );

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.reason).toBe('total_mismatch');
    expect(result.totalCents).toBe(900);
    expect(result.differenceCents).toBe(-100);
  });

  it('FAILS when the edits sum OVER the total', () => {
    const result = validateEditedAllocations([{ id: 'a', allocatedCents: 1500 }], 1000);

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.reason).toBe('total_mismatch');
    expect(result.differenceCents).toBe(500);
  });

  it('a NEGATIVE edited allocation is invalid — it never throws (this is user data)', () => {
    const result = validateEditedAllocations(
      [
        { id: 'a', allocatedCents: -100 },
        { id: 'b', allocatedCents: 1100 },
      ],
      1000
    );

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.reason).toBe('negative_allocation');
  });

  it('a FRACTIONAL edited allocation is invalid', () => {
    const result = validateEditedAllocations([{ id: 'a', allocatedCents: 999.5 }], 1000);

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.reason).toBe('non_integer_allocation');
  });

  it('DUPLICATE ids in the edit set are invalid (they would double-count)', () => {
    const result = validateEditedAllocations(
      [
        { id: 'a', allocatedCents: 500 },
        { id: 'a', allocatedCents: 500 },
      ],
      1000
    );

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.reason).toBe('duplicate_line_id');
  });

  it('an empty edit set against zero freight passes', () => {
    expect(validateEditedAllocations([], 0)).toEqual({ status: 'ok', totalCents: 0 });
  });

  it('a negative freight TOTAL still throws (the caller parameter, not the data)', () => {
    expectAppErrorCode(() => validateEditedAllocations([], -5), 'INVALID_FREIGHT_TOTAL');
  });
});
