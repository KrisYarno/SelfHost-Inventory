import { Prisma, StagingItemStatus, inventory_logs_logType } from '@prisma/client';
import { AppError } from '@/lib/error-handling';
import { applyStockDelta, centsFromCostPrice } from '@/lib/inventory';
import { applyReceiptCost } from '@/lib/products/cost';
import { lineMoney, batchShareCents } from '@/lib/supply-orders/money';
import { claimShipmentForBooking, type LockedLine } from '@/lib/supply-orders/claims';
import { CeilingRefusal } from '@/lib/supply-orders/refusals';
import type {
  CostDiffersSubject,
  LabelingLossSubject,
  PendingWithStockSubject,
} from '@/lib/exceptions/kinds';

/**
 * THE BOOKING PRIMITIVE (spec §5.2, contract pack C2b.2).
 *
 * One act: N labeled units off a verified supply-order line become stock. It is
 * the only place in the lane that writes the ledger, and everything about it is
 * arranged so that two labelers working the same line can never both win.
 *
 * TX-SCOPED (OCp2-1). No `@/lib/prisma` import, no transaction of its own, no
 * retry: the ROUTE owns `withBookingRetry(() => prisma.$transaction(tx =>
 * bookSupplyOrderBatch(tx, args, { onRecord, batchId })))` with the batchId
 * minted OUTSIDE the retry, so a re-run never emits a second audit batch.
 *
 * FROZEN STEP ORDER (spec §5.2; the numbered comments below follow it exactly):
 *
 *   1   line `FOR UPDATE`      the transaction's FIRST statement — no read view
 *                              is pinned before the locks
 *   1b  idempotency read       the SAME bookingKey replays; a different
 *                              quantity/location under it is a 409
 *   2   header claim           `claimShipmentForBooking` (the model
 *                              discriminator lives inside it)
 *   4   money                  `lineMoney` + the EXACT batch share
 *   5   product_locations      the whole range, `ORDER BY locationId FOR
 *                              UPDATE` (a gap lock covers a target location
 *                              with no row yet) + PRE-BATCH on-hand
 *   6   `applyStockDelta`      ledger row + product_locations + (location 1)
 *                              products.quantity
 *   6b  products `FOR UPDATE`  the AUTHORITATIVE approval / deleted / cost read
 *   7   D-COST + subjects      fill-if-null on the FIRST batch only
 *   8   guarded increment      `WHERE stockedQuantity = <the locked value>`
 *   9   `onRecord`             the ROUTE writes the exception rows + the audit
 *
 * LOCK ORDER, house-uniform: line -> header -> product_locations -> products.
 * `applyStockDelta` may take the product ROW lock first for location 1; that is
 * legal because the step-5 RANGE lock already precedes it (PK-10).
 *
 * READ DISCIPLINE: every read is a locking read or comes after the locks. A
 * plain read before the line lock would pin a REPEATABLE READ snapshot older
 * than every lock the primitive takes, and the ceiling would then be checked
 * against numbers that were already stale — the exact hazard D3 exists to kill.
 *
 * THE WRITE BOUNDARY IS ROUTE-ONLY (plan P-3b). This module never imports the
 * exceptions writer (the boundary gate's allow-list is routes only, and its scan
 * matches text — so this sentence deliberately does not spell the specifier).
 * It ASSEMBLES the subjects (`costDiffers`, `pendingWithStock`,
 * `labelingLossRefresh`) and hands them to the route through `onRecord`, inside
 * this same transaction with the locks still held.
 */

export type BookingArgs = {
  lineId: number;
  shipmentId: string;
  bookingKey: string;
  quantity: number;
  locationId: number;
  note?: string | null;
  actor: { id: number; isAdmin: boolean };
};

/**
 * D-COST's fast path (PK-12/13): the receipt priced these units differently from
 * the product's standing cost, and NOTHING was written. M2b-OWNED — deliberately
 * NOT `GraduateCostPrompt`, whose module M6 deletes.
 */
export type BookingCostPrompt = {
  productId: number;
  /** NULL when the product's stored cost carries no representable value (a 0). */
  currentCents: number | null;
  receiptCents: number;
};

/**
 * Everything the ROUTE needs to write the exception rows and the audit event
 * from inside this transaction (seams S4/S20).
 */
export type BookingRecordContext = {
  lineId: number;
  shipmentId: string;
  productId: number;
  approvalStatus: 'APPROVED' | 'PENDING_REVIEW';
  quantity: number;
  locationId: number;
  unitCostCents: number | null;
  receiptCostCents: number | null;
  stockedAfter: number;
  disposed: number;
  verified: number;
  remaining: number;
  firstBatch: boolean;
  fastPath: boolean;
  basisFrozen: boolean;
  bookingKey: string;
  note: string | null;
  batchId: string;
  /** onRecord never runs on the replay path; the field states it for the audit. */
  replayed: false;
  costDiffers: CostDiffersSubject | null;
  pendingWithStock: PendingWithStockSubject | null;
  /**
   * S20: the line already carries disposed units, so the labeling-loss row's
   * CUMULATIVE money moved when this batch landed. Derived HERE from the locked
   * line — the route never probes the writer for existence (PK2-11).
   */
  labelingLossRefresh: LabelingLossSubject | null;
  costPrompt: BookingCostPrompt | null;
};

export type BookingResult = {
  lineId: number;
  status: StagingItemStatus;
  stockedQuantity: number;
  disposedQuantity: number;
  remaining: number;
  batch: {
    quantity: number;
    locationId: number;
    unitCostCents: number | null;
    receiptCostCents: number | null;
    replayed: boolean;
  };
  productId: number;
  approvalStatus: 'APPROVED' | 'PENDING_REVIEW';
  costPrompt: BookingCostPrompt | null;
};

export type DiscardArgs = {
  lineId: number;
  shipmentId: string;
  reason: string;
  actor: { id: number; isAdmin: boolean };
  /**
   * What the caller BELIEVED was left when it decided to write the remainder off
   * (REV-11 clause 1). Absent = no belief stated = nothing to contradict.
   */
  expectRemaining?: number;
};

/** What the discard-remaining route needs to write its row and its audit line. */
export type DiscardRecordContext = {
  lineId: number;
  shipmentId: string;
  productId: number | null;
  reason: string;
  /** The units THIS act wrote off (the remainder). */
  discarded: number;
  /** `disposedQuantity` after the write — what the subject is keyed on. */
  disposedAfter: number;
  stockedQuantity: number;
  verified: number;
  remaining: 0;
  unitCostCents: number | null;
  lossCents: number | null;
  labelingLoss: LabelingLossSubject;
  batchId: string;
};

export type DiscardResult = {
  lineId: number;
  status: 'COMPLETE';
  disposedQuantity: number;
  stockedQuantity: number;
  remaining: 0;
};

/** The ledger row a replayed `bookingKey` already wrote. */
type PriorBatch = {
  id: number;
  delta: number;
  locationId: number | null;
  unitCostCents: number | null;
  receiptCostCents: number | null;
};

/** The step-6b product read: the AUTHORITATIVE approval / deleted / cost row. */
type LockedProduct = {
  id: number;
  approvalStatus: string;
  deletedAt: Date | null;
  costPrice: Prisma.Decimal | number | null;
};

/**
 * The line, locked. `AND shipmentId = ?` is not decoration: the nested route ids
 * must be pinned to each other, or a line id from another order would book
 * against this one's header claim.
 */
async function lockLine(
  tx: Prisma.TransactionClient,
  lineId: number,
  shipmentId: string,
): Promise<LockedLine> {
  const rows = await tx.$queryRaw<LockedLine[]>(
    Prisma.sql`SELECT id, status, verifiedQuantity, stockedQuantity, disposedQuantity, resolvedProductId, orderedQuantity, lineTotalCents, shipmentId, locationId, labelingRequired FROM staging_items WHERE id = ${lineId} AND shipmentId = ${shipmentId} FOR UPDATE`,
  );
  const line = rows[0];
  if (!line) {
    throw new AppError(
      `Supply-order line ${lineId} was not found on order ${shipmentId}`,
      'NOT_FOUND',
      404,
    );
  }
  return line;
}

/** A line that can be stocked or written off is one somebody has verified. */
function assertBookableStatus(line: LockedLine): void {
  if (line.status !== StagingItemStatus.VERIFIED && line.status !== StagingItemStatus.LABELING) {
    throw new AppError(
      `Supply-order line ${line.id} is ${line.status} — only a VERIFIED or LABELING line can be stocked`,
      'NOT_BOOKABLE',
      409,
    );
  }
}

/**
 * The number of units left to work: read from the LOCKED row, never re-derived
 * from a second read (D3 — a SUM over the ledger would answer from the snapshot).
 */
function remainingOf(line: LockedLine, verified: number): number {
  return verified - line.stockedQuantity - line.disposedQuantity;
}

function assertVerified(line: LockedLine): number {
  if (line.verifiedQuantity === null) {
    throw new AppError(
      `Supply-order line ${line.id} has not been verified — verify the delivered count first`,
      'VALIDATION_ERROR',
      422,
    );
  }
  return line.verifiedQuantity;
}

/**
 * Book one batch of labeled units into stock.
 *
 * Returns the line as it now stands plus the batch that was written. A REPLAY
 * (same `bookingKey`, same quantity + location) returns the ORIGINAL batch
 * fields with `replayed: true` and writes nothing at all.
 */
export async function bookSupplyOrderBatch(
  tx: Prisma.TransactionClient,
  args: BookingArgs,
  opts: {
    onRecord: (tx: Prisma.TransactionClient, ctx: BookingRecordContext) => Promise<void>;
    batchId: string;
  },
): Promise<BookingResult> {
  const { lineId, shipmentId, bookingKey, quantity, locationId, actor } = args;
  const note = args.note ?? null;
  const { onRecord, batchId } = opts;

  // 1. THE LINE, LOCKED — the transaction's first statement.
  const line = await lockLine(tx, lineId, shipmentId);

  // 1b. IDEMPOTENCY (G2s-6), after the lock. The client generates one
  //     `bookingKey` per batch ATTEMPT and reuses it across retries, so a
  //     re-submitted request must return what the first one wrote rather than
  //     book the units twice. The UNIQUE (stagingItemId, bookingKey) is the
  //     backstop underneath: a race that gets past this read fails 1062 inside
  //     the transaction, `withBookingRetry` re-runs it, and the re-run's read
  //     sees the winner and replays.
  const priorRows = await tx.$queryRaw<PriorBatch[]>(
    Prisma.sql`SELECT id, delta, locationId, unitCostCents, receiptCostCents FROM inventory_logs WHERE stagingItemId = ${lineId} AND bookingKey = ${bookingKey}`,
  );
  const prior = priorRows[0] ?? null;
  if (prior) {
    if (prior.delta !== quantity || prior.locationId !== locationId) {
      // THE OPERATOR'S FRAME (spec REV-10 clause 10). The person reading this
      // is at a bench with a printed label; the booking key is the CLIENT's
      // bookkeeping and means nothing to them. Say what was recorded, what was
      // just asked for, and what to do next.
      throw new AppError(
        `Already recorded ${prior.delta} unit(s) for this attempt into location ${prior.locationId}; ${quantity} unit(s) into location ${locationId} is a different batch — reload to see the current count, then record it again.`,
        'IDEMPOTENCY_MISMATCH',
        409,
      );
    }
    return replayResult(tx, line, prior);
  }

  // The asserts, all on the LOCKED row (the header discriminator is enforced by
  // `claimShipmentForBooking` in step 2).
  assertBookableStatus(line);
  const verified = assertVerified(line);
  if (line.resolvedProductId === null) {
    throw new AppError(
      `Supply-order line ${line.id} has no resolved product — verify the delivered product first`,
      'VALIDATION_ERROR',
      422,
    );
  }
  const productId = line.resolvedProductId;
  if (quantity > remainingOf(line, verified)) {
    throw new CeilingRefusal(line.stockedQuantity, line.disposedQuantity, verified, quantity);
  }

  // 2. THE HEADER, CLAIMED (and proven to be a supply order, not a W1 receipt).
  await claimShipmentForBooking(tx, shipmentId);

  // 4. MONEY (D4). ONE unit cost per line; the batch's DOLLARS are the exact
  //    share `cumulative(after) - cumulative(before)`, never a per-unit figure
  //    multiplied out. An unordered line is priced by the LOCKED verified count
  //    and `orderedQuantity` is NEVER written — the line stays unordered for
  //    every later query (PK-5).
  const firstBatch = line.stockedQuantity === 0;
  const money = lineMoney({
    lineTotalCents: line.lineTotalCents,
    orderedQuantity: line.orderedQuantity,
    verifiedQuantity: verified,
  });
  const receiptCostCents = batchShareCents(
    line.lineTotalCents,
    money.basisQuantity,
    line.stockedQuantity,
    quantity,
  );
  const basisFrozen = line.orderedQuantity === null && firstBatch;

  // 5. THE PRODUCT'S COMPLETE product_locations RANGE, LOCKED, and the PRE-BATCH
  //    on-hand. The range (not the row) because the target location may have no
  //    row yet, and a gap lock is what stops a concurrent insert of it. NO
  //    product statement may precede this one — that is the house lock order.
  const locations = await tx.$queryRaw<{ id: number; locationId: number; quantity: number }[]>(
    Prisma.sql`SELECT id, locationId, quantity FROM product_locations WHERE productId = ${productId} ORDER BY locationId FOR UPDATE`,
  );
  const onHandBefore = locations.reduce((sum, row) => sum + row.quantity, 0);

  // 6. THE LEDGER ROW + the location quantities. For location 1 this ALSO
  //    updates products.quantity, which MAY be this transaction's first
  //    product-ROW lock — legal, because the range lock above already precedes
  //    it (PK-10).
  await applyStockDelta(tx, {
    userId: actor.id,
    productId,
    locationId,
    delta: quantity,
    logType: inventory_logs_logType.STOCK_IN,
    unitCostCents: money.unitCostCents,
    inboundShipmentId: shipmentId,
    stagingItemId: lineId,
    receiptCostCents,
    bookingKey,
    batchId,
  });

  // 6b. THE AUTHORITATIVE PRODUCT READ, locked. Deliberately AFTER the stock
  //     write (the house order product_locations -> products, so there is no
  //     cycle with decline / transfers / adjustments): a product declined in
  //     between is caught HERE, and the throw rolls the ledger row back with
  //     everything else.
  const productRows = await tx.$queryRaw<LockedProduct[]>(
    Prisma.sql`SELECT id, approvalStatus, deletedAt, costPrice FROM products WHERE id = ${productId} FOR UPDATE`,
  );
  const product = productRows[0];
  if (!product) {
    throw new AppError(`Product ${productId} not found`, 'NOT_FOUND', 404);
  }
  if (product.deletedAt !== null) {
    throw new AppError(
      `Product ${productId} was declined; line ${lineId} cannot be stocked against it (re-map the line, or record the units as a labeling loss)`,
      'PRODUCT_DECLINED',
      409,
    );
  }
  const approvalStatus = product.approvalStatus as 'APPROVED' | 'PENDING_REVIEW';

  // 7. D-COST, the FIRST batch only (the durable row per line; the admin prompt
  //    once, not per batch). The fill is `applyReceiptCost`'s atomic
  //    claim-on-NULL; the DISAGREEMENT is decided against the costPrice from the
  //    locked row above, because that is the only value this transaction knows
  //    to be current.
  let costDiffers: CostDiffersSubject | null = null;
  let costPrompt: BookingCostPrompt | null = null;
  if (firstBatch) {
    const outcome = await applyReceiptCost(tx, {
      productId,
      receiptCents: money.unitCostCents,
      actor,
      batchId,
    });
    const lockedCents = centsFromCostPrice(product.costPrice ?? null);
    const differs =
      outcome.outcome !== 'filled' &&
      money.unitCostCents !== null &&
      lockedCents !== money.unitCostCents;
    if (differs) {
      const receiptCents = money.unitCostCents as number;
      // ALWAYS the durable row (QA-7): a disagreement is a fact about this
      // receipt whoever received it. The prompt rides on top for an admin, who
      // is the only actor who can settle it through the real product PUT.
      costDiffers = { productId, stagingItemId: lineId, currentCents: lockedCents, receiptCents };
      costPrompt = actor.isAdmin ? { productId, currentCents: lockedCents, receiptCents } : null;
    }
  }

  // D10: the trigger is a property of the BOOKING now, not of product creation —
  // units are on hand for something nobody has approved. `units` is the LOCKED
  // on-hand sum plus this batch, never the batch alone; it may rise or fall with
  // intervening movements, and no monotonicity is claimed.
  const pendingWithStock: PendingWithStockSubject | null =
    approvalStatus === 'PENDING_REVIEW'
      ? { productId, stagingItemId: lineId, units: onHandBefore + quantity }
      : null;

  const stockedAfter = line.stockedQuantity + quantity;
  const remaining = verified - stockedAfter - line.disposedQuantity;
  const nextStatus =
    remaining === 0 ? StagingItemStatus.COMPLETE : StagingItemStatus.LABELING;

  // S20: this line has already lost units at the bench, so the labeling-loss
  // row's CUMULATIVE money moved when this batch landed (the loss slice sits
  // after the stocked ones). Assembled from the locked line — the route writes
  // it, and never asks the writer whether a row exists.
  const labelingLossRefresh: LabelingLossSubject | null =
    line.disposedQuantity > 0
      ? {
          stagingItemId: lineId,
          shipmentId,
          productId,
          units: line.disposedQuantity,
          unitCostCents: money.unitCostCents,
          // NULL PRESERVED (REV-10 clause 8): an unpriced line's loss is
          // unknown, not zero. `batchShareCents` already says so.
          lossCents: batchShareCents(
            line.lineTotalCents,
            money.basisQuantity,
            stockedAfter,
            line.disposedQuantity,
          ),
          reason: LABELING_LOSS_REFRESH_REASON,
        }
      : null;

  // 8. THE GUARDED INCREMENT — belt and braces on top of the row lock. `WHERE
  //    stockedQuantity = <the locked value>` means a counter that moved under us
  //    (impossible while the lock is held, possible if a future refactor loses
  //    it) refuses instead of double-booking, and the throw rolls the ledger row
  //    back with it. The submitted location is written as the NEXT-BATCH
  //    DEFAULT; the truth per batch is the ledger row's own locationId.
  const claim = await tx.stagingItem.updateMany({
    where: { id: lineId, stockedQuantity: line.stockedQuantity },
    data: {
      stockedQuantity: { increment: quantity },
      status: nextStatus,
      locationId,
    },
  });
  if (claim.count !== 1) {
    throw new AppError(
      `Supply-order line ${lineId} changed while this batch was being booked; reload and retry`,
      'CONFLICT',
      409,
    );
  }

  // 9. THE ROUTE'S WRITES — exception rows + audit, same transaction, locks
  //    still held. A throw here aborts the whole booking, which is the point.
  await onRecord(tx, {
    lineId,
    shipmentId,
    productId,
    approvalStatus,
    quantity,
    locationId,
    unitCostCents: money.unitCostCents,
    receiptCostCents,
    stockedAfter,
    disposed: line.disposedQuantity,
    verified,
    remaining,
    firstBatch,
    // The FAST PATH (§4.3): one batch closed the line outright — the operator
    // typed the whole remainder instead of working it in parts.
    fastPath: firstBatch && remaining === 0,
    basisFrozen,
    bookingKey,
    note,
    batchId,
    replayed: false,
    costDiffers,
    pendingWithStock,
    labelingLossRefresh,
    costPrompt,
  });

  return {
    lineId,
    status: nextStatus,
    stockedQuantity: stockedAfter,
    disposedQuantity: line.disposedQuantity,
    remaining,
    batch: {
      quantity,
      locationId,
      unitCostCents: money.unitCostCents,
      receiptCostCents,
      replayed: false,
    },
    productId,
    approvalStatus,
    costPrompt,
  };
}

/**
 * The reason a labeling-loss REFRESH carries.
 *
 * The primitive cannot read the register row (the write boundary is route-only),
 * so it cannot echo the operator's original discard reason back into the
 * subject. It states what it actually knows instead of inventing a cause; the
 * operator's own words survive in the row's append-only note history, written by
 * the discard route.
 */
const LABELING_LOSS_REFRESH_REASON =
  'units disposed at labeling; loss re-priced by a later stock-in on the line';

/**
 * The replay answer: the ORIGINAL batch fields off the ledger row, the CURRENT
 * line fields off the locked row, and the product's current approval status.
 * No stock, cost, exception or audit write happens on this path (G2s3-8).
 *
 * The approval read is a PLAIN read on purpose: this path writes nothing, so it
 * takes no locks — and taking a product lock here WITHOUT the product_locations
 * range lock in front of it would break the house lock order for no gain.
 */
async function replayResult(
  tx: Prisma.TransactionClient,
  line: LockedLine,
  prior: PriorBatch,
): Promise<BookingResult> {
  if (line.resolvedProductId === null) {
    // Unreachable: a ledger row for this line proves a resolved product.
    // Defended rather than non-null-asserted, so a future refactor cannot turn
    // it into a null-deref.
    throw new AppError(
      `Supply-order line ${line.id} has a booked batch but no resolved product`,
      'VALIDATION_ERROR',
      422,
    );
  }
  const current = await tx.product.findUnique({
    where: { id: line.resolvedProductId },
    select: { approvalStatus: true },
  });

  return {
    lineId: line.id,
    status: line.status,
    stockedQuantity: line.stockedQuantity,
    disposedQuantity: line.disposedQuantity,
    remaining: (line.verifiedQuantity ?? 0) - line.stockedQuantity - line.disposedQuantity,
    batch: {
      quantity: prior.delta,
      locationId: prior.locationId as number,
      unitCostCents: prior.unitCostCents,
      receiptCostCents: prior.receiptCostCents,
      replayed: true,
    },
    productId: line.resolvedProductId,
    approvalStatus: (current?.approvalStatus ?? 'APPROVED') as 'APPROVED' | 'PENDING_REVIEW',
    costPrompt: null,
  };
}

/**
 * Write off everything still un-stocked on a line: units that were verified but
 * lost before they became stock (§4.3.5).
 *
 * The SAME prologue as a booking — line `FOR UPDATE`, header claim — and the
 * same guarded-write discipline. NEVER a stock movement: these units were never
 * stock, so nothing touches the ledger or the product. (A loss AFTER stocking is
 * an inventory ADJUSTMENT with `reasonCode DAMAGE`, on the existing surface.)
 *
 * Idempotent by construction: a second call finds `remaining === 0` and refuses
 * with 409 `NOT_BOOKABLE`.
 */
export async function discardRemaining(
  tx: Prisma.TransactionClient,
  args: DiscardArgs,
  opts: {
    onRecord: (tx: Prisma.TransactionClient, ctx: DiscardRecordContext) => Promise<void>;
    batchId: string;
  },
): Promise<DiscardResult> {
  const { lineId, shipmentId, reason, expectRemaining } = args;
  const { onRecord, batchId } = opts;

  const line = await lockLine(tx, lineId, shipmentId);
  assertBookableStatus(line);
  const verified = assertVerified(line);

  // THE CLIENT'S BELIEF, CHECKED AGAINST THE LOCKED ROW (REV-11 clause 1).
  // "Write off the remainder" names a quantity the operator read off a card, and
  // a colleague who stocked or disposed since makes that card older than the
  // line. Refusing here — BEFORE the header claim and before every write — costs
  // the raced operator a reload; not refusing costs them units they never saw.
  const remaining = remainingOf(line, verified);
  if (expectRemaining !== undefined && expectRemaining !== remaining) {
    throw new AppError(
      `The remainder changed since you loaded this line — it is now ${remaining} (verified ${verified}, stocked ${line.stockedQuantity}, disposed ${line.disposedQuantity}). Reload and try again.`,
      'CONFLICT',
      409,
    );
  }

  await claimShipmentForBooking(tx, shipmentId);

  if (remaining <= 0) {
    throw new AppError(
      `Supply-order line ${lineId} has nothing left to discard (${line.stockedQuantity} stocked, ${line.disposedQuantity} disposed of ${verified} verified)`,
      'NOT_BOOKABLE',
      409,
    );
  }

  const disposedAfter = line.disposedQuantity + remaining;
  const money = lineMoney({
    lineTotalCents: line.lineTotalCents,
    orderedQuantity: line.orderedQuantity,
    verifiedQuantity: verified,
  });
  // CUMULATIVE and exact: the loss slice is the disposed units' own share of the
  // line total, taken after the stocked ones (spec §4.3.5). An UNPRICED line
  // (no lineTotalCents — an unbilled unordered arrival) loses an UNKNOWN amount,
  // and says NULL: a 0 there would be a fabricated figure the register would
  // then report as a settled cost (REV-10 clause 8). A real total of 0 is a
  // known zero and stays 0.
  const lossCents = batchShareCents(
    line.lineTotalCents,
    money.basisQuantity,
    line.stockedQuantity,
    disposedAfter,
  );

  // The guarded write. Raw because the guard is on the value being incremented:
  // `WHERE disposedQuantity = <the locked value>` refuses a second discard that
  // raced this one, and the throw takes the whole transaction with it.
  const written = await tx.$executeRaw(
    Prisma.sql`UPDATE staging_items SET disposedQuantity = disposedQuantity + ${remaining}, status = ${StagingItemStatus.COMPLETE}, updatedAt = NOW() WHERE id = ${lineId} AND disposedQuantity = ${line.disposedQuantity}`,
  );
  if (written !== 1) {
    throw new AppError(
      `Supply-order line ${lineId} changed while its remainder was being discarded; reload and retry`,
      'CONFLICT',
      409,
    );
  }

  await onRecord(tx, {
    lineId,
    shipmentId,
    productId: line.resolvedProductId,
    reason,
    discarded: remaining,
    disposedAfter,
    stockedQuantity: line.stockedQuantity,
    verified,
    remaining: 0,
    unitCostCents: money.unitCostCents,
    lossCents,
    labelingLoss: {
      stagingItemId: lineId,
      shipmentId,
      productId: line.resolvedProductId,
      units: disposedAfter,
      unitCostCents: money.unitCostCents,
      lossCents,
      reason,
    },
    batchId,
  });

  return {
    lineId,
    status: 'COMPLETE',
    disposedQuantity: disposedAfter,
    stockedQuantity: line.stockedQuantity,
    remaining: 0,
  };
}

/** Prisma's write-conflict / deadlock code, plus the raw MySQL 1213 shape. */
const RETRYABLE_CODES = new Set(['P2034', 'P2002']);

/**
 * The booking's retry envelope (seam S13): `withDeadlockRetry` semantics PLUS a
 * bounded retry on Prisma `P2002`.
 *
 * P2002 is in the set for one specific, designed reason: two requests carrying
 * the SAME `bookingKey` can both get past the idempotency read, and the UNIQUE
 * `(stagingItemId, bookingKey)` then fails the loser inside its transaction. Re-
 * running it from a fresh snapshot is exactly right — the re-run's idempotency
 * read now sees the winner's row and answers with a replay.
 *
 * IT REGENERATES NOTHING. The caller's `fn` is re-run verbatim, and the batchId
 * it closes over was minted OUTSIDE this wrapper, so a re-run never emits a
 * second audit batch (the graduate precedent).
 *
 * Written as its own loop rather than wrapping `withDeadlockRetry`: delegating
 * would have to nest a second loop for the P2002 branch, and the attempt budget
 * would then be the product of the two rather than the number stated here.
 */
export async function withBookingRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: unknown) {
      lastErr = e;
      const code = (e as { code?: string })?.code ?? '';
      const msg = String((e as { message?: string })?.message ?? '');
      if (RETRYABLE_CODES.has(code) || /deadlock|lock wait timeout/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 50 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}
