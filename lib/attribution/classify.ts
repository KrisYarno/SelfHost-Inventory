/**
 * THE D2 CONDITION TABLE, executable (reconciliation lane, spec REV-7 D2; pack
 * C1b.2).
 *
 * Two writers have a decision to make — the workbench's manual deduction and
 * the adjust surface — and both decisions are made from ROUTE LOCALS that
 * already exist. Putting the tables here rather than inline buys one thing: each
 * row becomes a unit pin, so the route suites only have to prove the route feeds
 * the right locals and writes the exact row, not re-litigate the whole table
 * through a mocked HTTP request.
 *
 * TOTAL and ORDERED. First match wins, top to bottom, and two of the orderings
 * carry the truthfulness of the whole report:
 *
 *   * `!referenceTyped` is checked BEFORE the resolver's `unusable`. A packer
 *     who typed nothing did not produce an unusable reference; recording a
 *     decline there would count an event that never happened.
 *   * a SUPPLIED id with an ABSENT chip records `no-order-context`, not
 *     `explicit-non-order-intent`. `mapDeductionIntent(undefined)` defaults to
 *     `other` for the LEDGER's benefit, but an untapped chip is not an
 *     operator's statement — and the attempt record says what happened, not
 *     what the ledger had to assume.
 *
 * Pure: no React, no Next, no Prisma.
 */

import type { AttemptClass } from '@/lib/attribution/contracts';

/** The deduct-simple route's own locals, named as that route names them. */
export type DeductSimpleLocals = {
  /** `orderRecordId !== null && selectedStamp !== null` — the SELECTED stamp. */
  stamped: boolean;
  /** `body.selectedExternalOrderId !== undefined` (post-zod, '' is already refused). */
  idSupplied: boolean;
  /** `body.intent` — validated by the schema, absent when the chip was skipped. */
  intent: 'order' | 'damage-loss' | 'other' | undefined;
  /** `(body.orderReference ?? '').trim().length > 0`. */
  referenceTyped: boolean;
  /** What the reference-resolution round did, if it ran at all. */
  resolver:
    | { kind: 'skipped' }
    | { kind: 'threw' }
    | { kind: 'resolved' }
    | { kind: 'declined'; outcome: 'unusable' | 'unmatched' | 'ambiguous' | 'not-a-member' };
};

export type AdjustLocals = {
  /** `orderRecordId !== null` — id validated AND `intent === 'order'`. */
  stamped: boolean;
  idSupplied: boolean;
  intent: 'order' | 'damage-loss' | 'other' | undefined;
};

/** D2's deduct-simple table: 8 rows, evaluated in this order. */
export function classifyDeductSimple(l: DeductSimpleLocals): AttemptClass {
  // 1. The ledger was stamped from the selection.
  if (l.stamped) return { outcome: 'attributed', evidence: 'selected' };

  // 2. An id was supplied but not stamped, and the operator said non-order (the
  //    workbench "Other" tap sends both). The resolver is skipped whenever an id
  //    is supplied, so there is no decline to record.
  if (l.idSupplied && (l.intent === 'other' || l.intent === 'damage-loss')) {
    return { outcome: 'none', reason: 'explicit-non-order-intent' };
  }

  // 3. An id was supplied but not stamped and the chip was never tapped. An id
  //    with `intent='order'` is always stamped, so it never reaches here.
  if (l.idSupplied && l.intent === undefined) {
    return { outcome: 'none', reason: 'no-order-context' };
  }

  // 4. A stated non-order intent, with no id in play.
  if (l.intent === 'other' || l.intent === 'damage-loss') {
    return { outcome: 'none', reason: 'explicit-non-order-intent' };
  }

  // 5. Nothing was typed — BEFORE the resolver's `unusable` (see the header).
  if (!l.referenceTyped) return { outcome: 'none', reason: 'no-reference-typed' };

  // 6. The lookup's infrastructure failed. The route swallows that so the
  //    deduction still commits; this row is where the swallow becomes visible.
  if (l.resolver.kind === 'threw') return { outcome: 'declined', reason: 'resolver-error' };

  // 7. The typed number named exactly one order (candidateCount is 1 by
  //    construction, so it is not recorded).
  if (l.resolver.kind === 'resolved') {
    return { outcome: 'attributed', evidence: 'reference-resolved' };
  }

  // 8. A named decline, carried through verbatim.
  if (l.resolver.kind === 'declined') return { outcome: 'declined', reason: l.resolver.outcome };

  // A SKIPPED resolver cannot reach here: rows 2/3/4 consume every skip. If a
  // route change ever skips it for a NEW reason, this throw is what catches it —
  // the alternative is an attempt row asserting a class nobody computed.
  throw new Error('classifyDeductSimple: unreachable');
}

/**
 * D2's adjust table: 5 rows, total. The ROUTE decides whether to call at all —
 * one attempt row iff `body.delta < 0 && !autoAddForTransfer`, because a
 * positive adjust and a transfer auto-add move nothing out and have nothing to
 * attribute.
 */
export function classifyAdjust(l: AdjustLocals): AttemptClass {
  // 1. The ledger was stamped (id validated AND `intent='order'`).
  if (l.stamped) return { outcome: 'attributed', evidence: 'selected' };

  // 2. An id supplied but not stamped, with a stated non-order intent. (An id
  //    with `intent='order'` is always stamped: resolveSelectedExternalOrderId
  //    throws 400 before the transaction on an inaccessible id.)
  if (l.idSupplied && (l.intent === 'other' || l.intent === 'damage-loss')) {
    return { outcome: 'none', reason: 'explicit-non-order-intent' };
  }

  // 3. "This went out against an order" with no order named.
  if (l.intent === 'order' && !l.idSupplied) {
    return { outcome: 'none', reason: 'order-intent-no-id' };
  }

  // 4. A stated non-order intent, no id.
  if (l.intent === 'other' || l.intent === 'damage-loss') {
    return { outcome: 'none', reason: 'explicit-non-order-intent' };
  }

  // 5. The chip was never tapped, whatever the id state. This is also where the
  //    one unreachable shape would land (`order` + an id + no stamp, refused
  //    with a 400 before the transaction opens) — recording "no order context"
  //    for it is the truthful reading, so unlike deduct-simple there is nothing
  //    here worth throwing over.
  return { outcome: 'none', reason: 'no-order-context' };
}
