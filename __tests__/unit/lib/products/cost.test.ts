/**
 * @jest-environment node
 *
 * W1-3b — D-COST: `applyReceiptCost` (lib/products/cost.ts, contract pack REV-3 T3).
 *
 * The receiving dock is the only place in this product where a real, observed
 * unit cost enters the system. The rule the pack binds is narrow on purpose:
 *
 *   costPrice IS NULL   ->  FILL from the receipt, audited, in the caller's tx.
 *                           This is a RECEIVING act, legal for any approved user
 *                           (it is not a price edit — it is the first time
 *                           anybody knew the number).
 *   costPrice EXISTS    ->  NEVER written here. Equal is nothing; different is
 *                           reported UP (prompt for an admin, exception row for
 *                           everyone else) and settled through the REAL product
 *                           PUT, which has its own authorization.
 *
 * Everything below pins that asymmetry, plus the two conversions it rides on:
 * `centsFromCostPrice` (the house cents view of a stored Decimal, where 0 reads
 * as "no representable cost") and its inverse `costPriceFromCents`.
 *
 * Prisma is mocked (this repo has no test DB — canonical pattern:
 * __tests__/unit/lib/staging/graduate.test.ts). The assertions target the tx
 * calls, because "the row was written / was NOT written" is the contract.
 */

import { mockDeep, type DeepMockProxy } from 'jest-mock-extended';
import { Prisma } from '@prisma/client';

const mockRecordChange = jest.fn();
jest.mock('@/lib/change-tracking', () => ({
  __esModule: true,
  recordChange: (...args: unknown[]) => mockRecordChange(...args),
}));

import { applyReceiptCost, costPriceFromCents } from '@/lib/products/cost';
import { centsFromCostPrice } from '@/lib/inventory';

let tx: DeepMockProxy<Prisma.TransactionClient>;

const ACTOR = { id: 42 };

beforeEach(() => {
  tx = mockDeep<Prisma.TransactionClient>();
  mockRecordChange.mockReset();
  mockRecordChange.mockResolvedValue(undefined);
  tx.product.updateMany.mockResolvedValue({ count: 0 } as never);
});

describe('costPriceFromCents — the inverse of the house cents conversion', () => {
  it('round-trips through centsFromCostPrice', () => {
    for (const cents of [1, 50, 199, 1999, 123456, 2147483647]) {
      expect(centsFromCostPrice(costPriceFromCents(cents))).toBe(cents);
    }
  });

  it('produces a 2-decimal value (the products.costPrice column is Decimal(10,2))', () => {
    expect(costPriceFromCents(1999).toString()).toBe('19.99');
    expect(costPriceFromCents(5).toString()).toBe('0.05');
  });
});

describe('applyReceiptCost — fill-if-null', () => {
  it('fills a NULL costPrice from the receipt, as an atomic claim, for a NON-ADMIN actor', async () => {
    tx.product.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await applyReceiptCost(tx, {
      productId: 7,
      receiptCents: 1999,
      actor: ACTOR,
    });

    expect(result).toEqual({ outcome: 'filled', currentCents: null, receiptCents: 1999 });

    // The claim IS the guard: WHERE costPrice IS NULL, never a read-then-write.
    const claim = tx.product.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({ id: 7, costPrice: null });
    expect(String(claim.data.costPrice)).toBe('19.99');

    // No second opinion needed once the claim won.
    expect(tx.product.findUnique).not.toHaveBeenCalled();
  });

  it('audits the fill as PRODUCT_UPDATE on the CALLER tx, naming null -> the receipt value', async () => {
    tx.product.updateMany.mockResolvedValue({ count: 1 } as never);

    await applyReceiptCost(tx, { productId: 7, receiptCents: 1999, actor: ACTOR, batchId: 'B1' });

    expect(mockRecordChange).toHaveBeenCalledTimes(1);
    const [recordedTx, event] = mockRecordChange.mock.calls[0];
    expect(recordedTx).toBe(tx);
    expect(event).toMatchObject({
      actor: { userId: 42 },
      actionType: 'PRODUCT_UPDATE',
      entityType: 'PRODUCT',
      entityId: 7,
      changes: { costPrice: { from: null, to: 19.99 } },
      batchId: 'B1',
    });
    expect(event.details).toMatchObject({ source: 'receipt', receiptCents: 1999 });
  });
});

describe('applyReceiptCost — a costPrice that already exists is NEVER overwritten', () => {
  it('EQUAL: reports equal, writes nothing, records nothing', async () => {
    tx.product.updateMany.mockResolvedValue({ count: 0 } as never);
    tx.product.findUnique.mockResolvedValue({ costPrice: new Prisma.Decimal('19.99') } as never);

    const result = await applyReceiptCost(tx, {
      productId: 7,
      receiptCents: 1999,
      actor: ACTOR,
    });

    expect(result).toEqual({ outcome: 'equal', currentCents: 1999, receiptCents: 1999 });
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('DIFFERS: reports both numbers, writes nothing, records nothing', async () => {
    tx.product.updateMany.mockResolvedValue({ count: 0 } as never);
    tx.product.findUnique.mockResolvedValue({ costPrice: new Prisma.Decimal('12.00') } as never);

    const result = await applyReceiptCost(tx, {
      productId: 7,
      receiptCents: 1999,
      actor: ACTOR,
    });

    expect(result).toEqual({ outcome: 'differs', currentCents: 1200, receiptCents: 1999 });
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('a stored 0 is NOT a fillable null: it differs, and currentCents is reported as null', async () => {
    // The house cost conversion reads a stored 0 as "no representable cost"
    // (centsFromCostPrice), but the COLUMN is not NULL — so the fill claim finds
    // nothing to fill and the disagreement is reported truthfully rather than
    // papered over with a 0.
    tx.product.updateMany.mockResolvedValue({ count: 0 } as never);
    tx.product.findUnique.mockResolvedValue({ costPrice: new Prisma.Decimal('0') } as never);

    const result = await applyReceiptCost(tx, {
      productId: 7,
      receiptCents: 1999,
      actor: ACTOR,
    });

    expect(result).toEqual({ outcome: 'differs', currentCents: null, receiptCents: 1999 });
    expect(mockRecordChange).not.toHaveBeenCalled();
  });
});

describe('applyReceiptCost — nothing to say', () => {
  it('a receipt with NO representable cost touches the product not at all', async () => {
    const result = await applyReceiptCost(tx, {
      productId: 7,
      receiptCents: null,
      actor: ACTOR,
    });

    expect(result).toEqual({ outcome: 'no-receipt-cost', currentCents: null, receiptCents: null });
    expect(tx.product.updateMany).not.toHaveBeenCalled();
    expect(tx.product.findUnique).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('a product that vanished under the claim reports product-missing, not a crash', async () => {
    tx.product.updateMany.mockResolvedValue({ count: 0 } as never);
    tx.product.findUnique.mockResolvedValue(null as never);

    const result = await applyReceiptCost(tx, {
      productId: 7,
      receiptCents: 1999,
      actor: ACTOR,
    });

    expect(result).toEqual({
      outcome: 'product-missing',
      currentCents: null,
      receiptCents: 1999,
    });
    expect(mockRecordChange).not.toHaveBeenCalled();
  });
});
