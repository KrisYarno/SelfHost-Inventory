// @jest-environment node
/**
 * M3b — `POST /api/inbound-shipments/[id]/lines/[lineId]/stock-in`.
 *
 * THE booking route: N labeled units off a verified line become stock. The
 * primitive (`lib/supply-orders/booking.ts`) owns the locks, the ledger row and
 * the counters; the ROUTE owns `withBookingRetry(() => prisma.$transaction(...))`
 * with the batchId minted outside it, the three exception rows the primitive
 * assembles (seams S4/S20), and the `STAGING_STOCK_IN` audit line.
 *
 * The primitive is REAL here, driven through a mocked tx, because three of this
 * suite's pins are only meaningful against the real one:
 *
 *   - THE REPLAY PATH never reaches `onRecord` at all, so a re-submitted batch
 *     writes nothing and audits nothing (spec §4.3.3, G2s3-8);
 *   - `labelingLossRefresh` is DERIVED by the primitive from the locked line's
 *     disposed counter — the route never probes the writer to decide (PK2-11);
 *   - the OPERATOR's discard reason survives the refresh (S25): the primitive's
 *     own reason is a system string, so the route reads the existing row's
 *     reason in-tx and writes that back.
 */

import { NextRequest } from 'next/server';
import { Prisma, StagingItemStatus, InboundShipmentStatus } from '@prisma/client';

jest.mock('@/lib/api-utils', () => {
  const actual = jest.requireActual('@/lib/api-utils');
  return {
    __esModule: true,
    ...actual,
    requireApproved: jest.fn(),
  };
});

jest.mock('@/lib/prisma', () => {
  const client: Record<string, unknown> = {
    inboundShipment: { findUnique: jest.fn(), updateMany: jest.fn() },
    stagingItem: { findMany: jest.fn(), updateMany: jest.fn() },
    inventoryException: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
    product: { findUnique: jest.fn(async () => ({ approvalStatus: 'APPROVED' })) },
    $queryRaw: jest.fn(async () => []),
  };
  client.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(client));
  return { __esModule: true, default: client };
});

const mockApplyStockDelta = jest.fn(async () => ({ log: { id: 1 }, newVersion: 1 }));
jest.mock('@/lib/inventory', () => {
  const actual = jest.requireActual('@/lib/inventory');
  return {
    __esModule: true,
    ...actual,
    applyStockDelta: (...args: unknown[]) => mockApplyStockDelta(...(args as [])),
  };
});

const mockApplyReceiptCost = jest.fn(async () => ({ outcome: 'unchanged' }));
jest.mock('@/lib/products/cost', () => ({
  __esModule: true,
  applyReceiptCost: (...args: unknown[]) => mockApplyReceiptCost(...(args as [])),
}));

jest.mock('@/lib/csrf', () => ({
  validateCSRFToken: jest.fn(async () => true),
}));

jest.mock('@/lib/rateLimit', () => ({
  __esModule: true,
  RateLimitError: jest.requireActual('@/lib/rateLimit').RateLimitError,
  enforceRateLimit: jest.fn(() => ({ 'X-RateLimit-Remaining': '9' })),
  applyRateLimitHeaders: jest.fn((resp: unknown) => resp),
}));

jest.mock('@/lib/change-tracking', () => ({
  __esModule: true,
  recordChange: jest.fn(async () => undefined),
  newBatchId: jest.fn(() => 'batch-stockin-0001'),
}));

jest.mock('@/lib/exceptions/write', () => ({
  __esModule: true,
  upsertException: jest.fn(async () => ({ id: 1 })),
  resolveException: jest.fn(async () => ({ id: 1 })),
}));

import { POST as stockInPOST } from '@/app/api/inbound-shipments/[id]/lines/[lineId]/stock-in/route';
import { requireApproved } from '@/lib/api-utils';
import { validateCSRFToken } from '@/lib/csrf';
import { enforceRateLimit, applyRateLimitHeaders } from '@/lib/rateLimit';
import { recordChange, newBatchId } from '@/lib/change-tracking';
import { upsertException } from '@/lib/exceptions/write';
import prisma from '@/lib/prisma';

const db = prisma as unknown as Record<string, any>;
const mockRecordChange = recordChange as jest.Mock;
const mockNewBatchId = newBatchId as jest.Mock;
const mockUpsert = upsertException as jest.Mock;

const APPROVED_USER = { id: 7, isAdmin: false, isApproved: true };
const ADMIN_USER = { id: 9, isAdmin: true, isApproved: true };
const ORDER_ID = 'cksupplyorder00000000001';
const LINE_ID = 501;
const PRODUCT_ID = 31;
const BOOKING_KEY = '11111111-2222-4333-8444-555555555555';

const lineParams = { params: { id: ORDER_ID, lineId: String(LINE_ID) } } as never;

function mkReq(body: unknown) {
  return new NextRequest(
    `http://t/api/inbound-shipments/${ORDER_ID}/lines/${LINE_ID}/stock-in`,
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
    },
  );
}

const stockInBody = (overrides: Record<string, unknown> = {}) => ({
  bookingKey: BOOKING_KEY,
  quantity: 4,
  locationId: 2,
  note: 'first pallet',
  ...overrides,
});

/** State the mocked tx answers from. */
let headerStatus: InboundShipmentStatus = InboundShipmentStatus.RECEIVING;
let headerOrderedAt: Date | null = new Date('2026-08-14T00:00:00.000Z');
let lockedLineRow: Record<string, unknown> | null = null;
let priorBatchRow: Record<string, unknown> | null = null;
let lockedProductRow: Record<string, unknown> | null = null;
let existingLabelingLoss: Record<string, unknown> | null = null;
let lineUpdateCount = 1;

function lineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    status: StagingItemStatus.VERIFIED,
    description: 'Vial Blue',
    shipmentId: ORDER_ID,
    orderedProductId: PRODUCT_ID,
    resolvedProductId: PRODUCT_ID,
    orderedQuantity: 10,
    verifiedQuantity: 10,
    stockedQuantity: 0,
    disposedQuantity: 0,
    lineTotalCents: 10_000,
    labelingRequired: true,
    locationId: null,
    notes: null,
    verifiedAt: new Date('2026-08-15T09:00:00.000Z'),
    verifiedBy: APPROVED_USER.id,
    expectedQuantity: null,
    countedQuantity: null,
    ...overrides,
  };
}

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PRODUCT_ID,
    approvalStatus: 'APPROVED',
    deletedAt: null,
    costPrice: new Prisma.Decimal(10),
    ...overrides,
  };
}

function headerRow() {
  return {
    id: ORDER_ID,
    supplierRef: 'PO-42',
    supplier: 'Acme',
    status: headerStatus,
    notes: null,
    createdBy: APPROVED_USER.id,
    closedBy: null,
    orderedAt: headerOrderedAt,
    feesCents: 0,
    feesNote: null,
    createdAt: new Date('2026-08-14T09:00:00.000Z'),
    updatedAt: new Date('2026-08-14T09:00:00.000Z'),
    closedAt: null,
    creator: { id: APPROVED_USER.id, username: 'kris' },
  };
}

const recorded = (actionType: string) =>
  mockRecordChange.mock.calls.filter((c) => c[1].actionType === actionType).map((c) => c[1]);

const upserted = (kind: string) =>
  mockUpsert.mock.calls.filter((c) => c[1].kind === kind).map((c) => c[1]);

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({ user: APPROVED_USER });
  (validateCSRFToken as jest.Mock).mockResolvedValue(true);
  (enforceRateLimit as jest.Mock).mockReturnValue({ 'X-RateLimit-Remaining': '9' });
  (applyRateLimitHeaders as jest.Mock).mockImplementation((resp: unknown) => resp);
  mockNewBatchId.mockReturnValue('batch-stockin-0001');
  mockUpsert.mockResolvedValue({ id: 1 });
  mockApplyStockDelta.mockResolvedValue({ log: { id: 1 }, newVersion: 1 });
  mockApplyReceiptCost.mockResolvedValue({ outcome: 'unchanged' } as never);

  headerStatus = InboundShipmentStatus.RECEIVING;
  headerOrderedAt = new Date('2026-08-14T00:00:00.000Z');
  lockedLineRow = lineRow();
  priorBatchRow = null;
  lockedProductRow = productRow();
  existingLabelingLoss = null;
  lineUpdateCount = 1;

  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw.mockImplementation(async (statement: { sql?: string }) => {
    const sql = String(statement?.sql ?? '');
    if (/FROM staging_items/i.test(sql)) return lockedLineRow === null ? [] : [lockedLineRow];
    if (/FROM inventory_logs/i.test(sql)) return priorBatchRow === null ? [] : [priorBatchRow];
    if (/FROM inbound_shipments/i.test(sql)) return [{ orderedAt: headerOrderedAt }];
    if (/FROM product_locations/i.test(sql)) return [{ id: 1, locationId: 2, quantity: 6 }];
    if (/FROM products/i.test(sql)) return lockedProductRow === null ? [] : [lockedProductRow];
    throw new Error(`unexpected raw query: ${sql}`);
  });
  db.inboundShipment.updateMany.mockImplementation(async (args: any) => ({
    count: args.where.status === headerStatus ? 1 : 0,
  }));
  db.inboundShipment.findUnique.mockImplementation(async () => headerRow());
  db.stagingItem.updateMany.mockImplementation(async () => ({ count: lineUpdateCount }));
  db.stagingItem.findMany.mockImplementation(async () => (lockedLineRow ? [lockedLineRow] : []));
  db.inventoryException.findMany.mockResolvedValue([]);
  db.inventoryException.findUnique.mockImplementation(async () => existingLabelingLoss);
  db.product.findUnique.mockResolvedValue({ approvalStatus: 'APPROVED' });
});

// ---------------------------------------------------------------------------
// The preamble
// ---------------------------------------------------------------------------

describe('POST .../stock-in — the preamble', () => {
  it('requires approval, validates CSRF, rate-limits under a stable key and applies the headers', async () => {
    const res = await stockInPOST(mkReq(stockInBody()), lineParams);

    expect(res.status).toBe(200);
    expect(requireApproved).toHaveBeenCalled();
    expect(validateCSRFToken).toHaveBeenCalled();
    expect((enforceRateLimit as jest.Mock).mock.calls[0][1]).toBe('supply-order-line-stock-in:POST');
    expect(applyRateLimitHeaders).toHaveBeenCalled();
  });

  it('mints ONE batchId, outside the retry', async () => {
    await stockInPOST(mkReq(stockInBody()), lineParams);
    expect(mockNewBatchId).toHaveBeenCalledTimes(1);
  });

  it('400s a bookingKey that is not a uuid', async () => {
    const res = await stockInPOST(mkReq(stockInBody({ bookingKey: 'nope' })), lineParams);
    expect(res.status).toBe(400);
    expect(mockApplyStockDelta).not.toHaveBeenCalled();
  });

  it('400s a quantity below 1', async () => {
    const res = await stockInPOST(mkReq(stockInBody({ quantity: 0 })), lineParams);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The booking lands
// ---------------------------------------------------------------------------

describe('POST .../stock-in — the batch lands', () => {
  it('books the batch and audits STAGING_STOCK_IN against the LINE', async () => {
    const res = await stockInPOST(mkReq(stockInBody()), lineParams);

    expect(res.status).toBe(200);
    const events = recorded('STAGING_STOCK_IN');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityType: 'STAGING',
      entityId: LINE_ID,
      batchId: 'batch-stockin-0001',
    });
    expect(events[0].details).toMatchObject({
      shipmentId: ORDER_ID,
      productId: PRODUCT_ID,
      bookingKey: BOOKING_KEY,
      note: 'first pallet',
      quantity: 4,
      locationId: 2,
      unitCostCents: 1000,
      receiptCostCents: 4000,
      stockedAfter: 4,
      remaining: 6,
      batch: 'first',
    });
  });

  it('a SUBSEQUENT batch says so in the audit line', async () => {
    lockedLineRow = lineRow({ status: StagingItemStatus.LABELING, stockedQuantity: 4 });

    await stockInPOST(mkReq(stockInBody({ quantity: 6 })), lineParams);

    expect(recorded('STAGING_STOCK_IN')[0].details).toMatchObject({
      batch: 'subsequent',
      stockedAfter: 10,
      remaining: 0,
    });
  });

  it('answers the booking result including costPrompt (M4b consumes it) and the line view', async () => {
    (requireApproved as jest.Mock).mockResolvedValue({ user: ADMIN_USER });
    lockedProductRow = productRow({ costPrice: new Prisma.Decimal(3) });

    const res = await stockInPOST(mkReq(stockInBody()), lineParams);
    const json = await res.json();

    expect(json).toMatchObject({
      lineId: LINE_ID,
      status: StagingItemStatus.LABELING,
      stockedQuantity: 4,
      remaining: 6,
      productId: PRODUCT_ID,
      batch: { quantity: 4, locationId: 2, unitCostCents: 1000, replayed: false },
      costPrompt: { productId: PRODUCT_ID, currentCents: 300, receiptCents: 1000 },
    });
    expect(json.line).toMatchObject({ id: LINE_ID });
  });

  it('writes the cost-differs row the primitive assembled', async () => {
    lockedProductRow = productRow({ costPrice: new Prisma.Decimal(3) });

    await stockInPOST(mkReq(stockInBody()), lineParams);

    const rows = upserted('cost-differs');
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe(`cost-differs:${LINE_ID}`);
    expect(rows[0].subject).toEqual({
      productId: PRODUCT_ID,
      stagingItemId: LINE_ID,
      currentCents: 300,
      receiptCents: 1000,
    });
  });

  it('writes the pending-with-stock row keyed by PRODUCT when the product is unapproved', async () => {
    lockedProductRow = productRow({ approvalStatus: 'PENDING_REVIEW' });

    await stockInPOST(mkReq(stockInBody()), lineParams);

    const rows = upserted('pending-with-stock');
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe(`pending-with-stock:${PRODUCT_ID}`);
    // pre-batch on-hand (6) + this batch (4).
    expect(rows[0].subject).toEqual({
      productId: PRODUCT_ID,
      stagingItemId: LINE_ID,
      units: 10,
    });
  });

  it('raises NEITHER row on an approved product whose cost already agrees', async () => {
    await stockInPOST(mkReq(stockInBody()), lineParams);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The labeling-loss refresh (S20 + S25)
// ---------------------------------------------------------------------------

describe('POST .../stock-in — the labeling-loss refresh', () => {
  beforeEach(() => {
    // 10 verified, 2 already written off at the bench, nothing stocked yet.
    lockedLineRow = lineRow({ status: StagingItemStatus.LABELING, disposedQuantity: 2 });
  });

  it("re-prices the row and PRESERVES the operator's original reason (S25)", async () => {
    existingLabelingLoss = {
      id: 3,
      key: `labeling-loss:${LINE_ID}`,
      kind: 'labeling-loss',
      subject: { reason: 'crushed by the pallet jack', units: 2, lossCents: 2000 },
    };

    await stockInPOST(mkReq(stockInBody({ quantity: 4 })), lineParams);

    expect(db.inventoryException.findUnique).toHaveBeenCalledWith({
      where: { key: `labeling-loss:${LINE_ID}` },
    });
    const rows = upserted('labeling-loss');
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe(`labeling-loss:${LINE_ID}`);
    expect(rows[0].subject).toMatchObject({
      stagingItemId: LINE_ID,
      shipmentId: ORDER_ID,
      productId: PRODUCT_ID,
      units: 2,
      unitCostCents: 1000,
      lossCents: 2000,
      reason: 'crushed by the pallet jack',
    });
  });

  it("falls back to the primitive's system reason when no row exists yet", async () => {
    existingLabelingLoss = null;

    await stockInPOST(mkReq(stockInBody({ quantity: 4 })), lineParams);

    const rows = upserted('labeling-loss');
    expect(rows).toHaveLength(1);
    expect(typeof rows[0].subject.reason).toBe('string');
    expect(rows[0].subject.reason).toMatch(/re-priced by a later stock-in/i);
  });

  it('a stored subject with no usable reason still writes a reason string', async () => {
    existingLabelingLoss = {
      id: 3,
      key: `labeling-loss:${LINE_ID}`,
      kind: 'labeling-loss',
      subject: { units: 2 },
    };

    await stockInPOST(mkReq(stockInBody({ quantity: 4 })), lineParams);

    expect(upserted('labeling-loss')[0].subject.reason).toMatch(/re-priced by a later stock-in/i);
  });

  it('never touches the labeling-loss row on a line with nothing disposed', async () => {
    lockedLineRow = lineRow();

    await stockInPOST(mkReq(stockInBody()), lineParams);

    expect(db.inventoryException.findUnique).not.toHaveBeenCalled();
    expect(upserted('labeling-loss')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The replay path
// ---------------------------------------------------------------------------

describe('POST .../stock-in — the replay', () => {
  it('returns 200 with batch.replayed true and writes NOTHING', async () => {
    lockedLineRow = lineRow({ status: StagingItemStatus.LABELING, stockedQuantity: 4 });
    priorBatchRow = {
      id: 900,
      delta: 4,
      locationId: 2,
      unitCostCents: 1000,
      receiptCostCents: 4000,
    };

    const res = await stockInPOST(mkReq(stockInBody()), lineParams);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.batch).toMatchObject({ quantity: 4, locationId: 2, replayed: true });
    expect(json.costPrompt).toBeNull();
    expect(mockApplyStockDelta).not.toHaveBeenCalled();
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('409 IDEMPOTENCY_MISMATCH when the same key carries different numbers', async () => {
    priorBatchRow = {
      id: 900,
      delta: 6,
      locationId: 2,
      unitCostCents: 1000,
      receiptCostCents: 6000,
    };

    const res = await stockInPOST(mkReq(stockInBody({ quantity: 4 })), lineParams);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('IDEMPOTENCY_MISMATCH');
    expect(mockRecordChange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The 409 matrix
// ---------------------------------------------------------------------------

describe('POST .../stock-in — refusals', () => {
  it('answers the FROZEN CEILING envelope naming all four counters', async () => {
    lockedLineRow = lineRow({
      status: StagingItemStatus.LABELING,
      stockedQuantity: 6,
      disposedQuantity: 1,
    });

    const res = await stockInPOST(mkReq(stockInBody({ quantity: 5 })), lineParams);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'CEILING',
      stocked: 6,
      disposed: 1,
      verified: 10,
      requested: 5,
    });
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('409 NOT_BOOKABLE on a line nobody has verified into the queue', async () => {
    lockedLineRow = lineRow({ status: StagingItemStatus.ORDERED, verifiedQuantity: null });

    const res = await stockInPOST(mkReq(stockInBody()), lineParams);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOT_BOOKABLE');
  });

  it('409 PRODUCT_DECLINED when the product was declined mid-flight', async () => {
    lockedProductRow = productRow({ deletedAt: new Date('2026-08-16T00:00:00.000Z') });

    const res = await stockInPOST(mkReq(stockInBody()), lineParams);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PRODUCT_DECLINED');
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('409 CONFLICT when the guarded increment loses its row', async () => {
    lineUpdateCount = 0;

    const res = await stockInPOST(mkReq(stockInBody()), lineParams);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CONFLICT');
  });

  it('409 NOT_BOOKABLE on a legacy receipt header (the claim carries the discriminator)', async () => {
    headerOrderedAt = null;
    headerStatus = InboundShipmentStatus.CLOSED;

    const res = await stockInPOST(mkReq(stockInBody()), lineParams);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOT_BOOKABLE');
  });

  it('an onRecord FAILURE propagates — the audit never lands', async () => {
    lockedProductRow = productRow({ approvalStatus: 'PENDING_REVIEW' });
    mockUpsert.mockRejectedValue(new Error('exception writer exploded'));

    const res = await stockInPOST(mkReq(stockInBody()), lineParams);

    expect(res.status).toBe(500);
    expect(recorded('STAGING_STOCK_IN')).toHaveLength(0);
  });
});
