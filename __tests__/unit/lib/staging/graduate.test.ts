/**
 * @jest-environment node
 *
 * Unit tests for `graduateStagingItem` (lib/staging/graduate.ts).
 *
 * This repo does NOT use a real test DB. Prisma is mocked with jest-mock-extended
 * (canonical pattern: __tests__/unit/fulfillment-concurrency.test.ts). We:
 *   - mock `@/lib/prisma` default export and drive `$transaction` by invoking its
 *     callback with a mockDeep<Prisma.TransactionClient>() `tx`;
 *   - mock `@/lib/inventory` so `applyStockDelta` is a spy (assert it's called with
 *     the right delta) and `withDeadlockRetry` just runs its fn once.
 *
 * W1-3a (contract pack REV-3 T2/T3) moved the booked quantity OFF the request and
 * ONTO the row, so these tests now drive `tx.stagingItem.findUnique` as the source
 * of truth. `lib/shipments/lifecycle.ts` is deliberately NOT mocked — the CANCELLED
 * shipment pin has to prove the real `claimShipmentForGraduation` is wired, since
 * it shipped exported-but-uncalled in W1-2b.
 *
 * Assertions target the mocked tx calls:
 *   - the atomic claim: tx.stagingItem.updateMany WHERE { id, status: 'RECEIVED' };
 *   - the ROW's countedQuantity is what reaches applyStockDelta's delta;
 *   - NULL / 0 counts -> 422, with the claim rolled back (the tx throws);
 *   - new-product branch -> tx.product.create with approvalStatus + createdBy;
 *   - existing branch -> tx.product.findFirst, no status change;
 *   - finalize -> tx.stagingItem.update writes resolvedProductId and NOTHING else.
 */

import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended';
import { Prisma } from '@prisma/client';

jest.mock('@/lib/prisma', () => {
  const { mockDeep: md } = require('jest-mock-extended');
  return { __esModule: true, default: md() };
});

const mockApplyStockDelta = jest.fn();
jest.mock('@/lib/inventory', () => ({
  __esModule: true,
  applyStockDelta: (...args: any[]) => mockApplyStockDelta(...args),
  // run the fn once; the deadlock-retry behavior itself is covered in lib/inventory tests
  withDeadlockRetry: (fn: () => Promise<any>) => fn(),
  // Phase C (Task 4): graduate.ts now freezes STOCK_IN unitCostCents via the real
  // ER-C2 helper — provide it unmocked so the conversion runs.
  centsFromCostPrice: jest.requireActual('@/lib/inventory').centsFromCostPrice,
}));

import prisma from '@/lib/prisma';
import { graduateStagingItem } from '@/lib/staging/graduate';
import { AppError } from '@/lib/error-handling';

const getMockPrisma = () => prisma as unknown as DeepMockProxy<typeof prisma>;

let mockTx: DeepMockProxy<Prisma.TransactionClient>;

/** The staging row the claim locks. Counted 12, unlinked, no line cost. */
function stagingRow(overrides: Record<string, unknown> = {}) {
  return {
    countedQuantity: 12,
    shipmentId: null,
    unitCostCents: null,
    ...overrides,
  };
}

function setupTransaction() {
  mockTx = mockDeep<Prisma.TransactionClient>();
  getMockPrisma().$transaction.mockImplementation(async (cb: any) => cb(mockTx));
  // default: claim succeeds, row is counted
  mockTx.stagingItem.updateMany.mockResolvedValue({ count: 1 } as any);
  mockTx.stagingItem.update.mockResolvedValue({} as any);
  mockTx.stagingItem.findUnique.mockResolvedValue(stagingRow() as any);
  mockApplyStockDelta.mockResolvedValue({ log: { id: 1 }, newVersion: 1 });
}

const newFields = {
  baseName: 'Test Peptide',
  variant: '10mg',
  unit: 'mg',
  numericValue: 10,
  lowStockThreshold: 5,
  costPrice: 1.5,
  retailPrice: 3,
  locationId: 1,
};

const EXISTING = { mode: 'existing', productId: 7, locationId: 1 } as any;

beforeEach(() => {
  mockReset(getMockPrisma());
  mockApplyStockDelta.mockReset();
  setupTransaction();
});

describe('graduateStagingItem — concurrency claim', () => {
  it('throws a 409 AppError when the claim affects 0 rows (already graduated/discarded)', async () => {
    mockTx.stagingItem.updateMany.mockResolvedValue({ count: 0 } as any);

    await expect(
      graduateStagingItem(99, EXISTING, { id: 42, isAdmin: false })
    ).rejects.toMatchObject({ statusCode: 409 });

    // verify it's specifically an AppError
    await expect(
      graduateStagingItem(99, EXISTING, { id: 42, isAdmin: false })
    ).rejects.toBeInstanceOf(AppError);

    // no row read / product resolution / stock-in once the claim fails
    expect(mockTx.stagingItem.findUnique).not.toHaveBeenCalled();
    expect(mockTx.product.findFirst).not.toHaveBeenCalled();
    expect(mockApplyStockDelta).not.toHaveBeenCalled();
  });

  it('claims with WHERE { id, status: RECEIVED } and stamps graduatedBy/At', async () => {
    mockTx.product.findFirst.mockResolvedValue({
      id: 7,
      approvalStatus: 'APPROVED',
      deletedAt: null,
    } as any);

    await graduateStagingItem(55, EXISTING, { id: 42, isAdmin: false });

    expect(mockTx.stagingItem.updateMany).toHaveBeenCalledTimes(1);
    const claimArg = mockTx.stagingItem.updateMany.mock.calls[0][0] as any;
    expect(claimArg.where).toEqual({ id: 55, status: 'RECEIVED' });
    expect(claimArg.data.status).toBe('GRADUATED');
    expect(claimArg.data.graduatedBy).toBe(42);
    expect(claimArg.data.graduatedAt).toBeInstanceOf(Date);
  });

  it('reads the row AFTER the claim (the claim serializes it against a concurrent count)', async () => {
    mockTx.product.findFirst.mockResolvedValue({ id: 7, approvalStatus: 'APPROVED', deletedAt: null } as any);
    const order: string[] = [];
    mockTx.stagingItem.updateMany.mockImplementation((async () => {
      order.push('claim');
      return { count: 1 };
    }) as any);
    mockTx.stagingItem.findUnique.mockImplementation((async () => {
      order.push('read');
      return stagingRow();
    }) as any);

    await graduateStagingItem(55, EXISTING, { id: 42, isAdmin: false });

    expect(order).toEqual(['claim', 'read']);
  });
});

// ---------------------------------------------------------------------------
// THE DEFECT KILL (pack REV-3 T2): the ROW is the booked quantity.
// ---------------------------------------------------------------------------

describe('graduateStagingItem — the row is the truth (count-46-book-50)', () => {
  beforeEach(() => {
    mockTx.product.findFirst.mockResolvedValue({
      id: 7,
      approvalStatus: 'APPROVED',
      deletedAt: null,
      costPrice: null,
    } as any);
  });

  it('books the ROW count (46) and IGNORES a quantity smuggled into the body (50)', async () => {
    mockTx.stagingItem.findUnique.mockResolvedValue(stagingRow({ countedQuantity: 46 }) as any);

    const result = await graduateStagingItem(
      55,
      { ...EXISTING, countedQuantity: 50 } as any,
      { id: 42, isAdmin: false }
    );

    expect(mockApplyStockDelta.mock.calls[0][1].delta).toBe(46);
    expect(result.countedQuantity).toBe(46);
    expect(result.bookedQuantity).toBe(46);
  });

  it('returns { countedQuantity, bookedQuantity } alongside the existing fields', async () => {
    mockTx.stagingItem.findUnique.mockResolvedValue(stagingRow({ countedQuantity: 12 }) as any);

    const result = await graduateStagingItem(55, { ...EXISTING, locationId: 3 }, { id: 42, isAdmin: false });

    expect(result).toEqual({
      productId: 7,
      approvalStatus: 'APPROVED',
      locationId: 3,
      countedQuantity: 12,
      bookedQuantity: 12,
      receiptCost: { unitCostCents: null, source: 'product' },
    });
  });

  it('NULL count -> 422 VALIDATION_ERROR, and the transaction (hence the claim) rolls back', async () => {
    mockTx.stagingItem.findUnique.mockResolvedValue(stagingRow({ countedQuantity: null }) as any);

    const err = await graduateStagingItem(55, EXISTING, { id: 42, isAdmin: false }).catch((e) => e);

    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
    expect(err.message).toMatch(/count this item before graduating/i);
    // The claim WAS attempted (that is what makes it a rollback, not a pre-check)…
    expect(mockTx.stagingItem.updateMany).toHaveBeenCalledTimes(1);
    // …and nothing after it ran, so the row stays RECEIVED once the tx unwinds.
    expect(mockApplyStockDelta).not.toHaveBeenCalled();
    expect(mockTx.stagingItem.update).not.toHaveBeenCalled();
    expect(mockTx.product.findFirst).not.toHaveBeenCalled();
  });

  it('the NULL-count throw escapes $transaction (Prisma rolls back on a thrown callback)', async () => {
    mockTx.stagingItem.findUnique.mockResolvedValue(stagingRow({ countedQuantity: null }) as any);
    let escaped = false;
    getMockPrisma().$transaction.mockImplementation(async (cb: any) => {
      try {
        return await cb(mockTx);
      } catch (e) {
        escaped = true; // == ROLLBACK in the real client
        throw e;
      }
    });

    await expect(graduateStagingItem(55, EXISTING, { id: 42, isAdmin: false })).rejects.toBeInstanceOf(AppError);
    expect(escaped).toBe(true);
  });

  it('a 0 count -> 422 "a zero count is a Discard, not a stock-in"', async () => {
    mockTx.stagingItem.findUnique.mockResolvedValue(stagingRow({ countedQuantity: 0 }) as any);

    const err = await graduateStagingItem(55, EXISTING, { id: 42, isAdmin: false }).catch((e) => e);

    expect(err).toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
    expect(err.message).toMatch(/zero count is a discard/i);
    expect(mockApplyStockDelta).not.toHaveBeenCalled();
  });

  it('finalize writes resolvedProductId ONLY — the staging row keeps its true count', async () => {
    mockTx.stagingItem.findUnique.mockResolvedValue(stagingRow({ countedQuantity: 46 }) as any);

    await graduateStagingItem(55, EXISTING, { id: 42, isAdmin: false });

    const finalArg = mockTx.stagingItem.update.mock.calls[0][0] as any;
    expect(finalArg.where).toEqual({ id: 55 });
    expect(finalArg.data).toEqual({ resolvedProductId: 7 });
    expect(finalArg.data).not.toHaveProperty('countedQuantity');
  });
});

// ---------------------------------------------------------------------------
// The audited override (pack REV-3 T2).
// ---------------------------------------------------------------------------

describe('graduateStagingItem — the audited override', () => {
  beforeEach(() => {
    mockTx.product.findFirst.mockResolvedValue({
      id: 7,
      approvalStatus: 'APPROVED',
      deletedAt: null,
      costPrice: null,
    } as any);
    mockTx.stagingItem.findUnique.mockResolvedValue(stagingRow({ countedQuantity: 46 }) as any);
  });

  it('books the override, reports BOTH quantities, and leaves the row count alone', async () => {
    const result = await graduateStagingItem(
      55,
      { ...EXISTING, overrideQuantity: 40, overrideReason: 'six vials broken in transit' },
      { id: 42, isAdmin: false }
    );

    expect(mockApplyStockDelta.mock.calls[0][1].delta).toBe(40);
    expect(result.countedQuantity).toBe(46);
    expect(result.bookedQuantity).toBe(40);
    expect((mockTx.stagingItem.update.mock.calls[0][0] as any).data).toEqual({ resolvedProductId: 7 });
  });

  it('hands onRecord the override so the caller can write GRADUATE_OVERRIDE', async () => {
    const onRecord = jest.fn();
    await graduateStagingItem(
      55,
      { ...EXISTING, overrideQuantity: 40, overrideReason: 'six vials broken in transit' },
      { id: 42, isAdmin: false },
      { onRecord }
    );

    const [, ctx] = onRecord.mock.calls[0];
    expect(ctx).toMatchObject({
      countedQuantity: 46,
      bookedQuantity: 40,
      override: { quantity: 40, reason: 'six vials broken in transit' },
    });
  });

  it('no override -> ctx.override is null and booked === counted', async () => {
    const onRecord = jest.fn();
    await graduateStagingItem(55, EXISTING, { id: 42, isAdmin: false }, { onRecord });

    const [, ctx] = onRecord.mock.calls[0];
    expect(ctx.override).toBeNull();
    expect(ctx.bookedQuantity).toBe(46);
    expect(ctx.countedQuantity).toBe(46);
  });

  it('a lone overrideQuantity (schema-illegal) is NOT honoured by the helper', async () => {
    // Defence in depth: the route rejects the half-pair at 400, but if one ever
    // reached here the count — not the half-override — is what gets booked.
    await graduateStagingItem(55, { ...EXISTING, overrideQuantity: 40 } as any, { id: 42, isAdmin: false });
    expect(mockApplyStockDelta.mock.calls[0][1].delta).toBe(46);
  });

  it('a zero row count still 422s even with an override present', async () => {
    mockTx.stagingItem.findUnique.mockResolvedValue(stagingRow({ countedQuantity: 0 }) as any);

    await expect(
      graduateStagingItem(
        55,
        { ...EXISTING, overrideQuantity: 40, overrideReason: 'the box was empty but I want stock' },
        { id: 42, isAdmin: false }
      )
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

// ---------------------------------------------------------------------------
// The shipment seam (pack REV-3 T4 amendment) — claimShipmentForGraduation is
// REAL here, so these pins prove the W1-2b helper is finally wired.
// ---------------------------------------------------------------------------

describe('graduateStagingItem — the linked-shipment guard', () => {
  const SHIPMENT = 'ckshipment00000000000000a';

  beforeEach(() => {
    mockTx.product.findFirst.mockResolvedValue({
      id: 7,
      approvalStatus: 'APPROVED',
      deletedAt: null,
      costPrice: null,
    } as any);
    mockTx.stagingItem.findUnique.mockResolvedValue(
      stagingRow({ countedQuantity: 12, shipmentId: SHIPMENT }) as any
    );
  });

  /** claimShipmentIn tries each allowed status in order; `winner` is the one that matches. */
  function shipmentInStatus(winner: 'OPEN' | 'CLOSED' | null, actual?: string) {
    mockTx.inboundShipment.updateMany.mockImplementation((async (args: any) => ({
      count: args.where.status === winner ? 1 : 0,
    })) as any);
    mockTx.inboundShipment.findUnique.mockResolvedValue(
      actual ? ({ id: SHIPMENT, status: actual } as any) : null
    );
  }

  it('an OPEN shipment graduates', async () => {
    shipmentInStatus('OPEN');
    await graduateStagingItem(55, EXISTING, { id: 42, isAdmin: false });
    expect(mockApplyStockDelta).toHaveBeenCalledTimes(1);
  });

  it('a CLOSED shipment ALSO graduates (the stranded-line amendment)', async () => {
    shipmentInStatus('CLOSED');
    await graduateStagingItem(55, EXISTING, { id: 42, isAdmin: false });
    expect(mockApplyStockDelta).toHaveBeenCalledTimes(1);
    // Both statuses were claimed in order — OPEN first, then CLOSED.
    const tried = mockTx.inboundShipment.updateMany.mock.calls.map((c: any) => c[0].where.status);
    expect(tried).toEqual(['OPEN', 'CLOSED']);
  });

  it('a CANCELLED shipment -> 409, nothing booked', async () => {
    shipmentInStatus(null, 'CANCELLED');

    const err = await graduateStagingItem(55, EXISTING, { id: 42, isAdmin: false }).catch((e) => e);

    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ statusCode: 409 });
    expect(err.message).toMatch(/cannot be graduated/i);
    expect(mockApplyStockDelta).not.toHaveBeenCalled();
  });

  it('an unlinked item never touches the shipment table', async () => {
    mockTx.stagingItem.findUnique.mockResolvedValue(stagingRow({ countedQuantity: 12 }) as any);
    await graduateStagingItem(55, EXISTING, { id: 42, isAdmin: false });
    expect(mockTx.inboundShipment.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T3 threading: the ledger row's attribution + receipt cost.
// ---------------------------------------------------------------------------

describe('graduateStagingItem — the ledger row (T3 / seam S4)', () => {
  const SHIPMENT = 'ckshipment00000000000000a';

  function openShipment() {
    mockTx.inboundShipment.updateMany.mockImplementation((async (args: any) => ({
      count: args.where.status === 'OPEN' ? 1 : 0,
    })) as any);
  }

  function existingProduct(costPrice: number | null) {
    mockTx.product.findFirst.mockResolvedValue({
      id: 7,
      approvalStatus: 'APPROVED',
      deletedAt: null,
      costPrice,
    } as any);
  }

  it('stamps inboundShipmentId from the ROW (not the request)', async () => {
    existingProduct(null);
    openShipment();
    mockTx.stagingItem.findUnique.mockResolvedValue(
      stagingRow({ countedQuantity: 5, shipmentId: SHIPMENT }) as any
    );

    await graduateStagingItem(55, EXISTING, { id: 42, isAdmin: false });

    expect(mockApplyStockDelta.mock.calls[0][1]).toMatchObject({
      logType: 'STOCK_IN',
      inboundShipmentId: SHIPMENT,
    });
  });

  it('an unlinked item stamps inboundShipmentId null (present, explicitly empty)', async () => {
    existingProduct(null);
    await graduateStagingItem(55, EXISTING, { id: 42, isAdmin: false });
    expect(mockApplyStockDelta.mock.calls[0][1].inboundShipmentId).toBeNull();
  });

  it('the LINE cost wins over the product cost', async () => {
    existingProduct(9.99);
    mockTx.stagingItem.findUnique.mockResolvedValue(
      stagingRow({ countedQuantity: 5, unitCostCents: 1234 }) as any
    );

    const result = await graduateStagingItem(55, EXISTING, { id: 42, isAdmin: false });

    expect(mockApplyStockDelta.mock.calls[0][1].unitCostCents).toBe(1234);
    expect(result.receiptCost).toEqual({ unitCostCents: 1234, source: 'line' });
  });

  it('a NULL line cost falls back to product.costPrice (T3 fallback, stated in the response)', async () => {
    existingProduct(9.99);
    mockTx.stagingItem.findUnique.mockResolvedValue(
      stagingRow({ countedQuantity: 5, unitCostCents: null }) as any
    );

    const result = await graduateStagingItem(55, EXISTING, { id: 42, isAdmin: false });

    expect(mockApplyStockDelta.mock.calls[0][1].unitCostCents).toBe(999);
    expect(result.receiptCost).toEqual({ unitCostCents: 999, source: 'product' });
  });

  it('a line cost of 0 reaches the LEDGER as NULL (house 0->null), still sourced "line"', async () => {
    existingProduct(9.99);
    mockTx.stagingItem.findUnique.mockResolvedValue(
      stagingRow({ countedQuantity: 5, unitCostCents: 0 }) as any
    );

    const result = await graduateStagingItem(55, EXISTING, { id: 42, isAdmin: false });

    // NOT 0, and NOT the product's 999 — a 0 line cost is a recorded fact that
    // carries no representable unit cost, so it does not fall through either.
    expect(mockApplyStockDelta.mock.calls[0][1].unitCostCents).toBeNull();
    expect(result.receiptCost).toEqual({ unitCostCents: null, source: 'line' });
  });

  it('NULL line cost AND NULL product cost -> NULL, sourced "product"', async () => {
    existingProduct(null);
    const result = await graduateStagingItem(55, EXISTING, { id: 42, isAdmin: false });
    expect(mockApplyStockDelta.mock.calls[0][1].unitCostCents).toBeNull();
    expect(result.receiptCost).toEqual({ unitCostCents: null, source: 'product' });
  });

  it('the new-product branch falls back to the product it just created', async () => {
    mockTx.product.create.mockResolvedValue({
      id: 101,
      approvalStatus: 'PENDING_REVIEW',
      costPrice: 2.5,
    } as any);

    const result = await graduateStagingItem(
      55,
      { mode: 'new', productFields: newFields, locationId: 1 } as any,
      { id: 42, isAdmin: false }
    );

    expect(mockApplyStockDelta.mock.calls[0][1].unitCostCents).toBe(250);
    expect(result.receiptCost).toEqual({ unitCostCents: 250, source: 'product' });
  });
});

describe('graduateStagingItem — existing product (restock)', () => {
  it('restocks an existing product, leaves approvalStatus unchanged, applies +row-count', async () => {
    mockTx.product.findFirst.mockResolvedValue({
      id: 7,
      approvalStatus: 'PENDING_REVIEW',
      deletedAt: null,
    } as any);

    const result = await graduateStagingItem(
      55,
      { mode: 'existing', productId: 7, locationId: 3 } as any,
      { id: 42, isAdmin: false }
    );

    // resolved by findFirst with deletedAt: null
    const findArg = mockTx.product.findFirst.mock.calls[0][0] as any;
    expect(findArg.where).toEqual({ id: 7, deletedAt: null });
    // never creates a product on the existing path
    expect(mockTx.product.create).not.toHaveBeenCalled();

    // stock-in delta === the ROW's countedQuantity, at the requested location
    expect(mockApplyStockDelta).toHaveBeenCalledTimes(1);
    const [txArg, deltaArgs] = mockApplyStockDelta.mock.calls[0];
    expect(txArg).toBe(mockTx);
    expect(deltaArgs).toMatchObject({
      userId: 42,
      productId: 7,
      locationId: 3,
      delta: 12,
    });

    // restocking does NOT flip status
    expect(result).toMatchObject({
      productId: 7,
      approvalStatus: 'PENDING_REVIEW',
      locationId: 3,
      countedQuantity: 12,
      bookedQuantity: 12,
    });
  });

  it('throws a 400 AppError when the existing target is missing/soft-deleted', async () => {
    mockTx.product.findFirst.mockResolvedValue(null);

    await expect(
      graduateStagingItem(55, EXISTING, { id: 42, isAdmin: false })
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(mockApplyStockDelta).not.toHaveBeenCalled();
  });
});

describe('graduateStagingItem — new product (provisional)', () => {
  it('non-admin creates a PENDING_REVIEW product with createdBy, then stocks in', async () => {
    mockTx.product.create.mockResolvedValue({
      id: 101,
      approvalStatus: 'PENDING_REVIEW',
    } as any);
    mockTx.stagingItem.findUnique.mockResolvedValue(stagingRow({ countedQuantity: 8 }) as any);

    const result = await graduateStagingItem(
      55,
      { mode: 'new', productFields: newFields, locationId: 1 } as any,
      { id: 42, isAdmin: false }
    );

    expect(mockTx.product.create).toHaveBeenCalledTimes(1);
    const data = (mockTx.product.create.mock.calls[0][0] as any).data;
    expect(data.approvalStatus).toBe('PENDING_REVIEW');
    expect(data.createdBy).toBe(42);
    // mirrors POST /api/products field mapping
    expect(data.name).toBe('Test Peptide 10mg');
    expect(data.baseName).toBe('Test Peptide');
    expect(data.variant).toBe('10mg');
    expect(data.unit).toBe('mg');
    expect(data.numericValue).toBe(10);
    expect(data.quantity).toBe(0);
    expect(data.location).toBe(1);
    expect(data.lowStockThreshold).toBe(5);
    expect(data.costPrice).toBe(1.5);
    expect(data.retailPrice).toBe(3);

    expect(mockApplyStockDelta).toHaveBeenCalledTimes(1);
    expect(mockApplyStockDelta.mock.calls[0][1]).toMatchObject({
      productId: 101,
      delta: 8,
      locationId: 1,
    });

    expect(result).toMatchObject({
      productId: 101,
      approvalStatus: 'PENDING_REVIEW',
      locationId: 1,
      countedQuantity: 8,
      bookedQuantity: 8,
    });
  });

  it('admin creates an APPROVED product', async () => {
    mockTx.product.create.mockResolvedValue({
      id: 102,
      approvalStatus: 'APPROVED',
    } as any);

    const result = await graduateStagingItem(
      55,
      { mode: 'new', productFields: newFields, locationId: 1 } as any,
      { id: 1, isAdmin: true }
    );

    const data = (mockTx.product.create.mock.calls[0][0] as any).data;
    expect(data.approvalStatus).toBe('APPROVED');
    expect(data.createdBy).toBe(1);
    expect(result.approvalStatus).toBe('APPROVED');
  });

  it('writes NULL lowStockThreshold (inherit default), NULL cost (R-D3: unknown), NULL retail (W0-RETAIL: unknown) when omitted', async () => {
    mockTx.product.create.mockResolvedValue({
      id: 103,
      approvalStatus: 'PENDING_REVIEW',
    } as any);

    await graduateStagingItem(
      55,
      {
        mode: 'new',
        productFields: { baseName: 'Bare', variant: 'x', locationId: 1 },
        locationId: 1,
      } as any,
      { id: 42, isAdmin: false }
    );

    const data = (mockTx.product.create.mock.calls[0][0] as any).data;
    expect(data.lowStockThreshold).toBeNull();
    expect(data.costPrice).toBeNull(); // R-D3: omitted cost = unknown, never 0
    expect(data.retailPrice).toBeNull(); // W0-RETAIL: omitted retail = unknown, never 0
    expect(data.unit).toBeNull();
    expect(data.numericValue).toBeNull();
  });

  it('keeps an explicit retail 0 (genuinely free, distinct from NULL/unknown)', async () => {
    mockTx.product.create.mockResolvedValue({
      id: 104,
      approvalStatus: 'PENDING_REVIEW',
    } as any);

    await graduateStagingItem(
      55,
      {
        mode: 'new',
        productFields: { baseName: 'Free', variant: 'x', retailPrice: 0, locationId: 1 },
        locationId: 1,
      } as any,
      { id: 42, isAdmin: false }
    );

    const data = (mockTx.product.create.mock.calls[0][0] as any).data;
    expect(data.retailPrice).toBe(0);
  });
});
