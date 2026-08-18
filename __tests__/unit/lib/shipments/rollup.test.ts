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
 *
 * QA-5 (pack REV-7): `uncountedItemCount` is RECEIVED-SCOPED — the same number
 * the close guard enforces. A DISCARDED line that was never counted is a
 * decision, not an omission, and counting it here pinned a permanent "1
 * uncounted" on the list and suppressed "No discrepancies" forever.
 */

import {
  lineDiscrepancy,
  rollupDiscrepancies,
  supplyOrderLineDiscrepancy,
  type SupplyOrderRollupLine,
} from '@/lib/shipments/rollup';

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

/** A linked line as the rollup reads it; RECEIVED unless a test says otherwise. */
const rl = (line: {
  expectedQuantity: number | null;
  countedQuantity: number | null;
  status?: 'RECEIVED' | 'GRADUATED' | 'DISCARDED';
}) => ({ status: 'RECEIVED' as const, ...line });

describe('rollupDiscrepancies (header totals)', () => {
  it('does NOT cancel over against under', () => {
    const rollup = rollupDiscrepancies([
      rl({ expectedQuantity: 10, countedQuantity: 15 }), // +5
      rl({ expectedQuantity: 10, countedQuantity: 7 }), // -3
    ]);
    expect(rollup.totalOver).toBe(5);
    expect(rollup.totalUnder).toBe(3);
  });

  it('reports both totals as magnitudes (totalUnder is never negative)', () => {
    const rollup = rollupDiscrepancies([rl({ expectedQuantity: 4, countedQuantity: 1 })]);
    expect(rollup.totalOver).toBe(0);
    expect(rollup.totalUnder).toBe(3);
  });

  it('excludes uncounted lines from the totals but counts them in the census', () => {
    const rollup = rollupDiscrepancies([
      rl({ expectedQuantity: 10, countedQuantity: 12 }), // +2
      rl({ expectedQuantity: 10, countedQuantity: null }), // unknown
      rl({ expectedQuantity: null, countedQuantity: null }), // unknown
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

  it('QA-5: a DISCARDED never-counted line is NOT uncounted work (RECEIVED-scoped)', () => {
    const rollup = rollupDiscrepancies([
      rl({ expectedQuantity: 10, countedQuantity: 10 }),
      rl({ expectedQuantity: 4, countedQuantity: null, status: 'DISCARDED' }),
    ]);
    // The census still sees both lines — only the "still owed a count" number
    // is scoped to the lines the close guard would actually block on.
    expect(rollup.itemCount).toBe(2);
    expect(rollup.countedItemCount).toBe(1);
    expect(rollup.uncountedItemCount).toBe(0);
  });

  it('QA-5: a GRADUATED line with no count is settled work, not uncounted work', () => {
    const rollup = rollupDiscrepancies([
      rl({ expectedQuantity: 4, countedQuantity: null, status: 'GRADUATED' }),
    ]);
    expect(rollup.uncountedItemCount).toBe(0);
    expect(rollup.itemCount).toBe(1);
  });

  it('QA-5: a RECEIVED never-counted line IS uncounted work', () => {
    const rollup = rollupDiscrepancies([rl({ expectedQuantity: 4, countedQuantity: null })]);
    expect(rollup.uncountedItemCount).toBe(1);
  });

  it('sums the NULL-expected lines into totalOver in full', () => {
    const rollup = rollupDiscrepancies([
      rl({ expectedQuantity: null, countedQuantity: 6 }),
      rl({ expectedQuantity: null, countedQuantity: 4 }),
    ]);
    expect(rollup.totalOver).toBe(10);
    expect(rollup.discrepancyItemCount).toBe(2);
  });

  it('a perfectly matched shipment reports zeros with a non-zero census', () => {
    const rollup = rollupDiscrepancies([
      rl({ expectedQuantity: 5, countedQuantity: 5 }),
      rl({ expectedQuantity: 0, countedQuantity: 0 }),
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

/**
 * THE SUPPLY-ORDER HALF (Receiving/Labeling overhaul, contract pack C2c.3;
 * plan OCp2-7).
 *
 * ONE function, parameterized by model. The three rules above survive verbatim
 * — they were never about the column NAMES:
 *
 *   - the quantities come from the model's OWN column family (legacy:
 *     expected/counted; supply order: ordered/verified);
 *   - "still owed" is the model's own status (legacy RECEIVED, supply order
 *     ORDERED), and a line that is still owed contributes NOTHING (unknown is
 *     not zero);
 *   - over and under never cancel.
 *
 * The one NEW rule is the unordered arrival (OCs2-20): a line nobody ordered is
 * counted ONLY in `unorderedLines`, never in `overUnits` or
 * `surplusValueCents`. The W1 model folded an unexpected arrival into the over
 * total; the supply-order model cannot, because "over" there means "the
 * supplier sent more of THIS line than we paid for", and an unordered line has
 * no order to be over.
 */

const so = (line: Partial<SupplyOrderRollupLine>): SupplyOrderRollupLine => ({
  status: 'VERIFIED',
  orderedQuantity: 10,
  verifiedQuantity: 10,
  lineTotalCents: 10000,
  ...line,
});

describe('supplyOrderLineDiscrepancy (per-line, new model)', () => {
  it('reports a SHORT line with its money', () => {
    expect(supplyOrderLineDiscrepancy(so({ verifiedQuantity: 7 }))).toEqual({
      shortUnits: 3,
      overUnits: 0,
      lossCents: 3000,
      surplusValueCents: 0,
      unordered: false,
    });
  });

  it('reports an OVER line with its surplus value', () => {
    expect(supplyOrderLineDiscrepancy(so({ verifiedQuantity: 12 }))).toEqual({
      shortUnits: 0,
      overUnits: 2,
      lossCents: 0,
      surplusValueCents: 2000,
      unordered: false,
    });
  });

  it('a matched line has NOTHING to report', () => {
    expect(supplyOrderLineDiscrepancy(so({}))).toBeNull();
  });

  it('an UNVERIFIED line is unknown, not zero', () => {
    expect(
      supplyOrderLineDiscrepancy(so({ status: 'ORDERED', verifiedQuantity: null })),
    ).toBeNull();
  });

  it('an UNORDERED arrival is flagged, with no short/over and no money', () => {
    expect(
      supplyOrderLineDiscrepancy(so({ orderedQuantity: null, verifiedQuantity: 6 })),
    ).toEqual({
      shortUnits: 0,
      overUnits: 0,
      lossCents: 0,
      surplusValueCents: 0,
      unordered: true,
    });
  });
});

describe('rollupDiscrepancies({ model: "supply-order" })', () => {
  it('a shortage NEVER renders as "no discrepancies"', () => {
    const rollup = rollupDiscrepancies([so({ verifiedQuantity: 7 })], { model: 'supply-order' });
    expect(rollup.linesWithDiscrepancy).toBe(1);
    expect(rollup.shortUnits).toBe(3);
    expect(rollup.lossCents).toBe(3000);
  });

  it('does NOT cancel short against over, and sums the money separately', () => {
    const rollup = rollupDiscrepancies(
      [so({ verifiedQuantity: 7 }), so({ verifiedQuantity: 13 })],
      { model: 'supply-order' },
    );
    expect(rollup).toEqual({
      linesWithDiscrepancy: 2,
      shortUnits: 3,
      overUnits: 3,
      lossCents: 3000,
      surplusValueCents: 3000,
      unorderedLines: 0,
    });
  });

  it('counts an UNORDERED line ONLY in unorderedLines (OCs2-20)', () => {
    const rollup = rollupDiscrepancies(
      [so({ orderedQuantity: null, verifiedQuantity: 6, lineTotalCents: 600 })],
      { model: 'supply-order' },
    );
    expect(rollup).toEqual({
      linesWithDiscrepancy: 0,
      shortUnits: 0,
      overUnits: 0,
      lossCents: 0,
      surplusValueCents: 0,
      unorderedLines: 1,
    });
  });

  it('a line still ORDERED contributes nothing (the "still owed" status)', () => {
    const rollup = rollupDiscrepancies(
      [so({ status: 'ORDERED', verifiedQuantity: null }), so({ verifiedQuantity: 8 })],
      { model: 'supply-order' },
    );
    expect(rollup.shortUnits).toBe(2);
    expect(rollup.linesWithDiscrepancy).toBe(1);
  });

  it('an unpriced line still reports its UNITS, and 0 money truthfully', () => {
    const rollup = rollupDiscrepancies(
      [so({ verifiedQuantity: 7, lineTotalCents: null })],
      { model: 'supply-order' },
    );
    expect(rollup.shortUnits).toBe(3);
    expect(rollup.lossCents).toBe(0);
  });

  it('an empty order rolls up to all zeros', () => {
    expect(rollupDiscrepancies([], { model: 'supply-order' })).toEqual({
      linesWithDiscrepancy: 0,
      shortUnits: 0,
      overUnits: 0,
      lossCents: 0,
      surplusValueCents: 0,
      unorderedLines: 0,
    });
  });

  it('the LEGACY half is unchanged, with or without an explicit model', () => {
    const lines = [rl({ expectedQuantity: 10, countedQuantity: 12 })];
    expect(rollupDiscrepancies(lines)).toEqual(rollupDiscrepancies(lines, { model: 'legacy' }));
    expect(rollupDiscrepancies(lines).totalOver).toBe(2);
  });
});
