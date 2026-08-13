import prisma from '@/lib/prisma';
import { applyStockDelta, withDeadlockRetry, centsFromCostPrice } from '@/lib/inventory';
import { inventory_logs_logType, Prisma } from '@prisma/client';
import { AppError } from '@/lib/error-handling';
import { formatProductName } from '@/lib/products';
import { claimShipmentForGraduation } from '@/lib/shipments/lifecycle';
import { applyReceiptCost } from '@/lib/products/cost';
import type { CostDiffersSubject } from '@/lib/exceptions/kinds';
import type { GraduateInput } from '@/lib/validation/staging';

/**
 * Which cost the STOCK_IN row was frozen at, and WHERE it came from (pack REV-3
 * T3). Stated rather than inferred, so a receipt booked on the product's
 * standing cost is never mistaken for one priced at the dock.
 */
export type GraduateReceiptCost = {
  unitCostCents: number | null;
  source: 'line' | 'product';
};

/**
 * D-COST (pack REV-3 T3, seam S11): the receipt priced these units differently
 * from the product's standing cost, and NOTHING was written. Present only for an
 * ADMIN actor — they are the ones who can settle it, through the real product
 * PUT. A non-admin gets `null` here and a `cost-differs` register row instead.
 */
export type GraduateCostPrompt = {
  productId: number;
  /** NULL when the product's stored cost carries no representable value (a 0). */
  currentCents: number | null;
  receiptCents: number;
};

export type GraduateResult = {
  productId: number;
  approvalStatus: 'APPROVED' | 'PENDING_REVIEW';
  locationId: number;
  /** The staging ROW's count — what the dock actually reported. */
  countedQuantity: number;
  /** What the ledger booked: the count, or an audited override of it. */
  bookedQuantity: number;
  receiptCost: GraduateReceiptCost;
  costPrompt: GraduateCostPrompt | null;
};

/** An audited request to book a number the dock did not produce (pack T2). */
export type GraduateOverride = { quantity: number; reason: string };

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
  /** The ROW's count. The audit line names this even when an override wins. */
  countedQuantity: number;
  bookedQuantity: number;
  /** Non-null only when the caller sent the complete override pair. */
  override: GraduateOverride | null;
  created: boolean;
  receiptCost: GraduateReceiptCost;
  /** The same prompt the response carries (admin + disagreement, else null). */
  costPrompt: GraduateCostPrompt | null;
  /**
   * D-COST, the OTHER half (pack REV-3 T1/T3). Non-null ONLY when a NON-ADMIN's
   * receipt cost disagreed with the product's: they may not edit the price, so
   * the disagreement becomes a `cost-differs` register row instead of a prompt.
   * The subject is assembled HERE (this is where the actor's rights are known)
   * and WRITTEN by the caller, because the exceptions write boundary allows only
   * routes to reach the writer.
   */
  costDiffers: CostDiffersSubject | null;
};

/**
 * Graduate a pre-staging item into real inventory.
 *
 * Runs inside a single `prisma.$transaction`, with the outer call wrapped in a
 * deadlock/lock-timeout retry (E6) in addition to the optimistic-lock retry that
 * lives inside `applyStockDelta`'s callers.
 *
 * W1-3a (pack REV-3 T2) — THE ROW IS THE TRUTH. The booked quantity is read
 * from the staging row inside this transaction; the REQUEST no longer carries
 * one. The defect that motivated the change: the dialog pre-filled its
 * "counted" field from the EXPECTED quantity and the server booked the request,
 * so counting 46 and pressing Confirm booked 50 — and the audit line agreed
 * with the request, not with the dock.
 *
 * Steps (spec: "Graduation transaction"):
 *   1. Concurrency claim: atomic `updateMany WHERE status='RECEIVED'`. count===0 -> 409.
 *      This is the double-stock guard so two people can't graduate the same box.
 *   2. Read the claimed row: countedQuantity NULL -> 422 (and the claim rolls
 *      back with the transaction, so the item stays RECEIVED and can be counted
 *      afterwards); 0 -> 422 ("a zero count is a Discard, not a stock-in").
 *   3. A linked shipment must not be CANCELLED (409) — legal on OPEN and CLOSED
 *      alike, the stranded-line amendment (pack REV-3 T4).
 *   4. Resolve the product:
 *      - "existing": load it, assert it exists and is not soft-deleted (400 otherwise).
 *        approvalStatus is left UNCHANGED (restocking one's own pending product keeps
 *        it pending).
 *      - "new": create a product mirroring POST /api/products exactly, plus
 *        approvalStatus (APPROVED for admins, PENDING_REVIEW otherwise) and createdBy.
 *   5. Stock-in via the shared `applyStockDelta(tx, …)` core (+bookedQuantity),
 *      stamped with the receipt's inboundShipmentId and unit cost (T3).
 *   6. D-COST (T3): the receipt's cost meets the catalog's. A product with NO
 *      cost gets one, audited; a product whose cost DISAGREES is never rewritten
 *      here — the disagreement leaves as a prompt (admin) or as a register-row
 *      subject for the caller (everyone else).
 *   7. Finalize the staging item: resolvedProductId. The count is NOT rewritten —
 *      an override changes what the LEDGER books, never what the dock reported.
 *
 * Returns { productId, approvalStatus, locationId, countedQuantity,
 * bookedQuantity, receiptCost, costPrompt }.
 *
 * LOCK-ORDER NOTE: this path takes the staging row's lock and then the
 * shipment's; the count endpoint takes them the other way round. Two people
 * counting and graduating the SAME item at the same instant can therefore
 * deadlock — which `withDeadlockRetry` below re-runs, and which the loser's 409
 * settles anyway.
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

      // 2. THE ROW IS THE TRUTH (pack REV-3 T2). Reading AFTER the claim is
      //    load-bearing: the claim's current read serializes this transaction
      //    against a concurrent count, so the value below is the latest
      //    committed one rather than a snapshot taken before it.
      const row = await tx.stagingItem.findUnique({
        where: { id: stagingItemId },
        select: { countedQuantity: true, shipmentId: true, unitCostCents: true },
      });
      if (!row) {
        // Unreachable: the claim above updated exactly this row in this tx.
        // Defended rather than non-null-asserted, so a future refactor that
        // moves the claim can't turn this into a null-deref.
        throw new AppError('Staging item not found', 'NOT_FOUND', 404);
      }

      if (row.countedQuantity === null) {
        // The whole transaction unwinds on this throw, so the claim above is
        // rolled back and the item is still RECEIVED: count it, then graduate.
        throw new AppError(
          'Count this item before graduating it — graduation books the counted quantity, never a typed one',
          'VALIDATION_ERROR',
          422
        );
      }
      if (row.countedQuantity === 0) {
        throw new AppError(
          'A zero count is a Discard, not a stock-in',
          'VALIDATION_ERROR',
          422
        );
      }

      // 3. A settled shipment refuses its lines only when it was CANCELLED —
      //    a CANCELLED shipment asserts the goods never arrived. CLOSED still
      //    graduates (closing means receiving is finished, not that these boxes
      //    may never become stock).
      if (row.shipmentId !== null) {
        await claimShipmentForGraduation(tx, row.shipmentId);
      }

      const countedQuantity = row.countedQuantity;
      // Both-or-neither is enforced at the route (assertGraduateOverridePair);
      // requiring both HERE too means a half-pair that somehow reached this
      // helper books the count, never a half-explained number.
      const override: GraduateOverride | null =
        body.overrideQuantity !== undefined && body.overrideReason !== undefined
          ? { quantity: body.overrideQuantity, reason: body.overrideReason }
          : null;
      const bookedQuantity = override ? override.quantity : countedQuantity;

      // 4. Resolve the product.
      let productId: number;
      let approvalStatus: 'APPROVED' | 'PENDING_REVIEW';
      let created = false;
      // Phase C (P-C3): the frozen "cost at receipt" for the STOCK_IN row, captured
      // from whichever branch's product row is in scope BEFORE the stock write (no
      // single `product` variable spans both branches).
      // Lane 6 (R-D3): nullable so an unknown cost graduates as NULL, not 0.
      let costPriceAtGraduation: Prisma.Decimal | number | null;

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
        // R-D3: preserve NULL = "cost unknown" (mirror POST /api/products); an
        // explicit 0 = free is kept; negative defended to null.
        const costPrice =
          f.costPrice === undefined || f.costPrice === null
            ? null
            : f.costPrice >= 0
              ? f.costPrice
              : null;
        // W0-RETAIL: preserve NULL = "retail unknown" (mirror POST /api/products);
        // an explicit 0 = free is kept; negative defended to null.
        const retailPrice =
          f.retailPrice === undefined || f.retailPrice === null
            ? null
            : f.retailPrice >= 0
              ? f.retailPrice
              : null;

        const created_ = await tx.product.create({
          data: {
            name,
            baseName,
            variant,
            unit,
            numericValue,
            quantity: 0,
            location: body.locationId,
            // NULL = inherit the system default (R-L13); mirror POST /api/products
            // — stop materializing 10 so the configurable default governs. An
            // omitted field writes NULL explicitly (no low-stock predicate here).
            lowStockThreshold: f.lowStockThreshold === undefined ? null : f.lowStockThreshold,
            costPrice,
            retailPrice,
            approvalStatus: actor.isAdmin ? 'APPROVED' : 'PENDING_REVIEW',
            createdBy: actor.id,
          },
        });
        productId = created_.id;
        approvalStatus = created_.approvalStatus as 'APPROVED' | 'PENDING_REVIEW';
        costPriceAtGraduation = created_.costPrice;
        created = true;
      }

      // T3 THREADING — the receipt's unit cost. The LINE cost wins when the
      // receipt recorded one; a NULL line cost falls back to the product's
      // standing costPrice (today's behavior), and the response states which.
      //
      // 0 -> NULL DIVERGENCE, DISCLOSED: a line cost of 0 STAYS 0 on the staging
      // row (it is a recorded fact about the receipt) but reaches the LEDGER as
      // NULL — the house 0->null convention `centsFromCostPrice` already applies
      // to a 0 costPrice, because a receipt frozen at "free" carries no
      // representable unit cost and a stored 0 would read as a real $0.00 to
      // every valuation surface. It does NOT fall through to the product cost
      // either: the line said something, and inventing a different number would
      // be worse than admitting we have none.
      const receiptCost: GraduateReceiptCost =
        row.unitCostCents === null
          ? { unitCostCents: centsFromCostPrice(costPriceAtGraduation), source: 'product' }
          : { unitCostCents: row.unitCostCents > 0 ? row.unitCostCents : null, source: 'line' };

      // 5. Stock-in via the shared core (log + product_locations upsert + loc-1
      //    mirror). Phase C: graduation is a receipt, so the ledger row is STOCK_IN
      //    with unitCostCents frozen at write (P-C3, via the ER-C2 helper — never
      //    re-derive) and the caller's batchId joining it to the
      //    STAGING_GRADUATE/PRODUCT_CREATE events (P-C1). W1-3a adds the
      //    inboundShipmentId soft ref, taken from the ROW (seam S4) — this is the
      //    join that makes "which receipt did these units come in on?" answerable.
      await applyStockDelta(tx, {
        userId: actor.id,
        productId,
        locationId: body.locationId,
        delta: bookedQuantity,
        logType: inventory_logs_logType.STOCK_IN,
        unitCostCents: receiptCost.unitCostCents,
        inboundShipmentId: row.shipmentId,
        batchId,
      });

      // 6. D-COST (pack REV-3 T3). Deliberately AFTER the ledger write: the
      //    STOCK_IN row is frozen at the receipt's cost no matter what happens
      //    next, so what the ledger booked never depends on how the catalog
      //    disagreement is settled. The mutation is the ONLY thing allowed to
      //    write a cost from here, and it writes only into a NULL.
      const costOutcome = await applyReceiptCost(tx, {
        productId,
        receiptCents: receiptCost.unitCostCents,
        actor,
        batchId,
      });

      // A disagreement goes to whoever can act on it, and nowhere else. An admin
      // is prompted (they can call the real product PUT); anybody else raises a
      // register row — never silent, never blocking the receipt.
      const differs = costOutcome.outcome === 'differs';
      const costPrompt: GraduateCostPrompt | null =
        differs && actor.isAdmin
          ? {
              productId,
              currentCents: costOutcome.currentCents,
              receiptCents: costOutcome.receiptCents as number,
            }
          : null;
      const costDiffers: CostDiffersSubject | null =
        differs && !actor.isAdmin
          ? {
              productId,
              stagingItemId,
              currentCents: costOutcome.currentCents,
              receiptCents: costOutcome.receiptCents as number,
            }
          : null;

      // 7. Finalize the staging item. countedQuantity is NOT written here: the
      //    count belongs to the count endpoint, and an override changes what the
      //    LEDGER books, never what the dock reported.
      await tx.stagingItem.update({
        where: { id: stagingItemId },
        data: {
          resolvedProductId: productId,
        },
      });

      // 8. Change-tracking (Task 10): emit the caller's correlated events from
      //    INSIDE this same transaction, so the graduation, the product-create,
      //    and any stock event share one batchId and commit/roll back together.
      //    A throw here (unrecordable change) aborts the entire graduation.
      //    W1-3b: the caller's exception-register writes ride this same hook —
      //    same transaction, same guarantee.
      if (onRecord) {
        await onRecord(tx, {
          productId,
          approvalStatus,
          locationId: body.locationId,
          countedQuantity,
          bookedQuantity,
          override,
          created,
          receiptCost,
          costPrompt,
          costDiffers,
        });
      }

      return {
        productId,
        approvalStatus,
        locationId: body.locationId,
        countedQuantity,
        bookedQuantity,
        receiptCost,
        costPrompt,
      };
    })
  );
}
