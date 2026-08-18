/**
 * @jest-environment node
 *
 * Unit tests for `lib/supply-orders/money.ts` — the ONE money function on a
 * supply-order line (spec D4 / §5.3; contract pack C2a.1).
 *
 * The old freight calculator's property pins move here (pack C2b.4 property ->
 * test matrix). Two of its five rows are M2a's to re-prove:
 *
 *   EXACTNESS      old home `__tests__/unit/lib/shipments/cost-allocation.test.ts`
 *                  ("roundingDeltaCents ... SUMS to the distributed residual" +
 *                  the 100-case property loop's `sumAllocated === freightTotal`).
 *                  New home: "sum of batch shares == cumulative(verified)" and
 *                  "loss + cumulative(verified) == total".
 *   SAFE-INTEGER   old home the same file's "magnitudes BEYOND float precision
 *                  do not drift the invariant". New home: the 1e8 x 1e6 pin and
 *                  the float-drift case below.
 *
 * Pure module: no Prisma, no Next, no mocks needed.
 */

import {
  lineMoney,
  cumulative,
  batchShareCents,
  type LineMoneyInput,
} from '@/lib/supply-orders/money';

/** The whole line, stocked in `sizes` batches, share by share. */
function batchShares(
  lineTotalCents: number | null,
  basisQuantity: number | null,
  sizes: readonly number[],
): (number | null)[] {
  let stockedBefore = 0;
  return sizes.map((size) => {
    const share = batchShareCents(lineTotalCents, basisQuantity, stockedBefore, size);
    stockedBefore += size;
    return share;
  });
}

describe('cumulative — floor(total * k / basis), in BigInt', () => {
  it('is exact on the 10001 / 3 line (the pack\'s named case)', () => {
    expect(cumulative(10001, 3, 0)).toBe(0);
    expect(cumulative(10001, 3, 1)).toBe(3333);
    expect(cumulative(10001, 3, 2)).toBe(6667);
    expect(cumulative(10001, 3, 3)).toBe(10001);
  });

  it('SAFE-INTEGER: stays exact at the D4 bound (1e8 cents x 1e6 units)', () => {
    // 1e8 x 1e6 = 1e14 products; D4 names this magnitude as the contract bound.
    expect(cumulative(100_000_000, 1_000_000, 1_000_000)).toBe(100_000_000);
    expect(cumulative(100_000_000, 1_000_000, 999_999)).toBe(99_999_900);
    expect(cumulative(100_000_000, 3, 1)).toBe(33_333_333);
  });

  it('SAFE-INTEGER: magnitudes BEYOND float precision do not drift', () => {
    // total * k = 19999998009999999 > 2^53, so the double rounds the PRODUCT up
    // to ...010000000 and a float implementation answers 1999999801 here.
    expect(cumulative(2_000_000_001, 10_000_000, 9_999_999)).toBe(1_999_999_800);
    expect(Math.floor((2_000_000_001 * 9_999_999) / 10_000_000)).toBe(1_999_999_801);
  });

  it('throws on a basis <= 0 (nothing to divide by)', () => {
    expect(() => cumulative(1000, 0, 1)).toThrow(/basis/i);
    expect(() => cumulative(1000, -1, 1)).toThrow(/basis/i);
  });

  it('throws on a negative k (a batch cannot un-happen)', () => {
    expect(() => cumulative(1000, 10, -1)).toThrow();
  });

  it('throws on non-integer / unsafe inputs (a caller contract violation)', () => {
    expect(() => cumulative(1000.5, 10, 1)).toThrow();
    expect(() => cumulative(1000, 10.5, 1)).toThrow();
    expect(() => cumulative(1000, 10, 1.5)).toThrow();
    expect(() => cumulative(Number.MAX_SAFE_INTEGER + 2, 10, 1)).toThrow();
    expect(() => cumulative(Number.NaN, 10, 1)).toThrow();
  });
});

describe('batchShareCents — cumulative(after) - cumulative(before)', () => {
  it('EXACTNESS: the shares of a fully-stocked line sum to cumulative(verified)', () => {
    // 10001 cents over 3 ordered units, stocked one at a time.
    const shares = batchShares(10001, 3, [1, 1, 1]);
    expect(shares).toEqual([3333, 3334, 3334]);
    expect(shares.reduce<number>((sum, s) => sum + (s ?? 0), 0)).toBe(cumulative(10001, 3, 3));
  });

  it('EXACTNESS: holds for uneven batch sizes over a large line', () => {
    const sizes = [7, 1, 40, 2, 50];
    const verified = sizes.reduce((a, b) => a + b, 0);
    const shares = batchShares(999_983, 100, sizes);
    expect(shares.reduce<number>((sum, s) => sum + (s ?? 0), 0)).toBe(
      cumulative(999_983, 100, verified),
    );
  });

  it('returns null when the total or the basis is unknown, or the basis is 0', () => {
    expect(batchShareCents(null, 100, 0, 5)).toBeNull();
    expect(batchShareCents(10_000, null, 0, 5)).toBeNull();
    expect(batchShareCents(10_000, 0, 0, 5)).toBeNull();
    expect(batchShareCents(10_000, -3, 0, 5)).toBeNull();
  });

  it('a total of 0 with a positive basis is a KNOWN zero, not unknown', () => {
    expect(batchShareCents(0, 10, 0, 5)).toBe(0);
  });

  it('a zero-unit batch takes 0 cents', () => {
    expect(batchShareCents(10001, 3, 1, 0)).toBe(0);
  });
});

describe('lineMoney — unit cost (round-half-even, one per line)', () => {
  it('rounds TRUE half-even at the tie: 1/2 -> 0, 3/2 -> 2', () => {
    expect(lineMoney({ lineTotalCents: 1, orderedQuantity: 2, verifiedQuantity: 2 }).unitCostCents)
      .toBe(0);
    expect(lineMoney({ lineTotalCents: 3, orderedQuantity: 2, verifiedQuantity: 2 }).unitCostCents)
      .toBe(2);
    // and the non-tie neighbours still round to nearest
    expect(lineMoney({ lineTotalCents: 5, orderedQuantity: 2, verifiedQuantity: 2 }).unitCostCents)
      .toBe(2);
    expect(lineMoney({ lineTotalCents: 7, orderedQuantity: 2, verifiedQuantity: 2 }).unitCostCents)
      .toBe(4);
  });

  it('is ONE value per line: 10001 / 3 = 3334, whatever has been verified', () => {
    for (const verifiedQuantity of [0, 1, 2, 3, 5]) {
      expect(
        lineMoney({ lineTotalCents: 10001, orderedQuantity: 3, verifiedQuantity }).unitCostCents,
      ).toBe(3334);
    }
  });

  it('a lineTotalCents of 0 is NOT a $0.00 valuation: unit cost NULL, 0 / 0', () => {
    const money = lineMoney({ lineTotalCents: 0, orderedQuantity: 100, verifiedQuantity: 90 });
    expect(money.unitCostCents).toBeNull();
    expect(money.derivation).toBeNull();
    expect(money.lossCents).toBe(0);
    expect(money.surplusValueCents).toBe(0);
  });

  it('an unknown total or an absent basis yields a NULL unit cost, never 0', () => {
    expect(
      lineMoney({ lineTotalCents: null, orderedQuantity: 10, verifiedQuantity: 10 }).unitCostCents,
    ).toBeNull();
    expect(
      lineMoney({ lineTotalCents: 1000, orderedQuantity: null, verifiedQuantity: null })
        .unitCostCents,
    ).toBeNull();
    expect(
      lineMoney({ lineTotalCents: 1000, orderedQuantity: 0, verifiedQuantity: 5 }).unitCostCents,
    ).toBeNull();
  });
});

describe('lineMoney — basis (orderedQuantity ?? verifiedQuantity)', () => {
  it('an ordered line divides by what was ORDERED', () => {
    const money = lineMoney({ lineTotalCents: 125_000, orderedQuantity: 100, verifiedQuantity: 90 });
    expect(money.basisQuantity).toBe(100);
    expect(money.unitCostCents).toBe(1250);
  });

  it('an UNORDERED arrival divides by what was VERIFIED, and never loses/gains', () => {
    const money = lineMoney({ lineTotalCents: 125_000, orderedQuantity: null, verifiedQuantity: 100 });
    expect(money.basisQuantity).toBe(100);
    expect(money.unitCostCents).toBe(1250);
    expect(money.lossCents).toBe(0);
    expect(money.surplusValueCents).toBe(0);
  });

  it('an unordered arrival with no total has no unit cost (not 0)', () => {
    const money = lineMoney({ lineTotalCents: null, orderedQuantity: null, verifiedQuantity: 40 });
    expect(money.basisQuantity).toBe(40);
    expect(money.unitCostCents).toBeNull();
    expect(money.lossCents).toBe(0);
    expect(money.surplusValueCents).toBe(0);
  });

  it('no ordered and no verified quantity leaves the basis NULL', () => {
    const money = lineMoney({ lineTotalCents: 1000, orderedQuantity: null, verifiedQuantity: null });
    expect(money.basisQuantity).toBeNull();
    expect(money.unitCostCents).toBeNull();
    expect(money.derivation).toBeNull();
  });
});

describe('lineMoney — loss / surplus (§5.3 invariants)', () => {
  it('SHORT: lossCents + cumulative(verified) === lineTotalCents', () => {
    const input: LineMoneyInput = {
      lineTotalCents: 10001,
      orderedQuantity: 3,
      verifiedQuantity: 2,
    };
    const money = lineMoney(input);
    expect(money.lossCents).toBe(10001 - cumulative(10001, 3, 2));
    expect(money.lossCents + cumulative(10001, 3, 2)).toBe(10001);
    expect(money.surplusValueCents).toBe(0);
  });

  it('SHORT on an awkward line: the invariant still closes to the cent', () => {
    const money = lineMoney({ lineTotalCents: 999_983, orderedQuantity: 97, verifiedQuantity: 61 });
    expect(money.lossCents + cumulative(999_983, 97, 61)).toBe(999_983);
  });

  it('OVER: surplusValueCents === cumulative(verified) - lineTotalCents', () => {
    const money = lineMoney({ lineTotalCents: 10001, orderedQuantity: 3, verifiedQuantity: 5 });
    expect(money.surplusValueCents).toBe(cumulative(10001, 3, 5) - 10001);
    expect(money.lossCents).toBe(0);
  });

  it('EQUAL: both are 0', () => {
    const money = lineMoney({ lineTotalCents: 10001, orderedQuantity: 3, verifiedQuantity: 3 });
    expect(money.lossCents).toBe(0);
    expect(money.surplusValueCents).toBe(0);
  });

  it('ZERO VERIFY (VERIFIED(0)): the whole line is the loss', () => {
    const money = lineMoney({ lineTotalCents: 125_000, orderedQuantity: 100, verifiedQuantity: 0 });
    expect(money.lossCents).toBe(125_000);
    expect(money.surplusValueCents).toBe(0);
  });

  it('NOT YET VERIFIED: no loss is claimed before anything is counted', () => {
    const money = lineMoney({
      lineTotalCents: 125_000,
      orderedQuantity: 100,
      verifiedQuantity: null,
    });
    expect(money.lossCents).toBe(0);
    expect(money.surplusValueCents).toBe(0);
  });

  it('neither figure is ever negative, across a seeded sweep', () => {
    // Numerical-Recipes LCG, literal seed — reproducible forever (the
    // cost-allocation property loop's idiom).
    let state = 20260818 >>> 0;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };

    let shortCases = 0;
    let overCases = 0;

    for (let i = 0; i < 200; i += 1) {
      const ordered = 1 + Math.floor(next() * 500);
      const verified = Math.floor(next() * 600);
      const total = Math.floor(next() * 5_000_000);
      const money = lineMoney({
        lineTotalCents: total,
        orderedQuantity: ordered,
        verifiedQuantity: verified,
      });

      expect(money.lossCents).toBeGreaterThanOrEqual(0);
      expect(money.surplusValueCents).toBeGreaterThanOrEqual(0);
      expect(Number.isSafeInteger(money.lossCents)).toBe(true);
      expect(Number.isSafeInteger(money.surplusValueCents)).toBe(true);
      // Loss and surplus are mutually exclusive.
      expect(money.lossCents === 0 || money.surplusValueCents === 0).toBe(true);

      if (total > 0 && verified < ordered) {
        shortCases += 1;
        expect(money.lossCents + cumulative(total, ordered, verified)).toBe(total);
      }
      if (total > 0 && verified > ordered) {
        overCases += 1;
        expect(money.surplusValueCents).toBe(cumulative(total, ordered, verified) - total);
      }
    }

    // Both branches must actually be exercised, or the sweep proves nothing.
    expect(shortCases).toBeGreaterThan(0);
    expect(overCases).toBeGreaterThan(0);
  });
});

describe('lineMoney — the derivation string rides every display', () => {
  it('names the ORDERED basis for an ordered line (spec D4 verbatim)', () => {
    const money = lineMoney({ lineTotalCents: 125_000, orderedQuantity: 100, verifiedQuantity: 90 });
    expect(money.derivation).toBe('$1,250.00 / 100 ordered = $12.50/unit');
  });

  it('names the VERIFIED basis for an unordered arrival', () => {
    const money = lineMoney({ lineTotalCents: 10001, orderedQuantity: null, verifiedQuantity: 3 });
    expect(money.derivation).toBe('$100.01 / 3 verified = $33.34/unit');
  });

  it('is NULL whenever the unit cost is NULL (no derivation of a non-number)', () => {
    for (const input of [
      { lineTotalCents: null, orderedQuantity: 10, verifiedQuantity: 10 },
      { lineTotalCents: 0, orderedQuantity: 10, verifiedQuantity: 10 },
      { lineTotalCents: 1000, orderedQuantity: null, verifiedQuantity: null },
    ] as LineMoneyInput[]) {
      const money = lineMoney(input);
      expect(money.unitCostCents).toBeNull();
      expect(money.derivation).toBeNull();
    }
  });
});
