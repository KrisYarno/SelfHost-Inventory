import { Prisma, StagingItemStatus } from '@prisma/client';
import { AppError } from '@/lib/error-handling';
import { lineMoney, type LineMoney } from '@/lib/supply-orders/money';
import { claimShipmentForVerify, promoteToReceiving, type LockedLine } from '@/lib/supply-orders/claims';
import { VerifiedLockedRefusal } from '@/lib/supply-orders/refusals';
import {
  resolveSupplyOrderProduct,
  type SupplyOrderProductInput,
} from '@/lib/supply-orders/product-resolve';
import type { RecvDiscrepancySubject } from '@/lib/exceptions/kinds';

/**
 * THE VERIFY CORE (spec §4.0 / §4.2, contract pack C2c.1).
 *
 * One act: somebody stood at the dock, counted what actually arrived on a line,
 * and said so. Everything downstream hangs off that number — the labeling
 * ceiling, the line's money, the supplier discrepancy — so this core's whole job
 * is to move it ONLY while moving it is still honest, and to say precisely what
 * moved.
 *
 * TX-SCOPED (the lane's uniform rule). No `@/lib/prisma`, no transaction of its
 * own, no retry, and NO exception write: the ROUTE owns
 * `prisma.$transaction(tx => verifyLine(tx, args, { onRecord, batchId }))` and
 * writes the exception row + the audit event from inside `onRecord`, with this
 * transaction's locks still held.
 *
 * THE STEP ORDER (the numbered comments follow it):
 *
 *   1  line `FOR UPDATE`   the transaction's FIRST statement (`AND shipmentId`
 *                          — the nested route ids must be pinned to each other)
 *   2  header claim        `claimShipmentForVerify`; the LEGACY discriminator
 *                          lives inside it, so a W1 receipt refuses here
 *   3  CLASSIFY + refuse   first / raise / lower, decided from the LOCKED row
 *   4  promote             ORDERED -> RECEIVING, atomically; only the winner
 *   5  product re-map      `resolveSupplyOrderProduct` (house lock order puts
 *                          products AFTER the header)
 *   6  the ONE guarded write, whose WHERE is the entire precondition
 *   7  `onRecord`          the route's exception + audit writes
 *
 * WHY ONE WRITE. The count, the labeling flag, the re-map and the description
 * re-snapshot all land in a single guarded `updateMany` (PK2-3). A line that
 * was re-pointed at a substitute product but kept the old name in its
 * `description` snapshot would mislabel every later screen, and two writes can
 * always end up half-applied under a future refactor.
 *
 * WHAT VERIFY NEVER DOES: it never writes `orderedQuantity` (an unordered line
 * stays unordered for every later query — PK-5), never stamps `verifiedAt/By`
 * more than once (the RECEIPT act is the first count; later corrections are
 * audited), and never touches `labeling-loss` (whose money depends only on the
 * stocked/disposed counters — G2s3-4).
 */

export type VerifyArgs = {
  lineId: number;
  shipmentId: string;
  verifiedQuantity: number;
  note?: string | null;
  labelingRequired?: boolean;
  /** The product that ACTUALLY arrived, when it is not the one ordered. */
  deliveredProduct?: SupplyOrderProductInput;
  actor: { id: number; isAdmin: boolean };
};

/** What the ROUTE needs to write the exception row and the audit event. */
export type VerifyRecordContext = {
  lineId: number;
  shipmentId: string;
  kind: VerifyKind;
  /** NULL on a first verify — nothing had been counted yet. */
  previousVerified: number | null;
  ordered: number | null;
  verified: number;
  delta: number;
  lossCents: number;
  surplusValueCents: number;
  unitCostCents: number | null;
  note: string | null;
  /** TRUE only for the transaction that actually moved ORDERED -> RECEIVING. */
  headerPromoted: boolean;
  /**
   * The line's RESOLVED product AFTER any re-map — the product this count is
   * attributed to. Published outright so the ROUTE never has to derive it from
   * facts that are allowed to be absent (a re-map that did not happen, a
   * discrepancy that was not raised).
   */
  productId: number;
  productRemapped: { from: number; to: number; productName: string } | null;
  productCreated: boolean;
  /**
   * THE INTENT, not the write (PK2-2). The core assembles the complete subject;
   * the route calls the writer. `resolve` carries a `subjectPatch` because every
   * resolution refreshes the row's money (spec §6).
   */
  recvDiscrepancy:
    | { action: 'upsert'; subject: RecvDiscrepancySubject }
    | {
        action: 'resolve';
        resolution: 'recount-corrected' | 'additional-delivery';
        subjectPatch: RecvDiscrepancySubject;
      }
    | null;
  batchId: string;
};

export type VerifyResult = {
  lineId: number;
  status: StagingItemStatus;
  verifiedQuantity: number;
  stockedQuantity: number;
  disposedQuantity: number;
  remaining: number;
  resolvedProductId: number | null;
  money: LineMoney;
};

/** Which of the three acts this call is (spec §4.0). */
type VerifyKind = 'first' | 'raise' | 'lower';

/**
 * The locked line PLUS `orderedProductId` — the discrepancy subject carries
 * both product ids, so a substitution stays legible after the fact.
 */
type LockedVerifyLine = LockedLine & { orderedProductId: number | null };

/** The statuses a verify may act on at all (spec §4.0's line machine). */
const VERIFIABLE: readonly StagingItemStatus[] = [
  StagingItemStatus.ORDERED,
  StagingItemStatus.VERIFIED,
  StagingItemStatus.LABELING,
  StagingItemStatus.COMPLETE,
];

/** A count may come DOWN only while the line is still being worked. */
const LOWERABLE: readonly StagingItemStatus[] = [
  StagingItemStatus.VERIFIED,
  StagingItemStatus.LABELING,
];

/** A line may be re-pointed at a different product only this early. */
const REMAPPABLE: readonly StagingItemStatus[] = [
  StagingItemStatus.ORDERED,
  StagingItemStatus.VERIFIED,
];

/**
 * The line, locked. Verify keeps its own locking read rather than sharing the
 * booking primitive's: the column list IS each core's decision set, and verify
 * decides from one column (`orderedProductId`) a booking never reads.
 */
async function lockLine(
  tx: Prisma.TransactionClient,
  lineId: number,
  shipmentId: string,
): Promise<LockedVerifyLine> {
  const rows = await tx.$queryRaw<LockedVerifyLine[]>(
    Prisma.sql`SELECT id, status, verifiedQuantity, stockedQuantity, disposedQuantity, resolvedProductId, orderedProductId, orderedQuantity, lineTotalCents, shipmentId, locationId, labelingRequired FROM staging_items WHERE id = ${lineId} AND shipmentId = ${shipmentId} FOR UPDATE`,
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

/**
 * first / raise / lower, decided from the LOCKED row (PK2-1).
 *
 * An EQUAL request classifies as `lower` deliberately: it is a re-stamp of the
 * note and the flags with a delta of 0, and it must obey the same "the ledger
 * has already booked units" rules a real reduction does — there is no third
 * kind to reason about.
 */
function classify(line: LockedVerifyLine, requested: number): VerifyKind {
  if (line.status === StagingItemStatus.ORDERED) return 'first';
  return requested > (line.verifiedQuantity ?? 0) ? 'raise' : 'lower';
}

/**
 * The next line status (spec §4.0). Everything not named here PRESERVES the
 * locked status — including a first verify of 0, which stays VERIFIED with
 * remaining 0: not queued for labeling, not terminal, and re-openable by a
 * later raise (no DISCARDED-by-typo).
 */
function nextStatusFor(
  kind: VerifyKind,
  line: LockedVerifyLine,
  remaining: number,
): StagingItemStatus {
  if (kind === 'first') return StagingItemStatus.VERIFIED;
  if (kind === 'raise' && line.status === StagingItemStatus.COMPLETE) {
    // Box 2 arrived after the line closed: there is work to do again.
    return StagingItemStatus.LABELING;
  }
  if (kind === 'lower' && line.status === StagingItemStatus.LABELING && remaining === 0) {
    // The remainder was never coming — what is stocked and disposed IS the line.
    return StagingItemStatus.COMPLETE;
  }
  return line.status;
}

/**
 * Everything the line write may legally do, decided BEFORE anything is written.
 *
 * The three rules, in the order a reader needs them:
 *   - a count may never come below what the ledger already booked
 *     (`stocked + disposed`), and only a line still being worked may come down
 *     at all;
 *   - an UNORDERED line's count is the money BASIS (D4), so once a batch or a
 *     disposal exists it cannot move in either direction — later units are a NEW
 *     unordered line. A `labelingRequired` change is independent of that freeze;
 *   - a re-map is legal only before anything has been stocked or disposed, and
 *     only while the line is ORDERED or VERIFIED.
 */
function assertLegal(
  line: LockedVerifyLine,
  kind: VerifyKind,
  requested: number,
  hasDeliveredProduct: boolean,
): void {
  if (!VERIFIABLE.includes(line.status)) {
    throw new AppError(
      `Supply-order line ${line.id} is ${line.status} — only an ordered, verified, labeling or complete line can be verified`,
      'NOT_ORDERED',
      409,
    );
  }

  const booked = line.stockedQuantity + line.disposedQuantity;

  if (kind === 'lower') {
    if (!LOWERABLE.includes(line.status) || requested < booked) {
      throw new VerifiedLockedRefusal(line.stockedQuantity, line.disposedQuantity);
    }
  }

  if (line.orderedQuantity === null && kind !== 'first') {
    const changesCount = requested !== (line.verifiedQuantity ?? 0);
    if (changesCount && booked > 0) {
      throw new VerifiedLockedRefusal(line.stockedQuantity, line.disposedQuantity);
    }
  }

  if (hasDeliveredProduct && (!REMAPPABLE.includes(line.status) || booked > 0)) {
    throw new VerifiedLockedRefusal(line.stockedQuantity, line.disposedQuantity);
  }
}

/**
 * The COMPLETE `recv-discrepancy` subject for the counters being WRITTEN (spec
 * §6). Assembled the same way for an upsert and for a resolution's patch — a
 * settlement that left stale money on the row would misreport what was settled.
 *
 * An UNORDERED arrival has `expectedQty: null` and no short/over: nothing was
 * expected, so nothing is missing or extra (its units are counted only as
 * `unorderedLines` in the header rollup — OCs2-20).
 */
function discrepancySubject(
  line: LockedVerifyLine,
  args: { lineId: number; shipmentId: string; verified: number; note: string | null },
  resolvedProductId: number | null,
  money: LineMoney,
): RecvDiscrepancySubject {
  const ordered = line.orderedQuantity;
  return {
    stagingItemId: args.lineId,
    shipmentId: args.shipmentId,
    productId: resolvedProductId,
    orderedProductId: line.orderedProductId,
    expectedQty: ordered,
    countedQty: args.verified,
    orderedQuantity: ordered,
    verifiedQuantity: args.verified,
    shortUnits: ordered !== null && args.verified < ordered ? ordered - args.verified : 0,
    overUnits: ordered !== null && args.verified > ordered ? args.verified - ordered : 0,
    unitCostCents: money.unitCostCents,
    lossCents: money.lossCents,
    surplusValueCents: money.surplusValueCents,
    note: args.note,
  };
}

/**
 * Record the delivered count for one supply-order line.
 *
 * Returns the line as it now stands plus its money. Refuses with
 * `VerifiedLockedRefusal` when the count would contradict the ledger, 409
 * `CONFLICT` when the guarded write loses a race, and 409 `LEGACY_READ_ONLY`
 * when the header is a W1 receipt.
 */
export async function verifyLine(
  tx: Prisma.TransactionClient,
  args: VerifyArgs,
  opts: {
    onRecord: (tx: Prisma.TransactionClient, ctx: VerifyRecordContext) => Promise<void>;
    batchId: string;
  },
): Promise<VerifyResult> {
  const { lineId, shipmentId, verifiedQuantity, actor } = args;
  const note = args.note ?? null;
  const { onRecord, batchId } = opts;

  // 1. THE LINE, LOCKED — the transaction's first statement.
  const line = await lockLine(tx, lineId, shipmentId);

  // 2. THE HEADER, CLAIMED (and proven to be a supply order, not a W1 receipt:
  //    a legacy header refuses here with 409 LEGACY_READ_ONLY).
  await claimShipmentForVerify(tx, shipmentId);

  // 3. CLASSIFY, then refuse everything the state machine forbids — before a
  //    single byte is written.
  const kind = classify(line, verifiedQuantity);
  assertLegal(line, kind, verifiedQuantity, args.deliveredProduct !== undefined);

  // 4. ORDERED -> RECEIVING. An atomic claim, so two concurrent first verifies
  //    both succeed and only the WINNER reports `headerPromoted` — the loser
  //    carries on against a header that is already RECEIVING. Attempted on
  //    every verify because the claim is a no-op unless the header is still
  //    ORDERED (a raise on a CLOSED order leaves the status alone).
  const headerPromoted = await promoteToReceiving(tx, shipmentId);

  // 5. THE DELIVERED PRODUCT (S10). After the header, per the house lock order.
  let resolvedProductId = line.resolvedProductId;
  let productRemapped: { from: number; to: number; productName: string } | null = null;
  let productCreated = false;
  let description: string | null = null;
  if (args.deliveredProduct) {
    const resolved = await resolveSupplyOrderProduct(tx, args.deliveredProduct, actor);
    productCreated = resolved.created;
    // The name is re-snapshotted whatever happened, because the snapshot is a
    // statement about THIS instant; the remap is reported only when the line
    // genuinely changed product (a line with no product yet has nothing to
    // report a remap FROM — unreachable on a supply-order line, which is given
    // both ids at order entry).
    description = resolved.productName;
    if (line.resolvedProductId !== null && line.resolvedProductId !== resolved.productId) {
      productRemapped = {
        from: line.resolvedProductId,
        to: resolved.productId,
        productName: resolved.productName,
      };
    }
    resolvedProductId = resolved.productId;
  }

  // THE PRODUCT THIS COUNT BELONGS TO, settled here so `onRecord` can state it.
  // A supply-order line is given BOTH product ids at order entry and a re-map
  // only ever swaps one id for another, so a null at this point is a broken row
  // rather than a state the flow can reach — an invariant, not a refusal the
  // operator could act on.
  if (resolvedProductId === null) {
    throw new AppError(
      `Supply-order line ${lineId} has no resolved product to attribute the count to`,
      'INVARIANT',
      500,
    );
  }
  const productId = resolvedProductId;

  // MONEY (D4/S2). ONE function owns it — verify's loss and stock-in's batch
  // share are the same arithmetic on the same line. The basis is
  // `orderedQuantity ?? verified`, and `orderedQuantity` is NEVER written.
  const money = lineMoney({
    lineTotalCents: line.lineTotalCents,
    orderedQuantity: line.orderedQuantity,
    verifiedQuantity,
  });

  const remaining = verifiedQuantity - line.stockedQuantity - line.disposedQuantity;
  const nextStatus = nextStatusFor(kind, line, remaining);

  // 6. THE ONE GUARDED WRITE. The WHERE is the entire precondition — the row is
  //    already locked, so `count !== 1` means a future refactor lost the lock
  //    rather than that somebody raced us, and refusing is still the only safe
  //    answer.
  // `Unchecked` because the re-map writes the FOREIGN KEY column directly — the
  // checked variant only accepts a nested relation connect, which an updateMany
  // cannot carry.
  const data: Prisma.StagingItemUncheckedUpdateManyInput = {
    status: nextStatus,
    verifiedQuantity,
  };
  if (kind === 'first') {
    // THE RECEIPT ACT. Stamped once: a later raise or correction is audited,
    // but the moment the delivery was received does not move.
    data.verifiedBy = actor.id;
    data.verifiedAt = new Date();
  }
  if (args.labelingRequired !== undefined) data.labelingRequired = args.labelingRequired;
  if (description !== null) {
    data.resolvedProductId = resolvedProductId;
    data.description = description;
  }

  const where =
    kind === 'first'
      ? {
          id: lineId,
          shipmentId,
          status: StagingItemStatus.ORDERED,
          verifiedQuantity: null,
          stockedQuantity: 0,
          disposedQuantity: 0,
        }
      : { id: lineId, shipmentId, status: line.status, verifiedQuantity: line.verifiedQuantity };

  const claim = await tx.stagingItem.updateMany({ where, data });
  if (claim.count !== 1) {
    throw new AppError(
      `Supply-order line ${lineId} changed while it was being verified; reload and retry`,
      'CONFLICT',
      409,
    );
  }

  // THE DISCREPANCY INTENT (PK2-2). A count that misses the order (or an
  // unordered arrival, which is a discrepancy by construction) upserts the
  // complete subject; a count that lands back ON the order resolves a row that
  // previously differed — `additional-delivery` when a RAISE closed a shortage
  // (box 2 really did turn up), `recount-corrected` otherwise (the first count
  // was wrong). A first verify that matches writes nothing at all.
  const ordered = line.orderedQuantity;
  const subject = discrepancySubject(
    line,
    { lineId, shipmentId, verified: verifiedQuantity, note },
    resolvedProductId,
    money,
  );
  let recvDiscrepancy: VerifyRecordContext['recvDiscrepancy'] = null;
  if (ordered === null || verifiedQuantity !== ordered) {
    recvDiscrepancy = { action: 'upsert', subject };
  } else if (kind !== 'first' && line.verifiedQuantity !== ordered) {
    recvDiscrepancy = {
      action: 'resolve',
      resolution:
        kind === 'raise' && (line.verifiedQuantity ?? 0) < ordered
          ? 'additional-delivery'
          : 'recount-corrected',
      subjectPatch: subject,
    };
  }

  // 7. THE ROUTE'S WRITES — exception row + audit, same transaction, locks still
  //    held. A throw here aborts the verify, which is the point.
  await onRecord(tx, {
    lineId,
    shipmentId,
    kind,
    previousVerified: line.verifiedQuantity,
    ordered,
    verified: verifiedQuantity,
    delta: verifiedQuantity - (line.verifiedQuantity ?? 0),
    lossCents: money.lossCents,
    surplusValueCents: money.surplusValueCents,
    unitCostCents: money.unitCostCents,
    note,
    headerPromoted,
    productId,
    productRemapped,
    productCreated,
    recvDiscrepancy,
    batchId,
  });

  return {
    lineId,
    status: nextStatus,
    verifiedQuantity,
    stockedQuantity: line.stockedQuantity,
    disposedQuantity: line.disposedQuantity,
    remaining,
    resolvedProductId,
    money,
  };
}
