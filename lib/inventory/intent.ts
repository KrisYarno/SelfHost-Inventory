/**
 * lib/inventory/intent.ts — THE intent-chip mapping table (contract pack REV-11
 * T7 / design REV-2 "W2 — intent chip"), in one place.
 *
 * The chip asks an operator ONE question about a stock movement — what was this
 * for? — and turns the answer into ledger truth. Three values, chosen because
 * they are the three that do not collide (`recount` and `receiving` were cut:
 * count corrections belong to the count flow's logType, and receiving is not an
 * outstock intent):
 *
 *   | value       | reasonCode | orderRecordId          | surfaces               |
 *   |-------------|------------|------------------------|------------------------|
 *   | order       | none       | via the 0b-2 resolver  | adjust + workbench     |
 *   | damage-loss | DAMAGE     | none                   | ADJUST SURFACE ONLY    |
 *   | other       | none       | none                   | both; NEVER CORRECTION |
 *
 * TWO RULES IN THIS TABLE ARE LOAD-BEARING AND NEITHER IS OBVIOUS:
 *
 * `other` MUST NOT map to CORRECTION. "Unclassified" and "correction" look
 * interchangeable in English and are opposites in this ledger: the LOCKED
 * reorder-demand predicate is `delta < 0 AND logType != TRANSFER AND reasonCode
 * != 'CORRECTION'`, so stamping CORRECTION on an honest "I don't know" would
 * SILENTLY DELETE that depletion from the demand this business reorders against.
 * `other` therefore writes nothing at all — truthfully unclassified, which is
 * the same thing the row would have said before the chip existed.
 *
 * `damage-loss` is offered on the ADJUST surface ONLY ([ADJ] per PLG1-1). The
 * workbench's manual leg books SALE rows, and getShrinkageSummary narrows to
 * `logType IN (ADJUSTMENT, CORRECTION)` BEFORE any reason is classified — so a
 * SALE row carrying reasonCode DAMAGE would be a loss recorded in a place the
 * only loss-reporting surface never looks. Not offering the choice is more
 * honest than accepting it into a blind spot.
 *
 * Pure: no React, no Next, no Prisma. The ROUTES are where the mapping is
 * pinned (pack T7); this module exists so the two surfaces cannot each invent
 * their own version of the table, not to be the place the contract is proven.
 */

/** The chip's full vocabulary — every value any surface may offer. */
export const DEDUCTION_INTENTS = ["order", "damage-loss", "other"] as const;
export type DeductionIntent = (typeof DEDUCTION_INTENTS)[number];

/**
 * What the workbench's manual leg may offer: `damage-loss` is absent BY
 * CONTRACT, not by oversight (see PLG1-1 above). Both the component and the
 * request schema read this, so the surface and the wire agree by construction.
 */
export const WORKBENCH_INTENTS = ["order", "other"] as const;
export type WorkbenchIntent = (typeof WORKBENCH_INTENTS)[number];

/**
 * The DEFAULT when the operator skips the chip. The design's friction ceiling
 * is a SKIPPABLE one-tap that never blocks a submit, so the untapped state has
 * to mean something truthful — and "I did not say" is `other`, never a guess.
 */
export const DEFAULT_DEDUCTION_INTENT: DeductionIntent = "other";

/** What one chip value writes onto the movement it describes. */
export interface IntentMapping {
  /** The coded reason for the ledger row, or null when the value adds none. */
  reasonCode: "DAMAGE" | null;
  /** Whether a RESOLVED order id may be stamped into `orderRecordId`. */
  attributesOrder: boolean;
}

/** The table above, executable. */
export const INTENT_MAPPING: Readonly<Record<DeductionIntent, IntentMapping>> = {
  order: { reasonCode: null, attributesOrder: true },
  "damage-loss": { reasonCode: "DAMAGE", attributesOrder: false },
  other: { reasonCode: null, attributesOrder: false },
};

/**
 * Resolve a (possibly absent) chip value to its mapping. An absent chip is the
 * default, so callers never branch on undefined and never invent a third state.
 */
export function mapDeductionIntent(intent?: DeductionIntent | null): IntentMapping {
  return INTENT_MAPPING[intent ?? DEFAULT_DEDUCTION_INTENT];
}

/** Human-facing labels, shared so the two surfaces cannot word the same value differently. */
export const INTENT_LABEL: Readonly<Record<DeductionIntent, string>> = {
  order: "Order",
  "damage-loss": "Damage / loss",
  other: "Other",
};

/**
 * The one-line explanation each value gets under the chip. Deliberately says
 * what the system will DO, not what the word means — an operator tapping
 * "Other" should be able to see that nothing is being inferred on their behalf.
 */
export const INTENT_HINT: Readonly<Record<DeductionIntent, string>> = {
  order: "Went out against a customer order",
  "damage-loss": "Damaged, expired or otherwise lost — counts as shrinkage",
  other: "Not classified — recorded as-is",
};
