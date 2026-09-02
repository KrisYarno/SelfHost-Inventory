/**
 * THE ONE PREAMBLE every batch writer runs (reconciliation Part 2, spec §2.5;
 * pack CB2a.1).
 *
 * "Lock this batch's rows and read what the ledger says about it" was written
 * once, inside the manual-attribution core, and the reverse, the move and the
 * attributable correction all need exactly the same four steps in exactly the
 * same order. A second copy would not be a second implementation — it would be a
 * second lock order and a second refusal ladder, and the two would drift the way
 * the report and the write path drifted before `batchEvidence` (OC-1/OC-2).
 *
 * TX-SCOPED BY CONSTRUCTION, like every core that calls it: no Prisma client of
 * its own, no transaction of its own, and no writer imported. It reads through
 * the caller's `tx` and throws; the caller owns the retry wrapper, the order
 * lock and everything that follows.
 *
 * THE STATEMENT ORDER IS THE CONTRACT (spec §2.7(4)):
 *
 *   1. the population rows, `FOR UPDATE ORDER BY id` — the batch's X lock. A
 *      second writer on the same batch waits HERE rather than racing later.
 *   2. the batch's audit evidence — the transaction's FIRST CONSISTENT READ,
 *      opened AFTER that lock, so the read view postdates every committed
 *      restoration a concurrent writer has already filed.
 *   3. the three refusals, in the frozen order.
 *   4. the latest attempt row — a PLAIN read, LAST, so a batch that is refused
 *      at the bound never pays for it. It is consumed here (into the ONE
 *      fulfilment fact) and never handed out: two consumers reading the same row
 *      is how two spellings of "fulfilled" get born.
 *
 * The SELECT widens the manual-attribution ladder's row by `locationId`, `delta`
 * and `userId`: the reverse needs the units and the location it must restore at,
 * the move needs the location it is reclassifying from, and both need the
 * provable actor. `locationId` is NULLABLE in the ledger — refusing a null-
 * location row is each CONSUMER's rung, not this helper's, because the
 * attribution path tolerates one and the two writers do not.
 */

import { Prisma } from '@prisma/client';

import {
  batchEvidence,
  fulfillmentFact,
  rowWhereSql,
  type BatchEvidence,
} from '@/lib/reconciliation/population';
import {
  MANUAL_ATTRIBUTION_ROW_LIMIT,
  MixedStampsRefusal,
  NotAttributableRefusal,
  TooManyRowsRefusal,
} from '@/lib/reconciliation/refusals';

/** One locked population row — everything the four writers decide from. */
export type LockedBatchRow = {
  id: number;
  productId: number;
  locationId: number | null;
  delta: number;
  userId: number | null;
  logType: string;
  orderRecordId: string | null;
};

/** What the preamble learned, handed to whichever ladder called it. */
export type LockedBatch = {
  /** `FOR UPDATE ORDER BY id` — the population rows, locked. */
  rows: LockedBatchRow[];
  /** The distinct NON-NULL order ids the rows carry (at most one past step 4). */
  stamps: string[];
  /** `stamps[0] ?? null` — the batch's uniform stamp. */
  current: string | null;
  /** R0, the fulfilment event and the order it named — read once. */
  evidence: BatchEvidence;
  /** THE fulfilment fact: the event, or the LATEST attempt saying `fulfillment`. */
  fulfilled: boolean;
  /** `rows[0].id` — the attempt row's `ledgerRowId`. */
  firstRowId: number;
  productCount: number;
};

/**
 * Lock one batch's population rows and read what the ledger says about it,
 * inside the caller's transaction.
 *
 * @throws NotAttributableRefusal / TooManyRowsRefusal / MixedStampsRefusal, in
 *         that order — the frozen ladder every consumer inherits
 */
export async function lockAttributableBatch(
  tx: Prisma.TransactionClient,
  batchId: string,
): Promise<LockedBatch> {
  // 1. LOCK THE BATCH'S POPULATION ROWS. `rowWhereSql` is the one spelling of
  //    the population (pack R-3), and the batchId predicate keeps the lock to
  //    this batch's index range — the next-key locks on it are the point.
  const rows = await tx.$queryRaw<LockedBatchRow[]>(
    Prisma.sql`SELECT l.id, l.productId, l.locationId, l.delta, l.userId, l.logType, l.orderRecordId FROM inventory_logs l WHERE l.batchId = ${batchId} AND ${rowWhereSql('l')} ORDER BY l.id FOR UPDATE`,
  );

  // 2. NOTHING TO ACT ON, or a batch the report does not speak about. Both
  //    answer the same way: a transfer/count/correction batch is not "hidden",
  //    it is simply not an outbound deduction, and neither is a pre-0b-1 mass
  //    update (R0) whose ADJUSTMENT rows pass the row predicate.
  if (rows.length === 0) {
    throw new NotAttributableRefusal(batchId);
  }

  const auditEvents = await tx.auditLog.findMany({
    where: { batchId },
    orderBy: { id: 'asc' },
    select: { id: true, actionType: true, entityId: true, details: true },
  });

  // ONE evidence assembly (OC-2), through the SAME helper the report row reads,
  // so the control an operator sees and the ladder that answers them can no
  // longer disagree about the batch in front of them.
  const evidence = batchEvidence(auditEvents, rows);

  if (!evidence.attributable) {
    throw new NotAttributableRefusal(batchId);
  }

  // 3. THE BOUND, said out loud with both figures.
  const productCount = new Set(rows.map((r) => r.productId)).size;
  if (rows.length > MANUAL_ATTRIBUTION_ROW_LIMIT) {
    throw new TooManyRowsRefusal(rows.length, productCount, MANUAL_ATTRIBUTION_ROW_LIMIT);
  }

  // 4. THE STAMPS the rows carry. Distinct NON-NULL ids: a batch where some rows
  //    are stamped and some are not has one stamp and a repair to make, while a
  //    batch carrying two different ids has no "current" id at all and is
  //    reported rather than averaged (spec §2.2).
  const stamps = Array.from(
    new Set(rows.map((r) => r.orderRecordId).filter((s): s is string => s !== null)),
  );
  if (stamps.length > 1) {
    throw new MixedStampsRefusal(stamps);
  }

  // 5. THE LATEST ATTEMPT, plain and last. The ordering is byte-identical to the
  //    drill-down's history read and to the report's SQL join — `attemptedAt`
  //    then `id`, both descending, index-served by @@index([batchId,
  //    attemptedAt, id]). Ordering by `id` alone would filesort AND could pick a
  //    different row, which is how two surfaces end up disagreeing about whether
  //    a batch was fulfilled.
  const latestAttempt = await tx.orderAttributionAttempt.findFirst({
    where: { batchId },
    orderBy: [{ attemptedAt: 'desc' }, { id: 'desc' }],
    select: { evidence: true },
  });

  return {
    rows,
    stamps,
    current: stamps[0] ?? null,
    evidence,
    fulfilled: fulfillmentFact(evidence, latestAttempt),
    firstRowId: rows[0].id,
    productCount,
  };
}

/**
 * THE PARTIALLY-STAMPED PREDICATE, pure — ONE id on some rows and none on the
 * others (OC-6).
 *
 * A guarded update names the id it locked, so it can move the stamped half OR
 * the unstamped half — never the batch. Every consumer evaluates it in its own
 * slot on the ladder (the position carries meaning, so it is not folded into the
 * preamble), and none of them re-spells the test.
 */
export function partiallyStamped(
  rows: ReadonlyArray<{ orderRecordId: string | null }>,
  stamps: readonly string[],
): { stamped: number; unstamped: number } | null {
  const unstamped = rows.filter((r) => r.orderRecordId === null).length;
  if (stamps.length === 1 && unstamped > 0) {
    return { stamped: rows.length - unstamped, unstamped };
  }
  return null;
}
