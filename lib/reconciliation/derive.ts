/**
 * THE HISTORICAL DERIVATION (reconciliation lane, spec REV-7 §2.4; pack C2a.2).
 *
 * Recording started when R-A deployed. Everything the warehouse did BEFORE that
 * — years of it — has no attempt row, and the honest options were: show those
 * batches as a blank, write a one-time reconstruction job, or compute a class at
 * READ time from the evidence the ledger and the audit log already carry. This
 * lane took the third (SETTLED 2 / OCr-3): a written reconstruction would need a
 * cutoff, an idempotency story, a rollback story and a deploy step, and it would
 * be STALE the moment the rules improved. A pure function has none of that, and
 * it can be pinned exhaustively.
 *
 * TOTAL BY CONSTRUCTION. Every population batch without an attempt row gets a
 * LABELLED class — there is no `unrecorded` outcome and no null return. R7 is
 * the terminal rule and it says "unknown", which is a fact about the evidence,
 * not a hole in the report.
 *
 * WHAT IT IS NOT. This function never claims a batch was attributed by a path
 * that recorded nothing: R3's evidence is literally `derived` and its sentence
 * says so. And a batch that happened AFTER recording started but still has no
 * attempt row is annotated `post-lane gap` — the one thing it must never be
 * called is "before the lane", because that would be a false statement about
 * when it happened rather than an admission that a writer missed it.
 *
 * Pure: no Prisma, no clock, no I/O. Types are local or from the attribution
 * contracts module (never `attempts.ts` — pack R-4/CX-3).
 */

import type { AttemptEvidence, AttemptOutcome } from '@/lib/attribution/contracts';

/** Which rule fired. Rides in the payload; the CHIP carries the sentence. */
export type DerivedRuleId = 'R1' | 'R1b' | 'R2' | 'R2b' | 'R3a' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7';

/**
 * The derived class. `evidence` widens the writer's vocabulary by exactly one
 * value — `derived`, which no writer may ever claim (contracts.ts) and which
 * means "stamped, and nothing recorded by what".
 */
export type DerivedClass = {
  outcome: AttemptOutcome;
  evidence?: AttemptEvidence | 'derived';
  reason?: string;
  ruleId: DerivedRuleId;
  /** R2b only: the fulfillment happened, the ledger rows were never stamped. */
  ledgerUnstamped?: true;
  /** Recording was live when this batch ran, and it still has no attempt row. */
  postLaneGap?: true;
  sentence: string;
};

/**
 * The reduced ledger fact the rules need: WHICH order ids the batch's population
 * rows carry (distinct, `null` included — an unstamped row is a fact) and WHEN
 * the batch happened (MIN(changeTime), the lane's time axis).
 */
export type DeriveBatch = {
  batchId: string;
  stamps: ReadonlyArray<string | null>;
  at: Date;
};

/** An `audit_logs` row whose `batchId` equals the LEDGER batchId. */
export type DeriveAuditEvent = {
  id: number;
  actionType: string;
  entityId: string | null;
  details: Record<string, unknown> | null;
};

/**
 * One sentence per rule, in English. The chip renders THIS; `ruleId` stays in
 * the payload for the drill-down and the tool (OCr2-14 — nobody should have to
 * learn what "R2b" means to read a report).
 */
export const DERIVED_SENTENCES: Readonly<Record<DerivedRuleId, string>> = Object.freeze({
  R1: 'the deduction recorded which evidence stamped it',
  R1b: 'an adjustment the operator marked as an order',
  R2: 'fulfilled against the order the ledger names',
  R2b: 'fulfillment (inferred — the ledger was never stamped)',
  R3a: 'the packer picked this order (recorded in the audit event, not on the ledger row)',
  R3: 'stamped by an unrecorded path',
  R4: 'the operator said this was not an order',
  R5: 'a reference was typed and nothing recorded whether it matched',
  R6: 'the operator said order, but no order was identified',
  R7: 'unknown — before recording began',
});

/**
 * The replacement for the ONE sentence that would otherwise claim a post-lane
 * batch predates the lane (spec §2.2: "never 'before the lane'"). The static
 * table above keeps the pre-lane wording the pack pins; this is what a batch
 * at-or-after `recordingSince` says instead.
 */
const POST_LANE_SENTENCES: Partial<Record<DerivedRuleId, string>> = Object.freeze({
  R7: 'unknown — recording was live and this batch has no attempt row',
});

/** The closed evidence vocabulary a recorded `orderAttributionSource` may name. */
const RECORDED_SOURCES: ReadonlySet<string> = new Set(['selected', 'reference-resolved']);

const FULFILLMENT_ACTION_TYPES: ReadonlySet<string> = new Set([
  'EXTERNAL_ORDER_FULFILLMENT',
  'EXTERNAL_ORDER_PARTIAL_FULFILLMENT',
]);

/** A non-empty string, or nothing. The writers omit keys they cannot fill. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * "The audit event" of a ledger batch = the EARLIEST row by id — the deduction's
 * OWN event (G1p-8). Manual-attribution events carry a freshly minted batchId
 * and never enter this set at all, but the rule is stated in terms of id order
 * so that no later event of any kind can re-classify a deduction.
 */
function earliestById(auditEvents: ReadonlyArray<DeriveAuditEvent>): DeriveAuditEvent | null {
  return auditEvents.reduce<DeriveAuditEvent | null>(
    (earliest, e) => (earliest === null || e.id < earliest.id ? e : earliest),
    null
  );
}

/**
 * Derive the class of a population batch that has no attempt row.
 *
 * Rules R1..R7 in spec §2.4 order, FIRST MATCH WINS. Two orderings carry
 * meaning: R1/R1b/R2 (what was recorded) before R3a/R3 (what can be inferred),
 * and R4 before R5 — the workbench "Other" tap sends a typed reference along
 * with the chip, so an operator who said "not an order" must not be counted as a
 * decline nobody recorded.
 */
export function deriveHistoricalAttempt(
  batch: DeriveBatch,
  auditEvents: ReadonlyArray<DeriveAuditEvent>,
  opts: { recordingSince: Date | null }
): DerivedClass {
  const event = earliestById(auditEvents);
  const details = event?.details ?? {};

  const stampedIds = batch.stamps.filter((s): s is string => s !== null);
  const stamped = stampedIds.length > 0;
  // The single id the batch carries, when it carries exactly one. A MIXED batch
  // has no "the stamp" to compare against — it is reported by its own tripwire
  // (spec §2.2) and never matched against one of its ids.
  const uniqueStamps = new Set(stampedIds);
  const theStamp = uniqueStamps.size === 1 ? stampedIds[0] : null;

  const source = text(details.orderAttributionSource);
  const intent = text(details.intent);
  const isFulfillment = event !== null && FULFILLMENT_ACTION_TYPES.has(event.actionType);
  const fulfilledOrderId = isFulfillment
    ? (text(details.orderId) ?? text(event?.entityId))
    : undefined;

  const annotate = (klass: Omit<DerivedClass, 'sentence'>): DerivedClass => {
    const postLaneGap = opts.recordingSince !== null && batch.at >= opts.recordingSince;
    const sentence =
      (postLaneGap ? POST_LANE_SENTENCES[klass.ruleId] : undefined) ??
      DERIVED_SENTENCES[klass.ruleId];
    return { ...klass, ...(postLaneGap ? { postLaneGap: true as const } : {}), sentence };
  };

  // R1 — the deduction recorded WHICH evidence stamped it. An unrecognised
  // token is not evidence: the vocabulary is closed, and a stamp whose source we
  // cannot read is R3's "unrecorded path", not a confidence level we invented.
  if (stamped && source !== undefined && RECORDED_SOURCES.has(source)) {
    return annotate({ outcome: 'attributed', evidence: source as AttemptEvidence, ruleId: 'R1' });
  }

  // R1b — a stamped adjust whose operator tapped the "order" chip. Before the
  // attempt record existed, that chip plus a stamp IS the selection.
  if (stamped && event?.actionType === 'INVENTORY_ADJUSTMENT' && intent === 'order') {
    return annotate({ outcome: 'attributed', evidence: 'selected', ruleId: 'R1b' });
  }

  // R2 / R2b — fulfillment, keyed on the STAMP rather than on the event.
  if (isFulfillment && stamped) {
    return annotate({ outcome: 'attributed', evidence: 'fulfillment', ruleId: 'R2' });
  }
  if (isFulfillment && !stamped && fulfilledOrderId !== undefined) {
    // The sale happened against a known order and the ledger never recorded it:
    // a repairable defect (D4 stamp completion), disclosed as its own figure.
    return annotate({
      outcome: 'attributed',
      evidence: 'fulfillment',
      ruleId: 'R2b',
      ledgerUnstamped: true,
    });
  }

  // R3a — the 0b-2 selected path: the audit event accrued the id the ledger was
  // later stamped with, and only the ledger write was recorded at the time.
  if (stamped && theStamp !== null && text(details.selectedExternalOrderId) === theStamp) {
    return annotate({ outcome: 'attributed', evidence: 'selected', ruleId: 'R3a' });
  }

  // R3 — stamped, and nothing says by what. Said out loud rather than dressed up
  // as one of the evidence classes above.
  if (stamped) {
    return annotate({ outcome: 'attributed', evidence: 'derived', ruleId: 'R3' });
  }

  // R4 BEFORE R5 — an operator's own statement outranks the reference the same
  // tap sent along with it.
  if (intent !== undefined && intent !== 'order') {
    return annotate({ outcome: 'none', reason: 'explicit-non-order-intent', ruleId: 'R4' });
  }

  // R5 — a number was typed and nothing recorded what became of it. `declined`
  // with reason `unknown`: the decline classes only exist from R-A onward, and
  // inventing one here would be reporting a match attempt nobody made.
  if (text(details.orderReference) !== undefined) {
    return annotate({ outcome: 'declined', reason: 'unknown', ruleId: 'R5' });
  }

  // R6 — the chip said order and there is nothing to stamp.
  if (intent === 'order') {
    return annotate({ outcome: 'none', reason: 'order-intent-no-id', ruleId: 'R6' });
  }

  // R7 — terminal. Nothing in the ledger or the audit event points anywhere.
  return annotate({ outcome: 'none', reason: 'unknown', ruleId: 'R7' });
}
