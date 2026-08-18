import { Prisma, InboundShipmentStatus, StagingItemStatus } from '@prisma/client';
import { AppError } from '@/lib/error-handling';

/**
 * THE CLAIM IDIOMS every supply-order writer shares (contract pack C2b.1,
 * spec §4.0; seams S5/S11).
 *
 * Every state decision here is an ATOMIC CLAIM — the W1 idiom this file
 * inherits from `lib/shipments/lifecycle.ts`: an `updateMany` whose WHERE *is*
 * the precondition, so `count === 0` means "somebody else got there first" and
 * no read ever gates a write. Two people work the same dock; a read-then-write
 * would let both of them win.
 *
 * LOCK ORDER, UNIFORM AND BINDING: line(s) -> header -> product_locations ->
 * products. Every writer in this lane takes it in that order, which is what
 * makes the booking primitive, the verify core, close/cancel and the legacy
 * decline/transfer paths incapable of deadlocking each other in a cycle.
 *
 * THE MODEL DISCRIMINATOR LIVES HERE (PK-9). `inbound_shipments.orderedAt IS
 * NULL` means a LEGACY (W1) receipt, and legacy rows are history — no booking,
 * no verify. Putting the check inside the claim helpers rather than in each
 * caller is deliberate: the caller that forgets is the one that books stock
 * against a settled W1 receipt, and there is no way to tell afterwards.
 *
 * TX-SCOPED: no `@/lib/prisma` import, no transaction of its own, no retry.
 */

/**
 * Claim the shipment in one of `allowed`, returning the status that won.
 *
 * MOVED here from `lib/shipments/lifecycle.ts` (seam S5) and exported: this lane
 * needs the primitive, and lifecycle.ts (which M6 deletes) now imports it from
 * here rather than the other way round — no re-export, no cycle.
 *
 * Each attempt is a deliberate NO-OP write (`status: X` on rows already X): its
 * value is the row LOCK it takes, which serializes this caller against a
 * concurrent close/cancel whose own claim is `WHERE id = ? AND status = ...`.
 * Exactly one of them can win, and the loser sees `count === 0`.
 *
 * Statuses are tried ONE AT A TIME rather than as a single `status: { in: [...] }`
 * claim, because that form would have to pick one value to WRITE — and writing
 * 'ORDERED' to a header matched as CLOSED would silently reopen a settled
 * order. One extra round-trip on the later paths buys a write that cannot
 * change anything.
 *
 * Throws 404 when the id is unknown and 409 when the header is in none of the
 * allowed statuses (the read that separates those two runs only AFTER every
 * claim has failed, when nothing has been written).
 */
export async function claimShipmentIn(
  tx: Prisma.TransactionClient,
  shipmentId: string,
  allowed: readonly InboundShipmentStatus[],
  blocked: (status: InboundShipmentStatus) => string,
): Promise<InboundShipmentStatus> {
  for (const status of allowed) {
    const claim = await tx.inboundShipment.updateMany({
      where: { id: shipmentId, status },
      data: { status },
    });
    if (claim.count > 0) return status;
  }

  const existing = await tx.inboundShipment.findUnique({
    where: { id: shipmentId },
    select: { id: true, status: true },
  });
  if (!existing) {
    throw new AppError('Inbound shipment not found', 'NOT_FOUND', 404);
  }
  throw new AppError(blocked(existing.status), 'CONFLICT', 409);
}

/**
 * The statuses a supply-order line's work is legal under (spec §4.0).
 *
 * CLOSED is in the set on purpose — the STRANDED-LINE AMENDMENT: closing means
 * "receiving is finished", not "these units may never become stock", and an
 * additional delivery on a closed order is first-class. CANCELLED is the one
 * status that blocks everything: a cancelled order asserts nothing arrived.
 */
const LIVE_ORDER_STATUSES: readonly InboundShipmentStatus[] = [
  InboundShipmentStatus.ORDERED,
  InboundShipmentStatus.RECEIVING,
  InboundShipmentStatus.CLOSED,
];

/**
 * The header's `orderedAt`, read from the row the caller has ALREADY claimed.
 *
 * A LOCKING read, not a `findUnique`: under REPEATABLE READ a plain read
 * answers from the snapshot this transaction took at its FIRST read, which is
 * older than the claim above it. `SELECT ... FOR UPDATE` reads the latest
 * committed row and costs nothing extra — the claim already holds that lock.
 *
 * Raw SQL because Prisma has no `FOR UPDATE` (house precedent:
 * `lib/products/decline.ts`, `app/api/inbound-shipments/[id]/route.ts`). The id
 * is a BOUND parameter, never interpolated.
 */
async function lockedOrderedAt(
  tx: Prisma.TransactionClient,
  shipmentId: string,
): Promise<Date | null> {
  const rows = await tx.$queryRaw<{ orderedAt: Date | null }[]>(
    Prisma.sql`SELECT orderedAt FROM inbound_shipments WHERE id = ${shipmentId} FOR UPDATE`,
  );
  return rows[0]?.orderedAt ?? null;
}

/**
 * Claim the header for a BOOKING (stock-in / discard-remaining), and prove it is
 * a supply order rather than a legacy receipt.
 *
 * Legal on ORDERED | RECEIVING | CLOSED. A booking never promotes the header:
 * the promotion is the VERIFY's act (a line cannot be labeled before it was
 * verified, so a bookable order is already RECEIVING or CLOSED — an ORDERED
 * header here means the line was verified into an order whose promotion lost its
 * race, and that is not the booking's business to fix).
 */
export async function claimShipmentForBooking(
  tx: Prisma.TransactionClient,
  shipmentId: string,
): Promise<InboundShipmentStatus> {
  const status = await claimShipmentIn(
    tx,
    shipmentId,
    LIVE_ORDER_STATUSES,
    (blockedStatus) =>
      `Supply order ${shipmentId} is ${blockedStatus.toLowerCase()} — its lines can no longer be stocked`,
  );

  if ((await lockedOrderedAt(tx, shipmentId)) === null) {
    throw new AppError(
      `Inbound shipment ${shipmentId} is a legacy receipt (pre-staging history) and cannot be stocked through the supply-order flow`,
      'NOT_BOOKABLE',
      409,
    );
  }

  return status;
}

/**
 * Claim the header for a VERIFY, and prove it is a supply order.
 *
 * Same allowed set (a RAISE on a CLOSED order is legal — box 2 arriving after an
 * early close), and the same discriminator with the READ-ONLY vocabulary: a
 * legacy receipt is not "unbookable", it is history with no mutation route at
 * all.
 */
export async function claimShipmentForVerify(
  tx: Prisma.TransactionClient,
  shipmentId: string,
): Promise<InboundShipmentStatus> {
  const status = await claimShipmentIn(
    tx,
    shipmentId,
    LIVE_ORDER_STATUSES,
    (blockedStatus) =>
      `Supply order ${shipmentId} is ${blockedStatus.toLowerCase()} — its lines can no longer be verified`,
  );

  if ((await lockedOrderedAt(tx, shipmentId)) === null) {
    throw new AppError(
      `Inbound shipment ${shipmentId} is a legacy receipt (pre-staging history) and is read-only`,
      'LEGACY_READ_ONLY',
      409,
    );
  }

  return status;
}

/**
 * ORDERED -> RECEIVING, atomically. `true` means THIS caller promoted it.
 *
 * The first verify of an order promotes it, and two concurrent first verifies
 * both have to succeed: the winner promotes, the loser's claim matches nothing
 * and it simply carries on against a header that is already RECEIVING. Only the
 * winner's audit line says "promoted".
 */
export async function promoteToReceiving(
  tx: Prisma.TransactionClient,
  shipmentId: string,
): Promise<boolean> {
  const claim = await tx.inboundShipment.updateMany({
    where: { id: shipmentId, status: InboundShipmentStatus.ORDERED },
    data: { status: InboundShipmentStatus.RECEIVING },
  });
  return claim.count > 0;
}

/**
 * Any header transition as a claim: `false` means the header was not in `from`
 * (somebody else moved it, or it never was). The caller owns the refusal
 * vocabulary — close and cancel say different things about the same `false`.
 *
 * `id` is the primary key, so the claim matches at most one row.
 */
export async function claimHeaderTransition(
  tx: Prisma.TransactionClient,
  id: string,
  from: readonly InboundShipmentStatus[],
  to: InboundShipmentStatus,
): Promise<boolean> {
  const claim = await tx.inboundShipment.updateMany({
    where: { id, status: { in: [...from] } },
    data: { status: to },
  });
  return claim.count === 1;
}

/**
 * One supply-order line, exactly as the locking reads in this lane return it.
 *
 * The column list IS the decision set: everything the booking primitive, the
 * verify core, close and cancel decide from. Keeping it in one type means the
 * line read and the line-SET read cannot drift apart.
 */
export type LockedLine = {
  id: number;
  status: StagingItemStatus;
  verifiedQuantity: number | null;
  stockedQuantity: number;
  disposedQuantity: number;
  resolvedProductId: number | null;
  orderedQuantity: number | null;
  lineTotalCents: number | null;
  shipmentId: string | null;
  locationId: number | null;
  labelingRequired: boolean;
};

/**
 * Lock EVERY line of an order and return the current rows — the FD2-1 idiom
 * (`app/api/inbound-shipments/[id]/route.ts:108-115`).
 *
 * Two statements, and both halves matter:
 *
 *   1. ASCENDING CLAIMS. One no-op `updateMany` per line, in ascending id order,
 *      so this transaction's lock ORDER is ours rather than the optimizer's. The
 *      WHERE pins `shipmentId` too: the claim is not merely a lock, it is the
 *      question "is this line STILL one of mine?".
 *   2. ONE LOCKING READ. Every decision, every named id and every audit rollup
 *      derives from THESE rows. A plain `findMany` would answer from the
 *      transaction's snapshot — older than the locks above it — so a line
 *      verified in between would be invisible and the close would settle numbers
 *      that were already wrong with nothing racing.
 *
 * The ascending pass reads ids from the snapshot; that is only a lock ORDER, not
 * a decision. A line that JOINED since the snapshot is still covered, because
 * the `ORDER BY id FOR UPDATE` read below locks the whole current membership —
 * and it can genuinely deadlock, which is correct: the caller's
 * `withDeadlockRetry` / `withBookingRetry` re-runs from a fresh snapshot.
 */
export async function lockLinesForUpdate(
  tx: Prisma.TransactionClient,
  shipmentId: string,
): Promise<LockedLine[]> {
  const snapshot = await tx.stagingItem.findMany({
    where: { shipmentId },
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  for (const { id } of snapshot) {
    await tx.stagingItem.updateMany({
      where: { id, shipmentId },
      data: { shipmentId },
    });
  }

  return tx.$queryRaw<LockedLine[]>(
    Prisma.sql`SELECT id, status, verifiedQuantity, stockedQuantity, disposedQuantity, resolvedProductId, orderedQuantity, lineTotalCents, shipmentId, locationId, labelingRequired FROM staging_items WHERE shipmentId = ${shipmentId} ORDER BY id FOR UPDATE`,
  );
}
