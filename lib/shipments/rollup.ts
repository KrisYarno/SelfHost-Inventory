/**
 * Receiving discrepancy arithmetic (contract pack REV-2 T4, W1-2a).
 *
 * COMPUTED ON READ — deliberately NO stored column on `inbound_shipments`, so a
 * recount, a late link, or an unlink is reflected the instant the staging row
 * changes and no denormalized total can ever drift from its lines.
 *
 * Three rules carry the whole contract:
 *
 *   1. NULL-EXPECTED: an unexpected arrival (`expectedQuantity` NULL) counts in
 *      FULL — `counted - COALESCE(expected, 0)`. Nobody predicted the box, but
 *      it is on the dock; reporting it as "no discrepancy" would hide exactly
 *      the event receiving exists to catch.
 *   2. UNCOUNTED IS UNKNOWN, NOT ZERO: a line with `countedQuantity` NULL
 *      contributes NOTHING to the totals (truthful-data north star). It is
 *      surfaced through `uncountedItemCount` instead — the number the close
 *      guard and the UI both care about.
 *   3. NON-CANCELLING TOTALS: a +5 line and a -3 line report
 *      `{ totalOver: 5, totalUnder: 3 }`, never a net of 2. Both totals are
 *      MAGNITUDES (>= 0); the sign lives in the field name. Netting would let a
 *      big over hide a big under, which is the failure mode this lane exists to
 *      end.
 *
 * Pure: no Prisma, no Next — the shapes W1-4b renders are pinned without a DB.
 */

/** The only two columns the arithmetic reads. Callers pass whole rows. */
export type DiscrepancyLine = {
  expectedQuantity: number | null;
  countedQuantity: number | null;
};

/** Which way a counted line missed, or `null` while it is still uncounted. */
export type DiscrepancyDirection = 'OVER' | 'UNDER' | 'MATCH';

export type LineDiscrepancy = {
  /** countedQuantity is present — the line has been physically counted. */
  counted: boolean;
  /** expectedQuantity is NULL — an unexpected arrival (rule 1 applied). */
  expectedMissing: boolean;
  /** counted - COALESCE(expected, 0); `null` while uncounted (rule 2). */
  delta: number | null;
  direction: DiscrepancyDirection | null;
};

export type DiscrepancyRollup = {
  /** Linked lines, any status. */
  itemCount: number;
  countedItemCount: number;
  uncountedItemCount: number;
  /** Counted lines whose delta is non-zero. */
  discrepancyItemCount: number;
  /** Sum of positive deltas (magnitude, non-cancelling). */
  totalOver: number;
  /** Sum of |negative deltas| (magnitude, non-cancelling). */
  totalUnder: number;
};

/**
 * Per-line flags for the receiving detail. See the module header for the three
 * rules; this function IS the NULL-expected rule.
 */
export function lineDiscrepancy(line: DiscrepancyLine): LineDiscrepancy {
  const expectedMissing = line.expectedQuantity === null || line.expectedQuantity === undefined;

  if (line.countedQuantity === null || line.countedQuantity === undefined) {
    return { counted: false, expectedMissing, delta: null, direction: null };
  }

  const delta = line.countedQuantity - (line.expectedQuantity ?? 0);
  return {
    counted: true,
    expectedMissing,
    delta,
    direction: delta > 0 ? 'OVER' : delta < 0 ? 'UNDER' : 'MATCH',
  };
}

/**
 * The header rollup. Every linked line is censused; only COUNTED lines reach
 * the totals, and over/under never cancel.
 */
export function rollupDiscrepancies(lines: readonly DiscrepancyLine[]): DiscrepancyRollup {
  const rollup: DiscrepancyRollup = {
    itemCount: lines.length,
    countedItemCount: 0,
    uncountedItemCount: 0,
    discrepancyItemCount: 0,
    totalOver: 0,
    totalUnder: 0,
  };

  for (const line of lines) {
    const { counted, delta } = lineDiscrepancy(line);
    if (!counted || delta === null) {
      rollup.uncountedItemCount += 1;
      continue;
    }
    rollup.countedItemCount += 1;
    if (delta > 0) {
      rollup.totalOver += delta;
      rollup.discrepancyItemCount += 1;
    } else if (delta < 0) {
      rollup.totalUnder += -delta;
      rollup.discrepancyItemCount += 1;
    }
  }

  return rollup;
}
