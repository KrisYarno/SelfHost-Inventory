import prisma from '@/lib/prisma';
import { applyStockDelta, withDeadlockRetry, centsFromCostPrice } from '@/lib/inventory';
import { inventory_logs_logType, Prisma } from '@prisma/client';
import { AppError } from '@/lib/error-handling';
import { formatProductName } from '@/lib/products';
import type { GraduateInput } from '@/lib/validation/staging';

export type GraduateResult = {
  productId: number;
  approvalStatus: 'APPROVED' | 'PENDING_REVIEW';
  locationId: number;
  countedQuantity: number;
};

/**
 * Context handed to the change-tracking recorder (change-tracking Task 10). Lets
 * the CALLER emit its correlated events (STAGING_GRADUATE + PRODUCT_CREATE + any
 * stock event) from INSIDE this helper's atomic transaction, all under one
 * batchId — so an unrecordable event aborts the graduation, and the whole fan-out
 * commits or rolls back together. `created` is true only on the "new product" path.
 */
export type GraduateRecordContext = {
  productId: number;
  approvalStatus: 'APPROVED' | 'PENDING_REVIEW';
  locationId: number;
  countedQuantity: number;
  created: boolean;
};

/**
 * Graduate a pre-staging item into real inventory.
 *
 * Runs inside a single `prisma.$transaction`, with the outer call wrapped in a
 * deadlock/lock-timeout retry (E6) in addition to the optimistic-lock retry that
 * lives inside `applyStockDelta`'s callers.
 *
 * Steps (spec: "Graduation transaction"):
 *   1. Concurrency claim: atomic `updateMany WHERE status='RECEIVED'`. count===0 -> 409.
 *      This is the double-stock guard so two people can't graduate the same box.
 *   2. Resolve the product:
 *      - "existing": load it, assert it exists and is not soft-deleted (400 otherwise).
 *        approvalStatus is left UNCHANGED (restocking one's own pending product keeps
 *        it pending).
 *      - "new": create a product mirroring POST /api/products exactly, plus
 *        approvalStatus (APPROVED for admins, PENDING_REVIEW otherwise) and createdBy.
 *   3. Stock-in via the shared `applyStockDelta(tx, …)` core (+countedQuantity).
 *   4. Finalize the staging item: resolvedProductId + countedQuantity.
 *
 * Returns { productId, approvalStatus, locationId, countedQuantity }.
 */
export async function graduateStagingItem(
  stagingItemId: number,
  body: GraduateInput,
  actor: { id: number; isAdmin: boolean },
  // Phase C (ER-C1): options object, not a fifth positional (P-C4 rationale). The
  // route's onRecord moves in here, alongside the SAME batchId it stamps on the
  // STAGING_GRADUATE/PRODUCT_CREATE events — so the STOCK_IN ledger row joins the
  // same batch (P-C1). withDeadlockRetry re-runs reuse this opts.batchId; it is
  // NEVER regenerated inside the retried transaction.
  opts?: {
    onRecord?: (tx: Prisma.TransactionClient, ctx: GraduateRecordContext) => Promise<void>;
    batchId?: string | null;
  }
): Promise<GraduateResult> {
  const { onRecord, batchId } = opts ?? {};
  return withDeadlockRetry(() =>
    prisma.$transaction(async (tx) => {
      // 1. Atomic claim — the double-stock guard.
      const claim = await tx.stagingItem.updateMany({
        where: { id: stagingItemId, status: 'RECEIVED' },
        data: {
          status: 'GRADUATED',
          graduatedBy: actor.id,
          graduatedAt: new Date(),
        },
      });
      if (claim.count === 0) {
        throw new AppError(
          'Item already graduated or discarded',
          'CONFLICT',
          409
        );
      }

      // 2. Resolve the product.
      let productId: number;
      let approvalStatus: 'APPROVED' | 'PENDING_REVIEW';
      let created = false;
      // Phase C (P-C3): the frozen "cost at receipt" for the STOCK_IN row, captured
      // from whichever branch's product row is in scope BEFORE the stock write (no
      // single `product` variable spans both branches).
      let costPriceAtGraduation: Prisma.Decimal | number;

      if (body.mode === 'existing') {
        const target = await tx.product.findFirst({
          where: { id: body.productId, deletedAt: null },
        });
        if (!target) {
          throw new AppError('Target product not found', 'BAD_REQUEST', 400);
        }
        productId = target.id;
        // Unchanged: restocking an existing (possibly still-pending) product
        // does not flip its approval status.
        approvalStatus = target.approvalStatus as 'APPROVED' | 'PENDING_REVIEW';
        costPriceAtGraduation = target.costPrice;
      } else {
        // Mirror POST /api/products create mapping exactly. `productFields`
        // is validated by ProductCreateUISchema (variant required; unit already
        // trimmed/lowercased by the schema's transform).
        const f = body.productFields;
        const baseName = f.baseName.trim();
        const variant = f.variant.trim();
        const unit = f.unit ? f.unit.trim().toLowerCase() : null;
        const numericValue = f.numericValue ?? null;
        const name = formatProductName({ baseName, variant });
        const costPrice = Number(f.costPrice ?? 0);
        const retailPrice = Number(f.retailPrice ?? 0);

        const created_ = await tx.product.create({
          data: {
            name,
            baseName,
            variant,
            unit,
            numericValue,
            quantity: 0,
            location: body.locationId,
            lowStockThreshold: f.lowStockThreshold ?? 10,
            costPrice: costPrice >= 0 ? costPrice : 0,
            retailPrice: retailPrice >= 0 ? retailPrice : 0,
            approvalStatus: actor.isAdmin ? 'APPROVED' : 'PENDING_REVIEW',
            createdBy: actor.id,
          },
        });
        productId = created_.id;
        approvalStatus = created_.approvalStatus as 'APPROVED' | 'PENDING_REVIEW';
        costPriceAtGraduation = created_.costPrice;
        created = true;
      }

      // 3. Stock-in via the shared core (log + product_locations upsert + loc-1
      //    mirror). Phase C: graduation is a receipt, so the ledger row is STOCK_IN
      //    with unitCostCents frozen from the product's cost (P-C3, via the ER-C2
      //    helper — never re-derive) and the caller's batchId joining it to the
      //    STAGING_GRADUATE/PRODUCT_CREATE events (P-C1).
      await applyStockDelta(tx, {
        userId: actor.id,
        productId,
        locationId: body.locationId,
        delta: body.countedQuantity,
        logType: inventory_logs_logType.STOCK_IN,
        unitCostCents: centsFromCostPrice(costPriceAtGraduation),
        batchId,
      });

      // 4. Finalize the staging item.
      await tx.stagingItem.update({
        where: { id: stagingItemId },
        data: {
          resolvedProductId: productId,
          countedQuantity: body.countedQuantity,
        },
      });

      // 5. Change-tracking (Task 10): emit the caller's correlated events from
      //    INSIDE this same transaction, so the graduation, the product-create,
      //    and any stock event share one batchId and commit/roll back together.
      //    A throw here (unrecordable change) aborts the entire graduation.
      if (onRecord) {
        await onRecord(tx, {
          productId,
          approvalStatus,
          locationId: body.locationId,
          countedQuantity: body.countedQuantity,
          created,
        });
      }

      return {
        productId,
        approvalStatus,
        locationId: body.locationId,
        countedQuantity: body.countedQuantity,
      };
    })
  );
}
