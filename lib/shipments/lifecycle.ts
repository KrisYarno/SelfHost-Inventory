import { Prisma, InboundShipmentStatus, StagingItemStatus } from '@prisma/client';
import { AppError } from '@/lib/error-handling';
// Receiving/Labeling overhaul (seam S5): `claimShipmentIn` MOVED to
// `lib/supply-orders/claims.ts`, where the new flow's claims live, and is
// imported back here PRIVATELY — this module keeps exporting only its own
// wrappers, so there is no re-export and no cycle. M6 deletes this file.
import { claimShipmentIn } from '@/lib/supply-orders/claims';

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
 * W1S-7 (W1-C fix round): the shipment claims are taken in CANONICAL id order,
 * sorted and deduped — never source-then-target. A relink is the only act that
 * holds two header locks at once, and taking them in request order meant two
 * operators moving lines in opposite directions (A -> B and B -> A) grabbed them
 * in opposite orders and deadlocked each other. Sorting makes the order a
 * property of the PAIR rather than of the direction, so the two requests queue
 * instead of colliding.
 *
 * FD-3 (fix round 2) closed the residual hole in that: sorting here is only a
 * global order if EVERY header claim of the request rides this set. The staging
 * PATCH also has an OPEN-guard of its own (expectedQuantity), and taking it
 * before calling in put the source header ahead of the sorted pair on any
 * combined quantity+relink PATCH. `alsoOpen` is how such a caller hands its
 * guard over: those ids join the same sort, and a header that is ONLY a guard is
 * refused in the quantity vocabulary rather than the link one.
 *
 * The audit verbs are emitted by the CALLER from the returned action (house
 * pattern: recordChange lives in the route, inside this same transaction).
 */
export async function applyShipmentLink(
  tx: Prisma.TransactionClient,
  args: {
    item: { id: number; status: StagingItemStatus; shipmentId: string | null };
    targetShipmentId: string | null;
    /**
     * Headers the CALLER also needs held OPEN for this request. Honoured only
     * when the link actually moves the line: a NOOP link takes no locks at all
     * (below), so a caller whose guard must run regardless keeps claiming it
     * itself on that path.
     */
    alsoOpen?: readonly string[];
  },
): Promise<ShipmentLinkResult> {
  const { item, targetShipmentId, alsoOpen = [] } = args;
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

  // EVERY header this request needs, sorted + deduped: the deadlock-free order
  // (see the header note). Dedupe matters now that a caller's guard can name a
  // header the link already claims — the same row must be claimed once, not
  // twice in two vocabularies.
  const linkHeaders = [previousShipmentId, targetShipmentId].filter(
    (s): s is string => s !== null,
  );
  const headers = Array.from(new Set([...linkHeaders, ...alsoOpen])).sort();
  for (const shipmentId of headers) {
    // A header that is only the caller's quantity guard refuses in the quantity
    // vocabulary; anything the link itself touches refuses in the link one.
    if (linkHeaders.includes(shipmentId)) {
      await claimShipmentForLink(tx, shipmentId);
    } else {
      await claimShipmentForCount(tx, shipmentId);
    }
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
