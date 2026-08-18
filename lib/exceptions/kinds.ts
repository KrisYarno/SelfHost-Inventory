/**
 * The inventory-exception VOCABULARY (contract pack REV-3 T1, EXCEPTIONS block).
 *
 * Deliberately separate from `lib/exceptions/write.ts`: the kind names and key
 * encodings are needed by READ surfaces too (W3's filtered lists, the admin
 * recompute screen), and the write boundary says a read surface must never even
 * be able to reach a writer. Splitting the vocabulary out is what lets a GET
 * name a kind without importing anything that can write one — the boundary gate
 * (`__tests__/integration/exceptions-write-boundary.test.ts`) enforces exactly
 * that asymmetry.
 *
 * Nothing here touches Prisma or Next: pure strings and pure functions.
 */

/**
 * The CLOSED kind vocabulary. W1 writes the first three; W3 adds the last three
 * and NO schema (severity is DERIVED from kind at read time — deliberately no
 * column, so a re-prioritisation at the checkpoint is a code change, not a
 * migration and not a backfill).
 */
export const EXCEPTION_KINDS = [
  'recv-discrepancy',
  'pending-with-stock',
  'cost-differs',
  'unattributed-outstock',
  'unmapped-lines',
  'gap-order',
  // Receiving/Labeling overhaul (spec §6): units that never made it out of the
  // labeling bench — damaged, mislabelled, written off. APPENDED, so no stored
  // kind string changes meaning. Its own row rather than a field on the receiving
  // discrepancy, because a supplier shortage and a bench loss are settled by
  // different people against different counterparties.
  'labeling-loss',
] as const;

export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

/**
 * The subset any W1 code path may raise. The W3 kinds are declared NOW (the
 * vocabulary is closed and bound at W1-1) but nothing writes them yet.
 */
export const W1_EXCEPTION_KINDS = [
  'recv-discrepancy',
  'pending-with-stock',
  'cost-differs',
] as const satisfies readonly ExceptionKind[];

/** `inventory_exceptions.kind` is VarChar(32) — every member must fit. */
export const EXCEPTION_KIND_MAX_LENGTH = 32;

/**
 * Canonical key encoding: `<kind>:<subject id>`.
 *
 * The grains are bounded (a staging line, a product), so no hash is needed and
 * the key stays READABLE — which matters, because the key is what a human sees
 * in the reconciliation surface and what a support question is asked about.
 */
export function exceptionKey(kind: ExceptionKind, subjectId: string | number): string {
  return `${kind}:${subjectId}`;
}

/** One receiving discrepancy per STAGING LINE (the grain a recount settles). */
export function recvDiscrepancyKey(stagingItemId: number): string {
  return exceptionKey('recv-discrepancy', stagingItemId);
}

/** One per PRODUCT: stock arrived for something still awaiting approval. */
export function pendingWithStockKey(productId: number): string {
  return exceptionKey('pending-with-stock', productId);
}

/** One per STAGING LINE: the receipt cost disagreed with the product's cost. */
export function costDiffersKey(stagingItemId: number): string {
  return exceptionKey('cost-differs', stagingItemId);
}

/**
 * One per SUPPLY-ORDER LINE: units discarded at the labeling bench. The row is
 * CUMULATIVE — a second discard on the same line updates this key rather than
 * raising a second row, so "how much did this line lose" has one answer.
 */
export function labelingLossKey(stagingItemId: number): string {
  return exceptionKey('labeling-loss', stagingItemId);
}

/**
 * Severity for the ONE kind this lane adds (contract pack PK-6).
 *
 * Deliberately a single constant and NOT a `Record<ExceptionKind, Severity>`:
 * no exhaustive severity map exists in the code today (severity is derived from
 * kind at read time), and the six W3 priorities are not frozen. Inventing the
 * other values here would freeze a reconciliation-lane decision at a checkpoint
 * that has not happened. That lane defines the full map when it builds the
 * register.
 *
 * MEDIUM because a bench loss is real money already spent, but — unlike a
 * supplier shortage — there is no counterparty to chase and nothing arrives
 * later: it is a write-off to account for, not an escalation.
 */
export const LABELING_LOSS_SEVERITY = 'medium' as const;

/**
 * The CLOSED follow-up vocabulary (spec §6 / D5). Stored in the NEW column
 * `inventory_exceptions.resolution` — a CLASSIFICATION of how a discrepancy was
 * settled, separate from `resolvedAt/resolvedBy` (the settlement instant), which
 * is why re-labelling one leaves those two alone.
 *
 * `reshipped` / `supplier-credited` carry `relatedShipmentId` / `creditRef` in
 * the subject; `recount-corrected` and `additional-delivery` are what verify
 * itself writes when a later count closes an open discrepancy.
 */
export const RESOLUTIONS = [
  'supplier-credited',
  'reshipped',
  'accepted-loss',
  'recount-corrected',
  'surplus-kept',
  'surplus-returned',
  'additional-delivery',
] as const;

export type Resolution = (typeof RESOLUTIONS)[number];

/**
 * REQUIRED subject payloads per kind (pack REV-3 T1). The VALUES ride along, not
 * only the ids, so a tolerance chosen at the checkpoint applies RETROACTIVELY to
 * rows already on the register — you can ask "was this ever outside 2%?" of a
 * row raised months ago without re-reading the staging line it came from.
 *
 * Optional ids are carried as explicit `null` rather than omitted: a reader must
 * be able to tell "no shipment" from "this row predates the field".
 */
/**
 * Receiving/Labeling overhaul (spec §6): a SUPERSET of the W1 shape. The five
 * original fields stay REQUIRED so every W1 reader keeps working verbatim, and
 * everything the overhaul adds is OPTIONAL so a row raised before this lane
 * still satisfies the type — a reader must be able to tell "this row predates
 * the field" from "this field is genuinely absent".
 *
 * `productId` is the RESOLVED (delivered) product; `orderedProductId` is what
 * was ordered, so a substitution stays legible after the fact.
 */
export type RecvDiscrepancySubject = {
  stagingItemId: number;
  shipmentId: string | null;
  productId: number | null;
  /** NULL for an unexpected arrival — never a fabricated 0 (the delta rule COALESCEs, the record does not). */
  expectedQty: number | null;
  countedQty: number;
  orderedProductId?: number | null;
  orderedQuantity?: number | null;
  verifiedQuantity?: number | null;
  shortUnits?: number;
  overUnits?: number;
  unitCostCents?: number | null;
  lossCents?: number;
  surplusValueCents?: number;
  note?: string | null;
  /** `reshipped`: the supply order the replacement units arrived on. */
  relatedShipmentId?: string | null;
  /** `supplier-credited`: the supplier's credit-note reference. */
  creditRef?: string | null;
};

/**
 * The labeling-loss subject, at the LINE grain and CUMULATIVE (spec §6):
 * `units` is `disposedQuantity` AFTER the discard, `lossCents` the exact
 * cumulative money those units carried, `reason` the LATEST one given.
 *
 * The money rides along for the same reason the W1 subjects carry values: the
 * register must be able to answer "how much has the bench lost" from the rows
 * themselves, without re-reading a line that may since have moved.
 */
export type LabelingLossSubject = {
  stagingItemId: number;
  shipmentId: string | null;
  productId: number | null;
  units: number;
  unitCostCents: number | null;
  lossCents: number;
  reason: string;
};

export type PendingWithStockSubject = {
  productId: number;
  stagingItemId: number;
  units: number;
};

export type CostDiffersSubject = {
  productId: number;
  stagingItemId: number;
  currentCents: number | null;
  receiptCents: number;
};
