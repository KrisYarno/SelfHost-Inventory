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
 * Part 2's reverse and move (pack CB2a.3) add eight more, on the same terms —
 * every one of them names the numbers an operator then acts on:
 *
 *   ALREADY_REVERSED     `{ error, code, previouslyRestored, totalUnits }`
 *   ALREADY_MOVED        `{ error, code, physicalLocationId, at }`
 *   BATCH_RESTORED       `{ error, code, restoredUnits }`
 *   MULTI_LOCATION       `{ error, code, locationIds }`
 *   NULL_LOCATION_ROW    `{ error, code, rowId }`
 *   UNATTRIBUTED         `{ error, code }`                       403
 *   SAME_LOCATION        `{ error, code, locationId }`            400
 *   INSUFFICIENT_AT_SOURCE `{ error, code, productId, locationId, onBook, needed }`
 *
 * The two that name nothing beyond their sentence stay `AppError` and travel
 * through `apiHandler` untouched: `ReasonRequired` (400) and `CountMismatch`
 * (409 CONFLICT).
 *
 * The ENVELOPES themselves are assembled by the one mapper in
 * `refusal-response.ts` beside this file, which is the only Next-bound module in
 * this directory. It lives there and not here because this file is value-
 * imported by the report, and the report is bundled into the MCP sidecar, which
 * has no `next/*` to reach for.
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
 *
 * TWO SENTENCES, because the same bound now guards three acts (pack CB2a.3).
 * The reverse/move arm names the act it refused and the limit it read — never a
 * literal 50, and never the batch id, which the request path already names.
 */
export class TooManyRowsRefusal extends Error {
  readonly code = 'TOO_MANY_ROWS';

  constructor(
    public readonly rowCount: number,
    public readonly productCount: number,
    public readonly limit: number = MANUAL_ATTRIBUTION_ROW_LIMIT,
    action: 'attribution' | 'reverse' | 'move' = 'attribution',
  ) {
    super(
      action === 'attribution'
        ? `This batch has ${rowCount} outbound rows across ${productCount} products — above the ${limit}-row manual attribution limit`
        : `This batch has ${rowCount} rows across ${productCount} products — above the ${limit}-row limit for a ${action}`,
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
 *
 * `orderRecordId` is NULLABLE from Part 2 (pack CB2a.3): the reverse and the
 * move refuse a fulfilment-evidenced batch whether or not the ledger was ever
 * stamped, and "Fulfilled against #null" reads as an order called null. The null
 * arm says what actually happened and where the repair lives.
 */
export class FulfilledBatchRefusal extends Error {
  readonly code = 'FULFILLED_BATCH';

  constructor(
    public readonly orderRecordId: string | null,
    public readonly orderNumber: string | null,
  ) {
    super(
      orderRecordId === null
        ? 'This fulfilled batch names no order — repair via unfulfill/refulfill'
        : `Fulfilled against #${orderNumber ?? orderRecordId} — change it via unfulfill/refulfill, not here`,
    );
    this.name = 'FulfilledBatchRefusal';
  }
}

/**
 * An R2b batch (fulfillment-derived, ledger UNSTAMPED — SETTLED 11) may be
 * completed, never redirected: the only manual attribution it accepts is the
 * order its own fulfillment event already names. Anything else would invent a
 * second answer to a question the fulfillment already answered.
 *
 * TWO SENTENCES, because there are two situations (QA-7). When the event names
 * NO order, there is no id a completion could target and every order the picker
 * could offer lands here — so the refusal says what actually happened and where
 * the repair lives, rather than "fulfilled against another order (null)", which
 * reads as an order called null and sends the admin looking for it.
 */
export class R2bOtherTargetRefusal extends Error {
  readonly code = 'R2B_OTHER_TARGET';

  constructor(public readonly fulfillmentOrderRecordId: string | null) {
    super(
      fulfillmentOrderRecordId === null
        ? 'This batch was fulfilled but the event does not name the order — repair via unfulfill/refulfill'
        : `This batch was fulfilled against another order (${fulfillmentOrderRecordId}); a manual attribution may only complete that stamp`,
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

// ---------------------------------------------------------------------------
// PART 2 — the reverse, the move, and the restoration ledger's gates
// (pack CB2a.3; spec §2.5 / §2.6). Every sentence below is rendered to an
// OPERATOR verbatim, and every one of them names ids, numbers and location ids
// — never a customer, never a name.
// ---------------------------------------------------------------------------

/**
 * Nothing is owed on any key: this batch's units have already been put back by
 * an earlier correction or reverse. Both figures ride out because "already
 * reversed" without them reads as a refusal to try, rather than as the ledger
 * stating what it already did.
 */
export class AlreadyReversedRefusal extends Error {
  readonly code = 'ALREADY_REVERSED';

  constructor(
    public readonly previouslyRestored: number,
    public readonly totalUnits: number,
  ) {
    super(
      `This batch was already reversed — ${previouslyRestored} of ${totalUnits} units were put back`,
    );
    this.name = 'AlreadyReversedRefusal';
  }
}

/**
 * A prior MOVE relocated this batch's stock, so it is neither re-attributable
 * nor movable a second time: two moves are two disagreeing accounts of where the
 * units are. The timestamp is rendered to the minute in UTC — a raw ISO string
 * is not a sentence an operator reads.
 *
 * AND THE LOCATION IS NAMED (pack CB2.5e.2). "location 7" is a number the
 * operator then has to go and look up; the name is what they navigate by. ONE
 * template with a conditional segment, owned here rather than assembled by each
 * thrower, and the id ALWAYS rides along beside the name because the ledger and
 * the next request are keyed on it.
 *
 * `locationName` is NULLABLE and the null arm is the id-only sentence: the name
 * is read on the refusal path (`locationNameForRefusal`, `restorations.ts`) and
 * an admin can delete an unused location between the move and this refusal. A
 * missing row degrades the sentence, never spells "undefined".
 */
export class AlreadyMovedRefusal extends Error {
  readonly code = 'ALREADY_MOVED';

  constructor(
    public readonly physicalLocationId: number,
    public readonly at: string,
    public readonly locationName: string | null,
  ) {
    super(
      `This batch was moved to ${
        locationName === null ? `location ${physicalLocationId}` : `${locationName} (location ${physicalLocationId})`
      } on ${at.slice(0, 16).replace('T', ' ')} UTC — it can no longer be re-attributed or moved again`,
    );
    this.name = 'AlreadyMovedRefusal';
  }
}

/**
 * Units have already been restored for this batch, so neither a move nor a
 * re-attribution may proceed: the restoring rows carry their OWN batch id, and a
 * re-stamp would split one batch's truth across two order ids.
 */
export class BatchRestoredRefusal extends Error {
  readonly code = 'BATCH_RESTORED';

  constructor(public readonly restoredUnits: number) {
    super(
      `This batch has already been put back (${restoredUnits} units) — it can no longer be re-attributed or moved`,
    );
    this.name = 'BatchRestoredRefusal';
  }
}

/**
 * A move reclassifies ONE location's stock into another. A batch whose rows sit
 * at several locations has no single source to move from, and picking one would
 * be guessing which half of the ledger was wrong.
 */
export class MultiLocationRefusal extends Error {
  readonly code = 'MULTI_LOCATION';

  constructor(public readonly locationIds: number[]) {
    super(
      `This batch spans ${locationIds.length} locations (${locationIds.join(', ')}) and cannot be moved as one`,
    );
    this.name = 'MultiLocationRefusal';
  }
}

/**
 * `inventory_logs.locationId` is nullable, and both the write core and the
 * prelock take a NON-NULL location. A row that names none cannot be restored or
 * reclassified anywhere, so the batch is refused with the row to repair.
 */
export class NullLocationRowRefusal extends Error {
  readonly code = 'NULL_LOCATION_ROW';

  constructor(public readonly rowId: number) {
    super(
      `Ledger row ${rowId} names no location — this batch cannot be reversed or moved until it is repaired`,
    );
    this.name = 'NullLocationRowRefusal';
  }
}

/**
 * The trust boundary for an UNSTAMPED batch (spec REV-9 CX6-20): with no order
 * on the rows there is no company to check membership against, so the only
 * people who may change it are its PROVABLE actor and an admin. A 403 rather
 * than a 409 — this is an authorisation answer, not a state conflict.
 */
export class UnattributedRefusal extends Error {
  readonly code = 'UNATTRIBUTED';

  constructor() {
    super(
      'This batch is not attributed to an order — only the person who recorded it or an admin can change it',
    );
    this.name = 'UnattributedRefusal';
  }
}

/**
 * The move's destination IS the batch's ledger location, so there is nothing to
 * reclassify. A 400: the operator can fix it by choosing another location, which
 * is exactly what the sentence asks for.
 */
export class SameLocationRefusal extends Error {
  readonly code = 'SAME_LOCATION';

  constructor(public readonly locationId: number) {
    super(`Location ${locationId} is already this batch's ledger location — choose a different one`);
    this.name = 'SameLocationRefusal';
  }
}

/**
 * The LOCKED physical row holds fewer units than the batch took. Moving anyway
 * would book a negative on-hand at the source, so both figures ride out and the
 * operator decides what the real story is.
 */
export class InsufficientAtSourceRefusal extends Error {
  readonly code = 'INSUFFICIENT_AT_SOURCE';

  constructor(
    public readonly productId: number,
    public readonly locationId: number,
    public readonly onBook: number,
    public readonly needed: number,
  ) {
    super(
      `Location ${locationId} has ${onBook} of product ${productId} on the books — ${needed} needed to move this batch`,
    );
    this.name = 'InsufficientAtSourceRefusal';
  }
}

/**
 * THE MOVED-TO LOCATION IS GONE (F8 / OC-8). A batch whose stock a prior MOVE
 * reclassified is restored at the PHYSICAL location, and an admin can delete an
 * unused location between that move and this reverse. Left alone, the prelock's
 * materialize INSERT dies on `fk_pl_location` and the operator reads a bare 500
 * about a repair they can actually make — so the reverse core proves the
 * location before it prelocks and names it here.
 *
 * An `AppError`, so `apiHandler` renders it and the one refusal mapper needs no
 * arm for it (`RestorationLedgerCorrupt`'s idiom, `restorations.ts:90`).
 */
export class RestoreLocationMissing extends AppError {
  constructor(public readonly physicalLocationId: number) {
    super(
      `The location this batch was moved to (${physicalLocationId}) no longer exists — repair the move before reversing`,
      'RESTORE_LOCATION_MISSING',
      409,
    );
  }
}

/** Every refusal the ROUTE renders as a structured envelope. */
export type AttributionRefusal =
  | NotAttributableRefusal
  | TooManyRowsRefusal
  | MixedStampsRefusal
  | BatchMovedRefusal
  | PartiallyStampedRefusal
  | FulfilledBatchRefusal
  | R2bOtherTargetRefusal
  | AlreadyReversedRefusal
  | AlreadyMovedRefusal
  | BatchRestoredRefusal
  | MultiLocationRefusal
  | NullLocationRowRefusal
  | UnattributedRefusal
  | SameLocationRefusal
  | InsufficientAtSourceRefusal;
