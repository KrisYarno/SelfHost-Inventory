import { Prisma } from '@prisma/client';
import { centsFromCostPrice } from '@/lib/inventory';
import { recordChange } from '@/lib/change-tracking';

/**
 * D-COST — the receipt's cost meets the catalog's cost (contract pack REV-3 T3).
 *
 * The receiving dock is where a real, observed unit cost enters this system, and
 * the rule the pack binds is deliberately narrow:
 *
 *   costPrice IS NULL   ->  FILL it from the receipt, audited, inside the
 *                           caller's transaction. This is a RECEIVING act, legal
 *                           for any approved user — it is not a price edit, it is
 *                           the first time anybody knew the number at all.
 *   costPrice EXISTS    ->  NEVER written here. Equal is nothing to say; a
 *                           disagreement is REPORTED to the caller and settled
 *                           somewhere with its own authorization (the real
 *                           product PUT for an admin, the `cost-differs` register
 *                           row for everybody else). Silently adopting a receipt
 *                           price would rewrite the valuation of stock that is
 *                           already on the shelf.
 *
 * TX-SCOPED: no `prisma` import of its own. Every write joins the CALLER's
 * transaction, which is what makes "the cost fill and the stock-in commit
 * together, or neither does" true.
 */

/**
 * What happened, named. `differs` is the only outcome that asks anything of the
 * caller; the rest are already settled by the time this returns.
 */
export type ReceiptCostOutcome =
  /** costPrice was NULL and this receipt filled it (a PRODUCT_UPDATE was recorded). */
  | 'filled'
  /** The standing cost already equals the receipt's. Nothing written. */
  | 'equal'
  /** They disagree. NOTHING written — the caller decides how to surface it. */
  | 'differs'
  /** The receipt carries no representable unit cost; the product was not touched. */
  | 'no-receipt-cost'
  /** The product vanished (or never existed) under the claim. Nothing written. */
  | 'product-missing';

export type ApplyReceiptCostResult = {
  outcome: ReceiptCostOutcome;
  /**
   * The product's standing cost IN CENTS, through the house conversion — so a
   * stored 0 reads as `null` ("no representable cost") exactly as it does on
   * every valuation surface, rather than as a real $0.00.
   */
  currentCents: number | null;
  receiptCents: number | null;
};

export type ApplyReceiptCostArgs = {
  productId: number;
  /** The receipt's frozen unit cost. NULL = the receipt has nothing to say. */
  receiptCents: number | null;
  /** The receiving user. Any APPROVED user may fill a null cost (pack T3). */
  actor: { id: number };
  /** Joins the PRODUCT_UPDATE line to the caller's event fan-out (P-C1). */
  batchId?: string | null;
};

/**
 * INT cents -> the `products.costPrice` Decimal(10,2) the column holds. The exact
 * inverse of `centsFromCostPrice` (lib/inventory.ts), and the only place cents
 * are turned back into a stored price: Decimal arithmetic rather than `/ 100`, so
 * the written value is the cents value and not a binary approximation of it.
 */
export function costPriceFromCents(cents: number): Prisma.Decimal {
  return new Prisma.Decimal(cents).dividedBy(100);
}

/**
 * Apply a receipt's unit cost to a product. Returns what happened; writes only in
 * the `filled` case.
 *
 * The fill is an atomic CLAIM (`updateMany WHERE costPrice IS NULL`), never a
 * read-then-write: two dock workers graduating boxes of the same new product at
 * the same instant must produce exactly one fill, and the loser must see the
 * value that won rather than overwrite it.
 */
export async function applyReceiptCost(
  tx: Prisma.TransactionClient,
  args: ApplyReceiptCostArgs,
): Promise<ApplyReceiptCostResult> {
  const { productId, receiptCents, actor, batchId } = args;

  // A receipt that carries no representable cost has nothing to contribute — and
  // must not be allowed to "fill" a null cost with a null, or to read as a
  // disagreement with whatever is stored.
  if (receiptCents === null) {
    return { outcome: 'no-receipt-cost', currentCents: null, receiptCents: null };
  }

  const claim = await tx.product.updateMany({
    where: { id: productId, costPrice: null },
    data: { costPrice: costPriceFromCents(receiptCents) },
  });

  if (claim.count > 0) {
    // A cost that was unknown is now known, and WHO made it known is part of the
    // record: this is a real change to the catalog, audited like any other.
    await recordChange(tx, {
      actor: { userId: actor.id },
      actionType: 'PRODUCT_UPDATE',
      entityType: 'PRODUCT',
      entityId: productId,
      action: `Set product ${productId} cost from a receipt`,
      changes: { costPrice: { from: null, to: receiptCents / 100 } },
      details: { source: 'receipt', receiptCents },
      batchId: batchId ?? undefined,
    });
    return { outcome: 'filled', currentCents: null, receiptCents };
  }

  // The claim matched nothing: either the product already has a cost, or it is
  // gone. Only NOW is a read worth taking.
  const existing = await tx.product.findUnique({
    where: { id: productId },
    select: { costPrice: true },
  });
  if (!existing) {
    return { outcome: 'product-missing', currentCents: null, receiptCents };
  }

  const currentCents = centsFromCostPrice(existing.costPrice);
  return {
    outcome: currentCents === receiptCents ? 'equal' : 'differs',
    currentCents,
    receiptCents,
  };
}
