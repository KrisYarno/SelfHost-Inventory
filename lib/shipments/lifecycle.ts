import { Prisma, InboundShipmentStatus, StagingItemStatus } from '@prisma/client';
import { AppError } from '@/lib/error-handling';

/**
 * Shipment-membership guards (contract pack REV-2 T4, W1-2a).
 *
 * Every state decision here is an ATOMIC CLAIM — the `lib/staging/graduate.ts:69`
 * idiom: an `updateMany` whose WHERE *is* the precondition, so `count === 0`
 * means "somebody else got there first" and no read ever gates a write. That is
 * what makes link/unlink safe against a concurrent graduation or a concurrent
 * shipment close, which is the whole point: two people work the same dock.
 *
 * These guards are also the seam W1-2b's count endpoint and W1-3a's graduation
 * consume for the "a settled shipment rejects further receiving work" half of
 * the matrix. W1-2b (pack REV-3) split the single OPEN-only claim into two
 * intent-named guards, because the amended matrix is no longer uniform:
 *
 *   add / link / unlink / count / expectedQuantity   OPEN only
 *   graduate                                         OPEN or CLOSED
 *   anything at all on a CANCELLED shipment          refused
 */

/**
 * Claim the shipment in one of `allowed`, returning the status that won.
 *
 * Each attempt is a deliberate NO-OP write (`status: X` on rows already X): its
 * value is the row LOCK it takes, which serializes this caller against a
 * concurrent close/cancel whose own claim is `WHERE id = ? AND status = 'OPEN'`.
 * Exactly one of them can win, and the loser sees `count === 0`.
 *
 * Statuses are tried ONE AT A TIME rather than as a single `status: { in: [...] }`
 * claim, because that form would have to pick one value to WRITE — and writing
 * 'OPEN' to a shipment matched as CLOSED would silently reopen a settled
 * receipt. One extra round-trip on the CLOSED path buys a write that cannot
 * change anything.
 *
 * Throws 404 when the id is unknown and 409 when the shipment is in none of the
 * allowed statuses (the read that separates those two runs only AFTER every
 * claim has failed, when nothing has been written).
 */
async function claimShipmentIn(
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

const OPEN_ONLY: readonly InboundShipmentStatus[] = [InboundShipmentStatus.OPEN];

/**
 * OPEN or CLOSED — the STRANDED-LINE AMENDMENT (pack REV-3 T4).
 *
 * Closing a shipment means "receiving is finished", NOT "these boxes may never
 * become stock". A line that is still sitting in staging when its shipment
 * closes must still be able to graduate, or closing a shipment would strand
 * real inventory forever. CANCELLED is the one status that blocks everything:
 * a cancelled shipment asserts the goods never arrived.
 */
const OPEN_OR_CLOSED: readonly InboundShipmentStatus[] = [
  InboundShipmentStatus.OPEN,
  InboundShipmentStatus.CLOSED,
];

/**
 * Guard for acts that change a line's RECEIPT QUANTITIES — the count endpoint
 * and the expectedQuantity edit on PATCH /api/staging-items/[id]. Both feed the
 * discrepancy arithmetic the close guard settles, so both stop at the close.
 */
export function claimShipmentForCount(
  tx: Prisma.TransactionClient,
  shipmentId: string,
): Promise<InboundShipmentStatus> {
  return claimShipmentIn(
    tx,
    shipmentId,
    OPEN_ONLY,
    (status) =>
      `Inbound shipment ${shipmentId} is ${status.toLowerCase()} and its receipt quantities can no longer be changed`,
  );
}

/**
 * Guard for graduating a linked line into stock (W1-3a's seam). Legal on OPEN
 * and CLOSED alike; only a CANCELLED shipment refuses.
 */
export function claimShipmentForGraduation(
  tx: Prisma.TransactionClient,
  shipmentId: string,
): Promise<InboundShipmentStatus> {
  return claimShipmentIn(
    tx,
    shipmentId,
    OPEN_OR_CLOSED,
    (status) =>
      `Inbound shipment ${shipmentId} is ${status.toLowerCase()} and its lines cannot be graduated`,
  );
}

/** Link/unlink guard — membership changes are receiving work, so OPEN only. */
function claimShipmentForLink(
  tx: Prisma.TransactionClient,
  shipmentId: string,
): Promise<InboundShipmentStatus> {
  return claimShipmentIn(
    tx,
    shipmentId,
    OPEN_ONLY,
    (status) => `Inbound shipment ${shipmentId} is ${status.toLowerCase()} and cannot be changed`,
  );
}

export type ShipmentLinkAction = 'LINK' | 'UNLINK' | 'RELINK' | 'NOOP';

export type ShipmentLinkResult = {
  action: ShipmentLinkAction;
  previousShipmentId: string | null;
};

/**
 * Move a staging line onto / off of a shipment.
 *
 * Legal ONLY while the item is RECEIVED and EVERY shipment involved is OPEN —
 * the one it leaves as much as the one it joins, because pulling a line out of
 * a closed shipment would silently rewrite a settled receipt.
 *
 * Order is load-bearing: cheap state guard, then the shipment claims, then the
 * item claim. The item claim pins BOTH the status and the current link, so an
 * item that graduated (or was relinked) between the caller's read and this
 * write loses with `count === 0` -> 409 instead of overwriting the winner.
 *
 * The audit verbs are emitted by the CALLER from the returned action (house
 * pattern: recordChange lives in the route, inside this same transaction).
 */
export async function applyShipmentLink(
  tx: Prisma.TransactionClient,
  args: {
    item: { id: number; status: StagingItemStatus; shipmentId: string | null };
    targetShipmentId: string | null;
  },
): Promise<ShipmentLinkResult> {
  const { item, targetShipmentId } = args;
  const previousShipmentId = item.shipmentId ?? null;

  // Already where it was asked to be: no write, no audit line.
  if (previousShipmentId === targetShipmentId) {
    return { action: 'NOOP', previousShipmentId };
  }

  if (item.status !== StagingItemStatus.RECEIVED) {
    throw new AppError(
      `Staging item ${item.id} is ${item.status.toLowerCase()}; only a received item can be linked to or unlinked from a shipment`,
      'CONFLICT',
      409,
    );
  }

  if (previousShipmentId !== null) {
    await claimShipmentForLink(tx, previousShipmentId);
  }
  if (targetShipmentId !== null) {
    await claimShipmentForLink(tx, targetShipmentId);
  }

  const claim = await tx.stagingItem.updateMany({
    where: {
      id: item.id,
      status: StagingItemStatus.RECEIVED,
      shipmentId: previousShipmentId,
    },
    data: { shipmentId: targetShipmentId },
  });
  if (claim.count === 0) {
    throw new AppError(
      `Staging item ${item.id} changed state while it was being linked; reload and retry`,
      'CONFLICT',
      409,
    );
  }

  return {
    action:
      previousShipmentId === null ? 'LINK' : targetShipmentId === null ? 'UNLINK' : 'RELINK',
    previousShipmentId,
  };
}
