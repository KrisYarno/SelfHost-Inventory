/**
 * @jest-environment node
 *
 * T4 discrepancy arithmetic (contract pack REV-2, W1-2a).
 *
 * The rollup is COMPUTED ON READ — no stored column — so these pins are the
 * whole definition of "what the receiving header says". Two rules carry the
 * weight:
 *   - NULL-EXPECTED: an unexpected arrival (expectedQuantity NULL) counts in
 *     FULL (counted - COALESCE(expected, 0)), never as "no discrepancy".
 *   - NON-CANCELLING: a +5 line and a -3 line report {over 5, under 3}, never a
 *     net of 2. Both totals are magnitudes.
 * An UNCOUNTED line contributes NOTHING (unknown is not zero — truthful data).
 */

import { lineDiscrepancy, rollupDiscrepancies } from '@/lib/shipments/rollup';

describe('lineDiscrepancy (per-item flags)', () => {
  it('counts an unexpected arrival IN FULL (expected NULL -> COALESCE 0)', () => {
    expect(lineDiscrepancy({ expectedQuantity: null, countedQuantity: 7 })).toEqual({
      counted: true,
      expectedMissing: true,
      delta: 7,
      direction: 'OVER',
    });
  });

  it('reports a short receipt as UNDER with a negative delta', () => {
    expect(lineDiscrepancy({ expectedQuantity: 10, countedQuantity: 7 })).toEqual({
      counted: true,
      expectedMissing: false,
      delta: -3,
      direction: 'UNDER',
    });
  });

  it('reports an exact receipt as MATCH with delta 0', () => {
    expect(lineDiscrepancy({ expectedQuantity: 10, countedQuantity: 10 })).toEqual({
      counted: true,
      expectedMissing: false,
      delta: 0,
      direction: 'MATCH',
    });
  });

  it('an UNCOUNTED line is unknown, not zero: delta null, direction null', () => {
    expect(lineDiscrepancy({ expectedQuantity: 10, countedQuantity: null })).toEqual({
      counted: false,
      expectedMissing: false,
      delta: null,
      direction: null,
    });
  });

  it('an uncounted line with no expectation is still unknown (both NULL)', () => {
    expect(lineDiscrepancy({ expectedQuantity: null, countedQuantity: null })).toEqual({
      counted: false,
      expectedMissing: true,
      delta: null,
      direction: null,
    });
  });

  it('a counted ZERO against a NULL expectation is a MATCH, not an OVER', () => {
    expect(lineDiscrepancy({ expectedQuantity: null, countedQuantity: 0 })).toEqual({
      counted: true,
      expectedMissing: true,
      delta: 0,
      direction: 'MATCH',
    });
  });

  it('a counted ZERO against a real expectation is the full shortfall', () => {
    expect(lineDiscrepancy({ expectedQuantity: 12, countedQuantity: 0 })).toMatchObject({
      delta: -12,
      direction: 'UNDER',
    });
  });
});

describe('rollupDiscrepancies (header totals)', () => {
  it('does NOT cancel over against under', () => {
    const rollup = rollupDiscrepancies([
      { expectedQuantity: 10, countedQuantity: 15 }, // +5
      { expectedQuantity: 10, countedQuantity: 7 }, // -3
    ]);
    expect(rollup.totalOver).toBe(5);
    expect(rollup.totalUnder).toBe(3);
  });

  it('reports both totals as magnitudes (totalUnder is never negative)', () => {
    const rollup = rollupDiscrepancies([{ expectedQuantity: 4, countedQuantity: 1 }]);
    expect(rollup.totalOver).toBe(0);
    expect(rollup.totalUnder).toBe(3);
  });

  it('excludes uncounted lines from the totals but counts them in the census', () => {
    const rollup = rollupDiscrepancies([
      { expectedQuantity: 10, countedQuantity: 12 }, // +2
      { expectedQuantity: 10, countedQuantity: null }, // unknown
      { expectedQuantity: null, countedQuantity: null }, // unknown
    ]);
    expect(rollup).toEqual({
      itemCount: 3,
      countedItemCount: 1,
      uncountedItemCount: 2,
      discrepancyItemCount: 1,
      totalOver: 2,
      totalUnder: 0,
    });
  });

  it('sums the NULL-expected lines into totalOver in full', () => {
    const rollup = rollupDiscrepancies([
      { expectedQuantity: null, countedQuantity: 6 },
      { expectedQuantity: null, countedQuantity: 4 },
    ]);
    expect(rollup.totalOver).toBe(10);
    expect(rollup.discrepancyItemCount).toBe(2);
  });

  it('a perfectly matched shipment reports zeros with a non-zero census', () => {
    const rollup = rollupDiscrepancies([
      { expectedQuantity: 5, countedQuantity: 5 },
      { expectedQuantity: 0, countedQuantity: 0 },
    ]);
    expect(rollup).toEqual({
      itemCount: 2,
      countedItemCount: 2,
      uncountedItemCount: 0,
      discrepancyItemCount: 0,
      totalOver: 0,
      totalUnder: 0,
    });
  });

  it('an empty shipment rolls up to all zeros', () => {
    expect(rollupDiscrepancies([])).toEqual({
      itemCount: 0,
      countedItemCount: 0,
      uncountedItemCount: 0,
      discrepancyItemCount: 0,
      totalOver: 0,
      totalUnder: 0,
    });
  });
});
