// @jest-environment node
/**
 * M3b — `POST /api/inbound-shipments/[id]/lines/[lineId]/verify`.
 *
 * The delivery-verification route: somebody counted what actually arrived on a
 * line and said so. The ROUTE owns the transaction, the batchId, the exception
 * writes and the audit; `lib/supply-orders/verify.ts` owns the state machine and
 * hands both intents out through `onRecord` (seams S6/S15).
 *
 * The CORE IS REAL here (driven through a mocked tx that dispatches on SQL
 * text), because what this suite exists to prove is the WIRING: that the
 * `recvDiscrepancy` intent the core assembles becomes exactly one writer call,
 * that everything shares ONE batchId minted outside the retry, that an
 * exception-write failure takes the audit with it, and that the frozen
 * `VERIFIED_LOCKED` envelope survives the retry wrapper. A mocked core would
 * prove none of it.
 *
 * The product resolver (S10) and the exceptions writer (S14) stay mocked: their
 * own rules are pinned in their own unit suites, and what belongs here is what
 * the route ASKS of them.
 */

import { NextRequest } from 'next/server';
import { StagingItemStatus, InboundShipmentStatus } from '@prisma/client';

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
    $queryRaw: jest.fn(async () => []),
  };
  client.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(client));
  return { __esModule: true, default: client };
});

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
  newBatchId: jest.fn(() => 'batch-verify-0001'),
}));

jest.mock('@/lib/supply-orders/product-resolve', () => ({
  __esModule: true,
  resolveSupplyOrderProduct: jest.fn(),
}));

jest.mock('@/lib/exceptions/write', () => ({
  __esModule: true,
  upsertException: jest.fn(async () => ({ id: 1 })),
  resolveException: jest.fn(async () => ({ id: 1 })),
}));

import { POST as verifyPOST } from '@/app/api/inbound-shipments/[id]/lines/[lineId]/verify/route';
import { requireApproved } from '@/lib/api-utils';
import { validateCSRFToken } from '@/lib/csrf';
import { enforceRateLimit, applyRateLimitHeaders } from '@/lib/rateLimit';
import { recordChange, newBatchId } from '@/lib/change-tracking';
import { resolveSupplyOrderProduct } from '@/lib/supply-orders/product-resolve';
import { upsertException, resolveException } from '@/lib/exceptions/write';
import prisma from '@/lib/prisma';

const db = prisma as unknown as Record<string, any>;
const mockRecordChange = recordChange as jest.Mock;
const mockNewBatchId = newBatchId as jest.Mock;
const mockResolveProduct = resolveSupplyOrderProduct as jest.Mock;
const mockUpsert = upsertException as jest.Mock;
const mockResolveException = resolveException as jest.Mock;

const APPROVED_USER = { id: 7, isAdmin: false, isApproved: true };
const ORDER_ID = 'cksupplyorder00000000001';
const LINE_ID = 501;
const PRODUCT_ID = 31;

const orderParams = { params: { id: ORDER_ID, lineId: String(LINE_ID) } } as never;

function mkReq(body: unknown) {
  return new NextRequest(
    `http://t/api/inbound-shipments/${ORDER_ID}/lines/${LINE_ID}/verify`,
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
    },
  );
}

/** The header's CURRENT status, driving the claim, and its model discriminator. */
let headerStatus: InboundShipmentStatus = InboundShipmentStatus.ORDERED;
let headerOrderedAt: Date | null = new Date('2026-08-14T00:00:00.000Z');
/** The row the core's locking read returns. */
let lockedLineRow: Record<string, unknown> | null = null;

function lineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    status: StagingItemStatus.ORDERED,
    description: 'Vial Blue',
    shipmentId: ORDER_ID,
    orderedProductId: PRODUCT_ID,
    resolvedProductId: PRODUCT_ID,
    orderedQuantity: 100,
    verifiedQuantity: null,
    stockedQuantity: 0,
    disposedQuantity: 0,
    lineTotalCents: 100_000,
    labelingRequired: true,
    locationId: null,
    notes: null,
    verifiedAt: null,
    verifiedBy: null,
    expectedQuantity: null,
    countedQuantity: null,
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

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({ user: APPROVED_USER });
  (validateCSRFToken as jest.Mock).mockResolvedValue(true);
  (enforceRateLimit as jest.Mock).mockReturnValue({ 'X-RateLimit-Remaining': '9' });
  (applyRateLimitHeaders as jest.Mock).mockImplementation((resp: unknown) => resp);
  mockNewBatchId.mockReturnValue('batch-verify-0001');
  mockUpsert.mockResolvedValue({ id: 1 });
  mockResolveException.mockResolvedValue({ id: 1 });
  headerStatus = InboundShipmentStatus.ORDERED;
  headerOrderedAt = new Date('2026-08-14T00:00:00.000Z');
  lockedLineRow = lineRow();

  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw.mockImplementation(async (statement: { sql?: string }) => {
    const sql = String(statement?.sql ?? '');
    if (/FROM inbound_shipments/i.test(sql)) return [{ orderedAt: headerOrderedAt }];
    return lockedLineRow === null ? [] : [lockedLineRow];
  });
  // The claim tries one status at a time; only the header's real status wins.
  db.inboundShipment.updateMany.mockImplementation(async (args: any) => ({
    count:
      (Array.isArray(args.where.status) ? args.where.status[0] : args.where.status) === headerStatus
        ? 1
        : 0,
  }));
  db.inboundShipment.findUnique.mockImplementation(async () => headerRow());
  db.stagingItem.updateMany.mockResolvedValue({ count: 1 });
  db.stagingItem.findMany.mockImplementation(async () => (lockedLineRow ? [lockedLineRow] : []));
  db.inventoryException.findMany.mockResolvedValue([]);
  mockResolveProduct.mockResolvedValue({
    productId: PRODUCT_ID,
    productName: 'Vial Blue',
    approvalStatus: 'APPROVED',
    created: false,
    locationId: 1,
  });
});

// ---------------------------------------------------------------------------
// The preamble (pack C3a.0)
// ---------------------------------------------------------------------------

describe('POST .../verify — the preamble', () => {
  it('requires approval, validates CSRF, rate-limits under a stable key and applies the headers', async () => {
    const res = await verifyPOST(mkReq({ verifiedQuantity: 100 }), orderParams);

    expect(res.status).toBe(200);
    expect(requireApproved).toHaveBeenCalled();
    expect(validateCSRFToken).toHaveBeenCalled();
    expect((enforceRateLimit as jest.Mock).mock.calls[0][1]).toBe('supply-order-line-verify:POST');
    expect((enforceRateLimit as jest.Mock).mock.calls[0][2]).toEqual({
      identifier: APPROVED_USER.id,
    });
    expect(applyRateLimitHeaders).toHaveBeenCalled();
  });

  it('mints ONE batchId, outside the retry', async () => {
    await verifyPOST(mkReq({ verifiedQuantity: 90 }), orderParams);
    expect(mockNewBatchId).toHaveBeenCalledTimes(1);
  });

  it('400s a body zod refuses (a negative count)', async () => {
    const res = await verifyPOST(mkReq({ verifiedQuantity: -1 }), orderParams);
    expect(res.status).toBe(400);
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
  });

  it('400s a non-numeric lineId before any read', async () => {
    const res = await verifyPOST(mkReq({ verifiedQuantity: 1 }), {
      params: { id: ORDER_ID, lineId: 'abc' },
    } as never);
    expect(res.status).toBe(400);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The happy paths + the discrepancy intent (S6)
// ---------------------------------------------------------------------------

describe('POST .../verify — the count lands', () => {
  it('a first verify that MATCHES the order writes no exception and audits STAGING_VERIFY', async () => {
    const res = await verifyPOST(mkReq({ verifiedQuantity: 100, note: 'all there' }), orderParams);

    expect(res.status).toBe(200);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockResolveException).not.toHaveBeenCalled();

    const verifies = recorded('STAGING_VERIFY');
    expect(verifies).toHaveLength(1);
    expect(verifies[0]).toMatchObject({
      entityType: 'STAGING',
      entityId: LINE_ID,
      batchId: 'batch-verify-0001',
    });
    expect(verifies[0].details).toMatchObject({
      shipmentId: ORDER_ID,
      kind: 'first',
      previous: null,
      ordered: 100,
      verified: 100,
      delta: 100,
      lossCents: 0,
      surplusValueCents: 0,
      note: 'all there',
      headerPromoted: true,
      productRemapped: null,
    });
  });

  it('a SHORT first verify upserts recv-discrepancy with the complete subject under the same batchId', async () => {
    const res = await verifyPOST(mkReq({ verifiedQuantity: 90, note: 'ten short' }), orderParams);

    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const [, args] = mockUpsert.mock.calls[0];
    expect(args.kind).toBe('recv-discrepancy');
    expect(args.key).toBe(`recv-discrepancy:${LINE_ID}`);
    expect(args.subject).toEqual({
      stagingItemId: LINE_ID,
      shipmentId: ORDER_ID,
      productId: PRODUCT_ID,
      orderedProductId: PRODUCT_ID,
      expectedQty: 100,
      countedQty: 90,
      orderedQuantity: 100,
      verifiedQuantity: 90,
      shortUnits: 10,
      overUnits: 0,
      unitCostCents: 1000,
      lossCents: 10_000,
      surplusValueCents: 0,
      note: 'ten short',
    });
    expect(recorded('STAGING_VERIFY')[0].batchId).toBe('batch-verify-0001');
  });

  it('a RAISE that closes a shortage RESOLVES the row additional-delivery with the recomputed patch', async () => {
    headerStatus = InboundShipmentStatus.RECEIVING;
    lockedLineRow = lineRow({
      status: StagingItemStatus.VERIFIED,
      verifiedQuantity: 90,
    });

    const res = await verifyPOST(mkReq({ verifiedQuantity: 100 }), orderParams);

    expect(res.status).toBe(200);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockResolveException).toHaveBeenCalledTimes(1);
    const [, args] = mockResolveException.mock.calls[0];
    expect(args).toMatchObject({
      key: `recv-discrepancy:${LINE_ID}`,
      resolvedBy: APPROVED_USER.id,
      resolution: 'additional-delivery',
    });
    expect(args.subjectPatch).toMatchObject({
      verifiedQuantity: 100,
      shortUnits: 0,
      lossCents: 0,
      surplusValueCents: 0,
    });
    expect(recorded('STAGING_VERIFY')[0].details).toMatchObject({ kind: 'raise', delta: 10 });
  });

  it('a re-mapped delivered product records PRODUCT_CREATE under the SAME batchId', async () => {
    mockResolveProduct.mockResolvedValue({
      productId: 88,
      productName: 'Vial Green',
      approvalStatus: 'PENDING_REVIEW',
      created: true,
      locationId: 1,
    });

    const res = await verifyPOST(
      mkReq({
        verifiedQuantity: 100,
        deliveredProduct: { mode: 'new', productFields: { baseName: 'Vial', variant: 'Green' } },
      }),
      orderParams,
    );

    expect(res.status).toBe(200);
    const products = recorded('PRODUCT_CREATE');
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      entityType: 'PRODUCT',
      entityId: 88,
      batchId: 'batch-verify-0001',
    });
    expect(recorded('STAGING_VERIFY')[0].details.productRemapped).toEqual({
      from: PRODUCT_ID,
      to: 88,
      productName: 'Vial Green',
    });
  });

  it('400s a delivered product carrying costPrice (premise 1) before anything is written', async () => {
    const res = await verifyPOST(
      mkReq({
        verifiedQuantity: 100,
        deliveredProduct: {
          mode: 'new',
          productFields: { baseName: 'Vial', variant: 'Green', costPrice: 4 },
        },
      }),
      orderParams,
    );

    expect(res.status).toBe(400);
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
  });

  it('answers the verify result PLUS the refreshed line view', async () => {
    const res = await verifyPOST(mkReq({ verifiedQuantity: 100 }), orderParams);
    const json = await res.json();

    expect(json).toMatchObject({
      lineId: LINE_ID,
      status: StagingItemStatus.VERIFIED,
      verifiedQuantity: 100,
      remaining: 100,
      resolvedProductId: PRODUCT_ID,
    });
    expect(json.money).toMatchObject({ unitCostCents: 1000, lossCents: 0 });
    expect(json.line).toMatchObject({ id: LINE_ID });
  });
});

// ---------------------------------------------------------------------------
// Refusals + atomicity
// ---------------------------------------------------------------------------

describe('POST .../verify — refusals', () => {
  it('answers the FROZEN VERIFIED_LOCKED envelope when the count would fall below the ledger', async () => {
    headerStatus = InboundShipmentStatus.RECEIVING;
    lockedLineRow = lineRow({
      status: StagingItemStatus.LABELING,
      verifiedQuantity: 100,
      stockedQuantity: 40,
      disposedQuantity: 2,
    });

    const res = await verifyPOST(mkReq({ verifiedQuantity: 10 }), orderParams);

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json).toMatchObject({ code: 'VERIFIED_LOCKED', stocked: 40, disposed: 2 });
    expect(typeof json.error).toBe('string');
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('propagates the core NOT_ORDERED 409 for a line nobody can verify', async () => {
    lockedLineRow = lineRow({ status: StagingItemStatus.DISCARDED });

    const res = await verifyPOST(mkReq({ verifiedQuantity: 5 }), orderParams);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOT_ORDERED');
  });

  it('404s a line that is not on this order', async () => {
    lockedLineRow = null;

    const res = await verifyPOST(mkReq({ verifiedQuantity: 5 }), orderParams);
    expect(res.status).toBe(404);
  });

  it('409 LEGACY_READ_ONLY on a legacy receipt header', async () => {
    // The discriminator lives INSIDE the claim and runs after it, so the case
    // that actually reaches it is a legacy header in a status the claim allows
    // (a CLOSED W1 receipt). An OPEN one is refused earlier, as a CONFLICT.
    headerOrderedAt = null;
    headerStatus = InboundShipmentStatus.CLOSED;

    const res = await verifyPOST(mkReq({ verifiedQuantity: 5 }), orderParams);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('LEGACY_READ_ONLY');
  });

  it('an onRecord FAILURE propagates — the audit never lands (atomicity, unit half)', async () => {
    mockUpsert.mockRejectedValue(new Error('exception writer exploded'));

    const res = await verifyPOST(mkReq({ verifiedQuantity: 90 }), orderParams);

    expect(res.status).toBe(500);
    expect(recorded('STAGING_VERIFY')).toHaveLength(0);
  });
});
