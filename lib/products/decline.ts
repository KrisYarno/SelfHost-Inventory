import prisma from '@/lib/prisma';
import { applyStockDelta, withDeadlockRetry } from '@/lib/inventory';
import { inventory_logs_logType, Prisma } from '@prisma/client';

export type DeclineResult = {
  reversed: boolean;
  alreadyDeclined: boolean;
};

/**
 * Decline (reject) a provisional product — concurrency-hardened (spec E6).
 *
 * Runs inside a single `prisma.$transaction`, outer call wrapped in a
 * deadlock/lock-timeout retry. Lock order matches the rest of the codebase
 * (`lib/fulfillment.ts` / `createInventoryTransfer`): lock `product_locations`
 * BEFORE touching `products`, eliminating the AB-BA deadlock.
 *
 * Steps:
 *   0. Idempotency: if the product is missing or already soft-deleted, no-op.
 *   1. Lock + reverse stock FIRST. `SELECT … FOR UPDATE` the product's
 *      product_locations rows. For each row with quantity > 0, apply a
 *      compensating `applyStockDelta(tx, { delta: -quantity, … })`. Using the
 *      FOR-UPDATE-locked on-hand makes the reversal exact under concurrent
 *      adjustments, never negative, and skips availability validation (this is a
 *      corrective reversal, not a sale).
 *   2. Soft-delete the product LAST: deletedAt / deletedBy / reviewedBy /
 *      reviewedAt. `approvalStatus` is left at PENDING_REVIEW so a restore
 *      re-opens it in the review queue.
 *
 * Returns { reversed, alreadyDeclined }.
 *
 * Phase C (DECLINE SEAM FIX — R-D2): the caller may pass an in-transaction
 * `record` callback (and a shared `batchId`). It is invoked with THIS function's
 * retried `tx` right before the result is returned, so the PRODUCT_DECLINE audit
 * event is written atomically with the stock reversal — an unrecordable decline
 * now hard-aborts and rolls back the reversal instead of committing it
 * unrecorded. The callback fires on BOTH the no-op (already-declined) and the
 * reversal paths so the event is emitted exactly as before. `batchId` is passed
 * (not regenerated), so `withDeadlockRetry` re-runs reuse the same id.
 */
export async function declineProduct(
  productId: number,
  admin: { id: number },
  opts?: {
    record?: (tx: Prisma.TransactionClient, ctx: DeclineResult) => Promise<void>;
    batchId?: string | null;
  }
): Promise<DeclineResult> {
  const { record, batchId } = opts ?? {};
  return withDeadlockRetry(() =>
    prisma.$transaction(async (tx) => {
      // 0. Idempotency — bail if already declined/deleted (or never existed).
      const product = await tx.product.findUnique({ where: { id: productId } });
      if (!product || product.deletedAt) {
        const result: DeclineResult = { reversed: false, alreadyDeclined: true };
        // Record on THIS tx so the audit event is atomic with the (no-op) decline.
        if (record) await record(tx, result);
        return result;
      }

      // 1. Lock the product_locations rows FOR UPDATE, reverse to zero FIRST.
      const locs = await tx.$queryRaw<
        Array<{ id: number; locationId: number; quantity: number }>
      >(
        Prisma.sql`SELECT id, locationId, quantity FROM product_locations WHERE productId = ${productId} FOR UPDATE`
      );

      for (const loc of locs) {
        if (loc.quantity > 0) {
          await applyStockDelta(tx, {
            userId: admin.id,
            productId,
            locationId: loc.locationId,
            delta: -loc.quantity,
            // Phase C (P-C2): a decline reversal is a CORRECTION, not a neutral
            // adjustment; batchId joins the row to the PRODUCT_DECLINE event.
            logType: inventory_logs_logType.CORRECTION,
            reasonCode: 'CORRECTION',
            batchId,
          });
        }
      }

      // 2. Soft-delete the product LAST.
      await tx.product.update({
        where: { id: productId },
        data: {
          deletedAt: new Date(),
          deletedBy: admin.id,
          reviewedBy: admin.id,
          reviewedAt: new Date(),
        },
      });

      const result: DeclineResult = { reversed: true, alreadyDeclined: false };
      // Record on THIS (retried) tx so the audit event is atomic with the reversal.
      if (record) await record(tx, result);
      return result;
    })
  );
}
