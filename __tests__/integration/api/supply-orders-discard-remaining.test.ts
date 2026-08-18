// @jest-environment node
/**
 * M3b — `POST /api/inbound-shipments/[id]/lines/[lineId]/discard-remaining`.
 *
 * Units that were verified but never became stock: breakage on the labeling
 * bench. NEVER a stock movement — nothing touches the ledger or the product,
 * because these units were never stock (spec §4.3.5). The act writes off the
 * remainder, closes the line, and raises (or refreshes) the CUMULATIVE
 * `labeling-loss:<lineId>` row carrying the OPERATOR'S OWN REASON.
 *
 * `discardRemaining` is REAL here (mocked tx): what this suite owns is the
 * route's half — the batchId outside the retry, the exception row written from
 * the context the core assembled, the `STAGING_DISCARD` audit line carrying the
 * remainder and the reason, and the refusal on a line with nothing left.
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
    $executeRaw: jest.fn(async () => 1),
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
  newBatchId: jest.fn(() => 'batch-discard-0001'),
}));

jest.mock('@/lib/exceptions/write', () => ({
  __esModule: true,
  upsertException: jest.fn(async () => ({ id: 1 })),
  resolveException: jest.fn(async () => ({ id: 1 })),
}));

import { POST as discardRemainingPOST } from '@/app/api/inbound-shipments/[id]/lines/[lineId]/discard-remaining/route';
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
const ORDER_ID = 'cksupplyorder00000000001';
const LINE_ID = 501;
const PRODUCT_ID = 31;

const lineParams = { params: { id: ORDER_ID, lineId: String(LINE_ID) } } as never;

function mkReq(body: unknown) {
  return new NextRequest(
    `http://t/api/inbound-shipments/${ORDER_ID}/lines/${LINE_ID}/discard-remaining`,
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
    },
  );
}

let headerStatus: InboundShipmentStatus = InboundShipmentStatus.RECEIVING;
let headerOrderedAt: Date | null = new Date('2026-08-14T00:00:00.000Z');
let lockedLineRow: Record<string, unknown> | null = null;
let discardWriteCount = 1;

function lineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    status: StagingItemStatus.LABELING,
    description: 'Vial Blue',
    shipmentId: ORDER_ID,
    orderedProductId: PRODUCT_ID,
    resolvedProductId: PRODUCT_ID,
    orderedQuantity: 10,
    verifiedQuantity: 10,
    stockedQuantity: 6,
    disposedQuantity: 0,
    lineTotalCents: 10_000,
    labelingRequired: true,
    locationId: 2,
    notes: null,
    verifiedAt: new Date('2026-08-15T09:00:00.000Z'),
    verifiedBy: APPROVED_USER.id,
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
  mockNewBatchId.mockReturnValue('batch-discard-0001');
  mockUpsert.mockResolvedValue({ id: 1 });

  headerStatus = InboundShipmentStatus.RECEIVING;
  headerOrderedAt = new Date('2026-08-14T00:00:00.000Z');
  lockedLineRow = lineRow();
  discardWriteCount = 1;

  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw.mockImplementation(async (statement: { sql?: string }) => {
    const sql = String(statement?.sql ?? '');
    if (/FROM inbound_shipments/i.test(sql)) return [{ orderedAt: headerOrderedAt }];
    return lockedLineRow === null ? [] : [lockedLineRow];
  });
  db.$executeRaw.mockImplementation(async () => discardWriteCount);
  db.inboundShipment.updateMany.mockImplementation(async (args: any) => ({
    count: args.where.status === headerStatus ? 1 : 0,
  }));
  db.inboundShipment.findUnique.mockImplementation(async () => headerRow());
  db.stagingItem.findMany.mockImplementation(async () => (lockedLineRow ? [lockedLineRow] : []));
  db.inventoryException.findMany.mockResolvedValue([]);
});

describe('POST .../discard-remaining — the preamble', () => {
  it('requires approval, validates CSRF, rate-limits under a stable key and applies the headers', async () => {
    const res = await discardRemainingPOST(mkReq({ reason: 'crushed' }), lineParams);

    expect(res.status).toBe(200);
    expect(requireApproved).toHaveBeenCalled();
    expect(validateCSRFToken).toHaveBeenCalled();
    expect((enforceRateLimit as jest.Mock).mock.calls[0][1]).toBe(
      'supply-order-line-discard-remaining:POST',
    );
    expect(applyRateLimitHeaders).toHaveBeenCalled();
  });

  it('mints ONE batchId, outside the retry', async () => {
    await discardRemainingPOST(mkReq({ reason: 'crushed' }), lineParams);
    expect(mockNewBatchId).toHaveBeenCalledTimes(1);
  });

  it('400s a body with no reason — an unexplained write-off is what the row exists to prevent', async () => {
    const res = await discardRemainingPOST(mkReq({}), lineParams);
    expect(res.status).toBe(400);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('400s an empty reason string', async () => {
    const res = await discardRemainingPOST(mkReq({ reason: '' }), lineParams);
    expect(res.status).toBe(400);
  });
});

describe('POST .../discard-remaining — the write-off lands', () => {
  it('raises the CUMULATIVE labeling-loss row carrying the OPERATOR reason', async () => {
    const res = await discardRemainingPOST(
      mkReq({ reason: 'dropped the tray' }),
      lineParams,
    );

    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const [, args] = mockUpsert.mock.calls[0];
    expect(args.kind).toBe('labeling-loss');
    expect(args.key).toBe(`labeling-loss:${LINE_ID}`);
    expect(args.subject).toEqual({
      stagingItemId: LINE_ID,
      shipmentId: ORDER_ID,
      productId: PRODUCT_ID,
      // 4 units left of 10 verified, 6 already stocked; their exact share of the
      // $100.00 line is the cumulative slice after the stocked ones.
      units: 4,
      unitCostCents: 1000,
      lossCents: 4000,
      reason: 'dropped the tray',
    });
  });

  it('audits STAGING_DISCARD with the remainder and the reason, same batchId', async () => {
    await discardRemainingPOST(mkReq({ reason: 'dropped the tray' }), lineParams);

    const events = recorded('STAGING_DISCARD');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityType: 'STAGING',
      entityId: LINE_ID,
      batchId: 'batch-discard-0001',
    });
    expect(events[0].details).toMatchObject({
      shipmentId: ORDER_ID,
      productId: PRODUCT_ID,
      reason: 'dropped the tray',
      discarded: 4,
      disposedAfter: 4,
      stockedQuantity: 6,
      verified: 10,
      remaining: 0,
      lossCents: 4000,
      unitCostCents: 1000,
    });
  });

  it('a SECOND discard on a line that already lost units is cumulative', async () => {
    lockedLineRow = lineRow({ stockedQuantity: 4, disposedQuantity: 2 });

    await discardRemainingPOST(mkReq({ reason: 'the rest too' }), lineParams);

    expect(mockUpsert.mock.calls[0][1].subject).toMatchObject({
      units: 6,
      lossCents: 6000,
      reason: 'the rest too',
    });
  });

  it('answers the discard result plus the refreshed line view', async () => {
    const res = await discardRemainingPOST(mkReq({ reason: 'crushed' }), lineParams);
    const json = await res.json();

    expect(json).toMatchObject({
      lineId: LINE_ID,
      status: 'COMPLETE',
      disposedQuantity: 4,
      stockedQuantity: 6,
      remaining: 0,
    });
    expect(json.line).toMatchObject({ id: LINE_ID });
  });

  it('NEVER writes a stock movement — no ledger, no product', async () => {
    await discardRemainingPOST(mkReq({ reason: 'crushed' }), lineParams);

    const rawWrites = db.$executeRaw.mock.calls.map((c: any[]) => String(c[0]?.sql ?? ''));
    expect(rawWrites).toHaveLength(1);
    expect(rawWrites[0]).toMatch(/UPDATE staging_items/i);
    expect(rawWrites[0]).not.toMatch(/inventory_logs|product_locations|products/i);
  });
});

describe('POST .../discard-remaining — refusals', () => {
  it('409 NOT_BOOKABLE when there is nothing left (idempotent by construction)', async () => {
    lockedLineRow = lineRow({ stockedQuantity: 10 });

    const res = await discardRemainingPOST(mkReq({ reason: 'again' }), lineParams);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOT_BOOKABLE');
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('REV-11 clause 1: passes expectRemaining through — a STALE card is a 409, nothing written', async () => {
    // The locked line has 4 left (10 verified, 6 stocked); the card said 5.
    const res = await discardRemainingPOST(
      mkReq({ reason: 'stale card', expectRemaining: 5 }),
      lineParams,
    );

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('CONFLICT');
    expect(json.error).toBe(
      'The remainder changed since you loaded this line — it is now 4 (verified 10, stocked 6, disposed 0). Reload and try again.',
    );
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('REV-11 clause 1: a MATCHING expectRemaining writes the remainder off as normal', async () => {
    const res = await discardRemainingPOST(
      mkReq({ reason: 'dropped the tray', expectRemaining: 4 }),
      lineParams,
    );

    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0][1].subject).toMatchObject({ units: 4, lossCents: 4000 });
  });

  it('REV-11 clause 1: 400s a negative expectRemaining before anything is read', async () => {
    const res = await discardRemainingPOST(
      mkReq({ reason: 'nope', expectRemaining: -1 }),
      lineParams,
    );

    expect(res.status).toBe(400);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('409 CONFLICT when the guarded write loses its row', async () => {
    discardWriteCount = 0;

    const res = await discardRemainingPOST(mkReq({ reason: 'raced' }), lineParams);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CONFLICT');
  });

  it('404s a line that is not on this order', async () => {
    lockedLineRow = null;

    const res = await discardRemainingPOST(mkReq({ reason: 'nope' }), lineParams);
    expect(res.status).toBe(404);
  });

  it('an onRecord FAILURE propagates — the audit never lands', async () => {
    mockUpsert.mockRejectedValue(new Error('exception writer exploded'));

    const res = await discardRemainingPOST(mkReq({ reason: 'crushed' }), lineParams);

    expect(res.status).toBe(500);
    expect(recorded('STAGING_DISCARD')).toHaveLength(0);
  });
});
