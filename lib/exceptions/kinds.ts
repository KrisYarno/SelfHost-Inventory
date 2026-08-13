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
 * REQUIRED subject payloads per kind (pack REV-3 T1). The VALUES ride along, not
 * only the ids, so a tolerance chosen at the checkpoint applies RETROACTIVELY to
 * rows already on the register — you can ask "was this ever outside 2%?" of a
 * row raised months ago without re-reading the staging line it came from.
 *
 * Optional ids are carried as explicit `null` rather than omitted: a reader must
 * be able to tell "no shipment" from "this row predates the field".
 */
export type RecvDiscrepancySubject = {
  stagingItemId: number;
  shipmentId: string | null;
  productId: number | null;
  /** NULL for an unexpected arrival — never a fabricated 0 (the delta rule COALESCEs, the record does not). */
  expectedQty: number | null;
  countedQty: number;
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
