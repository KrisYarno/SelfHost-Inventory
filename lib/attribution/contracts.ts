/**
 * THE CLOSED VOCABULARY of an attribution attempt (reconciliation lane, spec
 * REV-7 §2.1 / D1-D2; pack C1b.1).
 *
 * TYPES ONLY. No Prisma import, no runtime code, no dependency of any kind —
 * and that emptiness is the point (CX-3). Two surfaces need these words:
 *
 *   the WRITE path   `lib/attribution/attempts.ts`, which inserts the rows and
 *                    is therefore importable ONLY by the four route writers
 *                    (a static boundary gate, see
 *                    __tests__/integration/attempts-write-boundary.test.ts);
 *   the READ path    `lib/reconciliation/*`, which classifies and reports them
 *                    and is reachable from the assistant's tool surface, where
 *                    the zero-business-writes invariant forbids so much as a
 *                    Prisma write-method TOKEN appearing in the module graph.
 *
 * If the read path had to import the writer for its types, those two rules
 * would be in direct contradiction. It imports THIS instead; the writer
 * re-exports these names so a route needs one import, not two.
 */

/** Did the batch end up attributed, refused, or with nothing to attribute? */
export type AttemptOutcome = 'attributed' | 'declined' | 'none';

/**
 * WHICH evidence attributed it. A stamped row alone cannot say whether an
 * operator picked the order, a number they typed resolved to it, a fulfillment
 * moved it, or an admin said so afterwards — and those do not carry the same
 * confidence. (`derived` is deliberately NOT here: it is computed at READ time
 * for batches that have no attempt row, and no writer may claim it.)
 */
export type AttemptEvidence = 'fulfillment' | 'selected' | 'reference-resolved' | 'manual';

/** Why an attribution was REFUSED: something was offered and did not hold up. */
export type DeclineReason =
  | 'unusable'
  | 'unmatched'
  | 'ambiguous'
  | 'not-a-member'
  | 'resolver-error';

/**
 * Why there was NOTHING to attribute. Distinct from a decline on purpose: "the
 * packer typed nothing" and "the packer typed something that matched nothing"
 * are different facts about the warehouse, and a report that merges them is
 * reporting a number nobody can act on.
 */
export type NoneReason =
  | 'no-reference-typed'
  | 'explicit-non-order-intent'
  | 'order-intent-no-id'
  | 'no-order-context';

/** WHICH seam wrote the row. One value per writer; `manual` is D4's POST route. */
export type AttemptSource =
  | 'live-deduct'
  | 'live-adjust'
  | 'live-batch-adjust'
  | 'fulfillment'
  | 'manual';

/**
 * CLOSED. Built by EXPLICIT PICK inside recordAttributionAttempt — never a
 * spread of the caller's object, so a key nobody declared here cannot reach the
 * JSON column (and with it the drill-down, the export, and any later census).
 * Never the typed reference, never a customer field.
 */
export type AttemptDetails = {
  intent?: 'order' | 'damage-loss' | 'other';
  overwriteReason?: string;
  rowCount?: number;
  completedFulfillment?: boolean;
};

/**
 * The three legal (outcome, evidence, reason) shapes, as a discriminated union:
 * an `attributed` row carries evidence and no reason, the other two carry a
 * reason and no evidence. The classifiers return this; the writer spreads it
 * into the row. The impossible combinations are impossible to type.
 */
export type AttemptClass =
  | { outcome: 'attributed'; evidence: AttemptEvidence; reason?: undefined }
  | { outcome: 'declined'; reason: DeclineReason; evidence?: undefined }
  | { outcome: 'none'; reason: NoneReason; evidence?: undefined };
