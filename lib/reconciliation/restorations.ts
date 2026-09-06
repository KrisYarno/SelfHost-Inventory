/**
 * THE RESTORATION LEDGER (reconciliation Part 2, spec §2.5; pack CB2a.2).
 *
 * "How much of this batch has already been put back, and has it been moved?" is
 * the question that bounds every correction: a reverse restores the REMAINDER,
 * never the whole batch twice, and a move refuses a batch whose stock has
 * already travelled. The answer is not derivable from the ledger rows — a
 * CORRECTION row carries its OWN batch id — so it is read from the audit events
 * the restoring writers file against the reversed batch as their ENTITY.
 *
 * ONE PLAIN READ, and plain is load bearing. A locking read over this range
 * would take a gap lock on an EMPTY range for the overwhelmingly common
 * first-restoration case, and two first-restorations of two DIFFERENT batches
 * would then deadlock against each other (spec §2.7(4)). Freshness comes from
 * WHERE it runs, not from how it locks: the caller has already taken the batch's
 * rows `FOR UPDATE`, so this read's view postdates every committed restoration.
 * The order pin lives in each caller's suite, because only the caller can hold it.
 *
 * FAIL CLOSED ON A MALFORMED EVENT. Every figure this module produces becomes a
 * cap on how much stock a later writer puts back. A cap computed from a blob we
 * cannot read is exactly the number this lane never writes (truthful data), so
 * an event whose shape does not validate raises `RESTORATION_LEDGER_CORRUPT`
 * naming the event, and the batch stays frozen until somebody repairs it.
 *
 * A MOVE CONTRIBUTES METADATA, NEVER UNITS (spec REV-9 CX6-2). Its legs are a
 * reclassification — one negative at the physical location, one equal positive
 * at the ledger location — so they net to zero per product and are validated as
 * a pair rather than summed. Product MEMBERSHIP is not checked here: this module
 * issues one read and never sees the batch's rows, so the consumer that holds
 * them owns that cross-check.
 *
 * Next-free and TX-scoped, like every module the writers share.
 */

import { Prisma } from '@prisma/client';

import { AppError } from '@/lib/error-handling';
import { prelockKey } from '@/lib/inventory/prelock';

/**
 * The three events that put stock back or relocate it. Spread into every Prisma
 * `in` — a readonly tuple does not type-check against Prisma's `string[]`.
 */
export const RESTORATION_ACTION_TYPES = [
  'INVENTORY_CORRECTION',
  'INVENTORY_BATCH_REVERSE',
  'INVENTORY_BATCH_MOVE',
] as const;

/**
 * The FROZEN `details.rows` shape every restoration event carries — `delta`
 * SIGNED exactly as it was written to the ledger, so a MOVE's legs read as the
 * pair they are and a restoration reads as the positive units it put back.
 */
export type RestorationRow = { productId: number; locationId: number; delta: number };

export type PriorRestorations = {
  /** `prelockKey(productId, locationId)` -> units already put back there. */
  restoredByKey: Map<string, number>;
  /**
   * The LAST event that put units on each key of `restoredByKey` (pack CB2b.1
   * rung 9). The belt that refuses a ledger disagreeing with the batch has to
   * NAME the event it refuses on, and a sum cannot be traced back to one without
   * this — an id we could not attribute would be a sentence we cannot stand
   * behind. Same key set as `restoredByKey`, always.
   */
  eventIdByKey: Map<string, number>;
  /** The MOVE event's metadata, or null. NEVER units. */
  move: {
    ledgerLocationId: number;
    physicalLocationId: number;
    eventId: number;
    at: string;
    /**
     * The products the MOVE's legs name, ascending and deduped (pack CB2b.1
     * rung 8, G7-1). MEMBERSHIP is the consumer's cross-check — it holds the
     * batch's rows and this module does not — so the consumer is handed the
     * list this module already validated rather than a second read of its own.
     */
    productIds: number[];
  } | null;
};

/**
 * A restoration event we cannot read is a cap we cannot stand behind, so the
 * batch is frozen rather than under-restored. Rides `apiHandler` as an
 * `AppError` and is never retried — a malformed blob does not become readable
 * on a second attempt.
 */
export class RestorationLedgerCorrupt extends AppError {
  constructor(public readonly eventId: number) {
    super(
      `Restoration event ${eventId} is malformed — the batch cannot be reversed or moved until it is repaired`,
      'RESTORATION_LEDGER_CORRUPT',
      409,
    );
  }
}

/** The Int32 ceiling every id column in this schema sits under. */
const INT32_MAX = 2147483647;

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A real, safe, positive Int32 id — anything else is a blob we cannot read. */
function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= INT32_MAX;
}

/** The `details.rows` array, validated down to a shape or refused. */
function rowsOf(eventId: number, details: unknown): unknown[] {
  const rows = isObj(details) ? details.rows : undefined;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new RestorationLedgerCorrupt(eventId);
  }
  return rows;
}

/** One row's ids and signed delta. `requirePositive` is the restoration rule. */
function rowOf(eventId: number, raw: unknown, requirePositive: boolean): RestorationRow {
  if (!isObj(raw)) {
    throw new RestorationLedgerCorrupt(eventId);
  }
  const { productId, locationId, delta } = raw;
  if (!isId(productId) || !isId(locationId)) {
    throw new RestorationLedgerCorrupt(eventId);
  }
  if (typeof delta !== 'number' || !Number.isSafeInteger(delta) || delta === 0) {
    throw new RestorationLedgerCorrupt(eventId);
  }
  // A zero or NEGATIVE restoration delta is CORRUPT, not tolerated: a readable
  // -N would INFLATE the remainder a reverse then owes, which is the one
  // arithmetic error this ledger exists to make impossible.
  if (requirePositive && delta < 0) {
    throw new RestorationLedgerCorrupt(eventId);
  }
  return { productId, locationId, delta };
}

/**
 * The MOVE event's metadata, with its legs validated as PAIRS: exactly two rows
 * per product, one negative at the physical location and one equal positive at
 * the ledger location. Anything else is not a reclassification and its
 * arithmetic cannot be trusted.
 */
function moveOf(
  eventId: number,
  details: unknown,
  createdAt: Date,
): NonNullable<PriorRestorations['move']> {
  const blob = isObj(details) ? details : {};
  const { ledgerLocationId, physicalLocationId } = blob;
  if (!isId(ledgerLocationId) || !isId(physicalLocationId)) {
    throw new RestorationLedgerCorrupt(eventId);
  }
  if (ledgerLocationId === physicalLocationId) {
    throw new RestorationLedgerCorrupt(eventId);
  }

  const legsByProduct = new Map<number, RestorationRow[]>();

  rowsOf(eventId, details).forEach((raw) => {
    const row = rowOf(eventId, raw, false);
    const legs = legsByProduct.get(row.productId);
    if (legs) {
      legs.push(row);
    } else {
      legsByProduct.set(row.productId, [row]);
    }
  });

  legsByProduct.forEach((legs) => {
    if (legs.length !== 2) {
      throw new RestorationLedgerCorrupt(eventId);
    }
    const out = legs.filter((l) => l.delta < 0);
    const back = legs.filter((l) => l.delta > 0);
    if (out.length !== 1 || back.length !== 1) {
      throw new RestorationLedgerCorrupt(eventId);
    }
    if (out[0].locationId !== physicalLocationId || back[0].locationId !== ledgerLocationId) {
      throw new RestorationLedgerCorrupt(eventId);
    }
    if (out[0].delta + back[0].delta !== 0) {
      throw new RestorationLedgerCorrupt(eventId);
    }
  });

  const productIds: number[] = [];
  legsByProduct.forEach((_legs, productId) => productIds.push(productId));
  productIds.sort((a, b) => a - b);

  return {
    ledgerLocationId,
    physicalLocationId,
    eventId,
    productIds,
    // An ISO string, never a Date: nothing downstream of this module should be
    // deciding how a timestamp renders.
    at: createdAt.toISOString(),
  };
}

/**
 * What has ALREADY been put back for this batch, and whether it has been moved.
 *
 * @throws RestorationLedgerCorrupt on any event whose shape does not validate
 */
export async function priorRestorations(
  tx: Prisma.TransactionClient,
  batchId: string,
): Promise<PriorRestorations> {
  const events = await tx.auditLog.findMany({
    where: {
      entityType: 'INVENTORY',
      entityId: batchId,
      actionType: { in: [...RESTORATION_ACTION_TYPES] },
    },
    orderBy: { id: 'asc' },
    select: { id: true, actionType: true, details: true, createdAt: true },
  });

  const restoredByKey = new Map<string, number>();
  const eventIdByKey = new Map<string, number>();
  let move: PriorRestorations['move'] = null;

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];

    if (event.actionType === 'INVENTORY_BATCH_MOVE') {
      // Two moves cannot exist on a legitimate ledger: the first one refuses the
      // second. "Latest wins" would silently pick one of two disagreeing
      // accounts of where the stock is.
      if (move !== null) {
        throw new RestorationLedgerCorrupt(event.id);
      }
      move = moveOf(event.id, event.details, event.createdAt);
      continue;
    }

    if (
      event.actionType !== 'INVENTORY_CORRECTION' &&
      event.actionType !== 'INVENTORY_BATCH_REVERSE'
    ) {
      // Unreachable through the `in` filter above. A caller that hands one over
      // is wrong, not something to tolerate.
      throw new RestorationLedgerCorrupt(event.id);
    }

    rowsOf(event.id, event.details).forEach((raw) => {
      const row = rowOf(event.id, raw, true);
      const key = prelockKey(row.productId, row.locationId);
      restoredByKey.set(key, (restoredByKey.get(key) ?? 0) + row.delta);
      eventIdByKey.set(key, event.id);
    });
  }

  return { restoredByKey, eventIdByKey, move };
}

/**
 * THE NAME OF THE LOCATION A MOVE PUT THIS BATCH AT (pack CB2.5e.2).
 *
 * `ALREADY_MOVED` used to say "location 7", which is an id the operator then has
 * to go and look up somewhere else. This is the one read that turns it into a
 * sentence they can act on — and it happens ONLY on the refusal path, after the
 * caller has already locked the batch's rows, so the happy path's statement
 * count is exactly what it was.
 *
 * A PLAIN read, like everything else in this module: the batch is held `FOR
 * UPDATE` by the caller, so this view already postdates every committed move,
 * and a locking read here would buy nothing but another lock to deadlock on.
 *
 * A MISSING ROW IS `null`, NOT AN ERROR. An admin can delete an unused location
 * between the move and this refusal, and a 500 in place of a 409 would hide the
 * refusal the operator actually needs to read. The refusal class owns the
 * fallback sentence.
 */
export async function locationNameForRefusal(
  tx: Prisma.TransactionClient,
  locationId: number,
): Promise<string | null> {
  const location = await tx.location.findUnique({
    where: { id: locationId },
    select: { name: true },
  });
  return location?.name ?? null;
}
