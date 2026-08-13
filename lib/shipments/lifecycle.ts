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
 * consume for the "CLOSED/CANCELLED shipments reject add/link/count/graduate"
 * half of the matrix.
 */

/**
 * Claim the shipment as OPEN.
 *
 * The write is a deliberate NO-OP (`status: 'OPEN'` on rows already OPEN): its
 * value is the row LOCK it takes, which serializes this caller against a
 * concurrent close/cancel whose own claim is `WHERE id = ? AND status = 'OPEN'`.
 * Exactly one of them can win, and the loser sees `count === 0`.
 *
 * Throws 404 when the id is unknown and 409 when the shipment is no longer OPEN
 * (the read that separates those two only runs AFTER a failed claim, when
 * nothing has been written).
 */
export async function claimOpenShipment(
  tx: Prisma.TransactionClient,
  shipmentId: string,
): Promise<void> {
  const claim = await tx.inboundShipment.updateMany({
    where: { id: shipmentId, status: InboundShipmentStatus.OPEN },
    data: { status: InboundShipmentStatus.OPEN },
  });
  if (claim.count > 0) return;

  const existing = await tx.inboundShipment.findUnique({
    where: { id: shipmentId },
    select: { id: true, status: true },
  });
  if (!existing) {
    throw new AppError('Inbound shipment not found', 'NOT_FOUND', 404);
  }
  throw new AppError(
    `Inbound shipment ${shipmentId} is ${existing.status.toLowerCase()} and cannot be changed`,
    'CONFLICT',
    409,
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
    await claimOpenShipment(tx, previousShipmentId);
  }
  if (targetShipmentId !== null) {
    await claimOpenShipment(tx, targetShipmentId);
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
