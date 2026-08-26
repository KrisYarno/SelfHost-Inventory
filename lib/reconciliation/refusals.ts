/**
 * STRUCTURED REFUSALS for the manual-attribution core (pack C2b.1; spec REV-7
 * D4 / §5).
 *
 * `apiHandler` renders an `AppError` as `{ error, code }` and nothing else, and
 * seven of D4's nine refusals have to NAME something the admin then acts on:
 * which ids the batch actually carries, how many rows it holds, who stamped it
 * while the page was open, which order a fulfillment already named. "Conflict"
 * would send an admin back to the report to guess; "now ord-1 — refresh and try
 * again" tells them exactly what happened and what to do next.
 *
 * So the CORE throws these, the ROUTE catches them after the retry wrapper, and
 * the frozen 409 envelope is assembled from their fields:
 *
 *   NOT_ATTRIBUTABLE   `{ error, code, batchId }`
 *   TOO_MANY_ROWS      `{ error, code, rowCount, productCount, limit }`
 *   MIXED_STAMPS       `{ error, code, orderRecordIds }`
 *   BATCH_MOVED        `{ error, code, currentOrderRecordId, expected }`
 *   PARTIALLY_STAMPED  `{ error, code, stamped, unstamped }`
 *   FULFILLED_BATCH    `{ error, code, orderRecordId, orderNumber }`
 *   R2B_OTHER_TARGET   `{ error, code, fulfillmentOrderRecordId }`
 *
 * The two that name nothing beyond their sentence stay `AppError` and travel
 * through `apiHandler` untouched: `ReasonRequired` (400) and `CountMismatch`
 * (409 CONFLICT).
 *
 * Next-free and Prisma-free (the `lib/supply-orders/refusals.ts` idiom): the
 * core is TX-SCOPED, and these ride out of it into route code that has no
 * business importing anything else.
 */

import { AppError } from '@/lib/error-handling';

/** The manual-attribution row ceiling. One number, named in the message. */
export const MANUAL_ATTRIBUTION_ROW_LIMIT = 50;

/**
 * The batch is not something this report speaks about: a transfer, a count, a
 * correction, a positive adjust — or a pre-0b-1 mass-update session (R0), whose
 * ADJUSTMENT rows satisfy the row predicate but were never a deduction anybody
 * could attribute to an order.
 */
export class NotAttributableRefusal extends Error {
  readonly code = 'NOT_ATTRIBUTABLE';

  constructor(public readonly batchId: string) {
    super(
      'This batch is not an attributable outbound batch (transfer, count, correction, positive adjust or a pre-lane mass update)',
    );
    this.name = 'NotAttributableRefusal';
  }
}

/**
 * Above the bound. The limit exists because the write is ONE guarded statement
 * inside a transaction that holds next-key locks on the batch's rows — and
 * because an attribution nobody can eyeball before confirming is not a manual
 * correction, it is a bulk update wearing one.
 */
export class TooManyRowsRefusal extends Error {
  readonly code = 'TOO_MANY_ROWS';

  constructor(
    public readonly rowCount: number,
    public readonly productCount: number,
    public readonly limit: number = MANUAL_ATTRIBUTION_ROW_LIMIT,
  ) {
    super(
      `This batch has ${rowCount} outbound rows across ${productCount} products — above the ${limit}-row manual attribution limit`,
    );
    this.name = 'TooManyRowsRefusal';
  }
}

/**
 * The batch's rows disagree about which order they belong to. The ids ride along
 * because the honest answer is to show them: picking one would be averaging a
 * disagreement, and the ledger is what needs repairing, not this report.
 */
export class MixedStampsRefusal extends Error {
  readonly code = 'MIXED_STAMPS';

  constructor(public readonly orderRecordIds: string[]) {
    super(
      `This batch's rows carry different order ids (${orderRecordIds.length}) — reported, never averaged; repair the ledger first`,
    );
    this.name = 'MixedStampsRefusal';
  }
}

/**
 * The stale-client guard (spec D4, OCp-8). The client stated what it saw; the
 * locked rows say otherwise, so somebody attributed this batch in between. Both
 * ids ride out: the current one is what the page must refresh to, and `expected`
 * is what the operator was looking at when they decided.
 *
 * Evaluated BEFORE the same-id and reason rules, so the loser of a race is never
 * asked for a reason for a change it never saw.
 */
export class BatchMovedRefusal extends Error {
  readonly code = 'BATCH_MOVED';

  constructor(
    public readonly currentOrderRecordId: string | null,
    public readonly expected: string | null,
  ) {
    super(
      `Someone attributed this batch while you were looking (now ${currentOrderRecordId ?? 'unattributed'}) — refresh and try again`,
    );
    this.name = 'BatchMovedRefusal';
  }
}

/**
 * The batch was attributed BY a fulfillment, and the ledger carries that stamp.
 * Re-stamping it here would desync `fulfilledQty` and the status already pushed
 * to the store — the order-side flows own that change, so the refusal names them
 * rather than pretending this surface could do it safely.
 *
 * `orderNumber` is `null` from the core (which never reads `external_orders`);
 * the field exists so the route or a later caller can fill in the human number.
 */
export class FulfilledBatchRefusal extends Error {
  readonly code = 'FULFILLED_BATCH';

  constructor(
    public readonly orderRecordId: string,
    public readonly orderNumber: string | null,
  ) {
    super(
      `Fulfilled against #${orderNumber ?? orderRecordId} — change it via unfulfill/refulfill, not here`,
    );
    this.name = 'FulfilledBatchRefusal';
  }
}

/**
 * An R2b batch (fulfillment-derived, ledger UNSTAMPED — SETTLED 11) may be
 * completed, never redirected: the only manual attribution it accepts is the
 * order its own fulfillment event already names. Anything else would invent a
 * second answer to a question the fulfillment already answered.
 */
export class R2bOtherTargetRefusal extends Error {
  readonly code = 'R2B_OTHER_TARGET';

  constructor(public readonly fulfillmentOrderRecordId: string | null) {
    super(
      `This batch was fulfilled against another order (${fulfillmentOrderRecordId}); a manual attribution may only complete that stamp`,
    );
    this.name = 'R2bOtherTargetRefusal';
  }
}

/**
 * ONE id on some rows, none on the others (OC-6). The guarded write names the id
 * it locked, so the statement that would move the stamped half leaves the
 * unstamped half behind — and a batch attributed halfway is worse than one not
 * attributed at all.
 *
 * It used to fall through to `CountMismatch`, whose sentence ("the batch moved")
 * describes a RACE: an admin read it as "somebody beat me to it", refreshed, and
 * found the same batch waiting. Both figures ride out so the repair is stated
 * rather than hunted for.
 */
export class PartiallyStampedRefusal extends Error {
  readonly code = 'PARTIALLY_STAMPED';

  constructor(
    public readonly stamped: number,
    public readonly unstamped: number,
  ) {
    super(
      `This batch is only partly stamped (${stamped} of ${stamped + unstamped} rows) — repair the ledger before attributing; a guarded update cannot move it uniformly`,
    );
    this.name = 'PartiallyStampedRefusal';
  }
}

/**
 * Moving a batch off an existing stamp is a CORRECTION of somebody's earlier
 * decision, so it is recorded with its reason or not at all (400 — the client
 * can fix it by asking the operator, unlike the 409s above).
 */
export class ReasonRequired extends AppError {
  constructor() {
    super('Re-attributing a stamped batch needs a reason', 'REASON_REQUIRED', 400);
  }
}

/**
 * The guarded write moved fewer rows than it locked. Under the row lock this
 * should be unreachable; it is kept because the alternative to checking is
 * committing a PARTIAL attribution, and a batch half-stamped is worse than one
 * not stamped at all.
 *
 * It also catches the partially-stamped batch (some rows carrying the stamp,
 * some null): the guard names the old id, so the null rows are not swept along.
 */
export class CountMismatch extends AppError {
  constructor(
    public readonly count: number,
    public readonly expected: number,
  ) {
    super(`the batch moved (updated ${count} of ${expected} rows)`, 'CONFLICT', 409);
  }
}

/** Every refusal the ROUTE renders as a structured 409 envelope. */
export type AttributionRefusal =
  | NotAttributableRefusal
  | TooManyRowsRefusal
  | MixedStampsRefusal
  | BatchMovedRefusal
  | PartiallyStampedRefusal
  | FulfilledBatchRefusal
  | R2bOtherTargetRefusal;
