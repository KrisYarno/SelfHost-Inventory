// @jest-environment node
//
// Reconciliation lane R-A (spec REV-7 D2, pack C1b.2) — THE CONDITION TABLE,
// one pin per row.
//
// D2 is a TOTAL, ORDERED table: every live deduction and every negative adjust
// lands on exactly one row, and the rows are evaluated top to bottom. Two of
// the orderings are load-bearing and neither is obvious from the outcome names:
//
//   * `!referenceTyped` is checked BEFORE the resolver's `unusable`. A packer
//     who typed nothing did not produce an unusable reference — they produced
//     no reference. Recording `declined/unusable` there would invent a decline
//     that never happened, and the report would count it as one.
//   * a SUPPLIED id with an ABSENT chip records `no-order-context`, not
//     `explicit-non-order-intent`: `mapDeductionIntent(undefined)` defaults to
//     `other` for the LEDGER's benefit, but an untapped chip is not an
//     operator's statement, and the attempt record says what happened.
//
// The classifier is pure, so each row is one assertion here; the ROUTE suites
// pin only that the route feeds it the right locals and writes the exact row.
import {
  classifyAdjust,
  classifyDeductSimple,
  type AdjustLocals,
  type DeductSimpleLocals,
} from '@/lib/attribution/classify';

/** The all-absent baseline: nothing stamped, no id, no chip, no reference. */
function deduct(over: Partial<DeductSimpleLocals> = {}): DeductSimpleLocals {
  return {
    stamped: false,
    idSupplied: false,
    intent: undefined,
    referenceTyped: false,
    resolver: { kind: 'skipped' },
    ...over,
  };
}

function adjust(over: Partial<AdjustLocals> = {}): AdjustLocals {
  return {
    stamped: false,
    idSupplied: false,
    intent: undefined,
    referenceTyped: false,
    resolver: { kind: 'skipped' },
    ...over,
  };
}

describe('classifyDeductSimple — D2 rows 1-8, in order', () => {
  it('row 1: the ledger was STAMPED from the selection -> attributed/selected', () => {
    expect(
      classifyDeductSimple(deduct({ stamped: true, idSupplied: true, intent: 'order' })),
    ).toEqual({ outcome: 'attributed', evidence: 'selected' });
  });

  it('row 2: an id supplied, NOT stamped, chip non-order -> none/explicit-non-order-intent', () => {
    // The workbench "Other" tap sends BOTH the id and the chip; the resolver is
    // skipped whenever an id is supplied, so no decline can be recorded here.
    for (const intent of ['other', 'damage-loss'] as const) {
      expect(classifyDeductSimple(deduct({ idSupplied: true, intent }))).toEqual({
        outcome: 'none',
        reason: 'explicit-non-order-intent',
      });
    }
  });

  it('row 3: an id supplied, NOT stamped, chip ABSENT -> none/no-order-context', () => {
    // NOT `explicit-non-order-intent` (OCp-12): the operator stated nothing, and
    // the same wire payload records `no-order-context` on adjust.
    expect(classifyDeductSimple(deduct({ idSupplied: true }))).toEqual({
      outcome: 'none',
      reason: 'no-order-context',
    });
  });

  it('row 4: chip non-order with no id at all -> none/explicit-non-order-intent', () => {
    for (const intent of ['other', 'damage-loss'] as const) {
      expect(classifyDeductSimple(deduct({ intent }))).toEqual({
        outcome: 'none',
        reason: 'explicit-non-order-intent',
      });
    }
  });

  it('row 5: nothing typed -> none/no-reference-typed, BEFORE the resolver unusable', () => {
    // The precedence is the pin: an empty reference reaching the resolver comes
    // back `unusable`, and recording that would count a decline that is really
    // an absence.
    expect(
      classifyDeductSimple(
        deduct({ intent: 'order', referenceTyped: false, resolver: { kind: 'declined', outcome: 'unusable' } }),
      ),
    ).toEqual({ outcome: 'none', reason: 'no-reference-typed' });
  });

  it('row 6: the resolver THREW -> declined/resolver-error', () => {
    // The route swallows the throw (an infrastructure fault must cost only the
    // attribution) — the attempt row is where that swallow becomes visible.
    expect(
      classifyDeductSimple(deduct({ referenceTyped: true, resolver: { kind: 'threw' } })),
    ).toEqual({ outcome: 'declined', reason: 'resolver-error' });
  });

  it('row 7: the resolver RESOLVED -> attributed/reference-resolved', () => {
    expect(
      classifyDeductSimple(deduct({ referenceTyped: true, resolver: { kind: 'resolved' } })),
    ).toEqual({ outcome: 'attributed', evidence: 'reference-resolved' });
  });

  it('row 8: the resolver DECLINED -> declined/<its own class>', () => {
    for (const outcome of ['unusable', 'unmatched', 'ambiguous', 'not-a-member'] as const) {
      expect(
        classifyDeductSimple(deduct({ referenceTyped: true, resolver: { kind: 'declined', outcome } })),
      ).toEqual({ outcome: 'declined', reason: outcome });
    }
  });

  it('a SKIPPED resolver that reaches row 8 THROWS rather than record a lie', () => {
    // Impossible by construction today: rows 2/3/4 consume every skip. If a
    // route change ever skips the resolver for a NEW reason, this throw is what
    // catches it — the alternative is an attempt row asserting a class nobody
    // computed.
    expect(() =>
      classifyDeductSimple(deduct({ intent: 'order', referenceTyped: true, resolver: { kind: 'skipped' } })),
    ).toThrow('classifyDeductSimple: unreachable');
  });
});

describe('classifyAdjust — D2 rows 1-5 and the resolver rows 3a-3c, in order', () => {
  it('row 1: the ledger was STAMPED -> attributed/selected', () => {
    expect(classifyAdjust(adjust({ stamped: true, idSupplied: true, intent: 'order' }))).toEqual({
      outcome: 'attributed',
      evidence: 'selected',
    });
  });

  it('row 2: an id supplied, NOT stamped, chip non-order -> none/explicit-non-order-intent', () => {
    for (const intent of ['other', 'damage-loss'] as const) {
      expect(classifyAdjust(adjust({ idSupplied: true, intent }))).toEqual({
        outcome: 'none',
        reason: 'explicit-non-order-intent',
      });
    }
  });

  // Reconciliation Part 2 (pack CB3a-i.3): the adjust route resolves a TYPED
  // order number under the `order` chip (no picked id), so the resolver's rows
  // sit BEFORE row 3 — otherwise every typed reference would land on
  // `order-intent-no-id`, a class that says nothing was named.
  it('row 3a: the resolver THREW -> declined/resolver-error (before row 3)', () => {
    expect(
      classifyAdjust(adjust({ intent: 'order', referenceTyped: true, resolver: { kind: 'threw' } })),
    ).toEqual({ outcome: 'declined', reason: 'resolver-error' });
  });

  it('row 3b: the resolver RESOLVED -> attributed/reference-resolved (before row 3)', () => {
    // NOT `selected`: `stamped` is the SELECTED stamp only, so a resolved
    // reference never reaches row 1.
    expect(
      classifyAdjust(adjust({ intent: 'order', referenceTyped: true, resolver: { kind: 'resolved' } })),
    ).toEqual({ outcome: 'attributed', evidence: 'reference-resolved' });
  });

  it('row 3c: the resolver DECLINED -> declined/<its own class> (before row 3)', () => {
    for (const outcome of ['unusable', 'unmatched', 'ambiguous', 'not-a-member'] as const) {
      expect(
        classifyAdjust(
          adjust({ intent: 'order', referenceTyped: true, resolver: { kind: 'declined', outcome } }),
        ),
      ).toEqual({ outcome: 'declined', reason: outcome });
    }
  });

  it('row 3: chip `order` with NO id -> none/order-intent-no-id', () => {
    expect(classifyAdjust(adjust({ intent: 'order' }))).toEqual({
      outcome: 'none',
      reason: 'order-intent-no-id',
    });
  });

  it('row 4: chip non-order with no id -> none/explicit-non-order-intent', () => {
    for (const intent of ['other', 'damage-loss'] as const) {
      expect(classifyAdjust(adjust({ intent }))).toEqual({
        outcome: 'none',
        reason: 'explicit-non-order-intent',
      });
    }
  });

  it('row 5: chip ABSENT, any id state -> none/no-order-context', () => {
    expect(classifyAdjust(adjust())).toEqual({ outcome: 'none', reason: 'no-order-context' });
    expect(classifyAdjust(adjust({ idSupplied: true }))).toEqual({
      outcome: 'none',
      reason: 'no-order-context',
    });
  });
});
