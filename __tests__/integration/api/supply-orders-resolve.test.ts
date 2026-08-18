// @jest-environment node
/**
 * M3b — `POST /api/inbound-shipments/[id]/lines/[lineId]/resolve`.
 *
 * The FOLLOW-UP act (spec §4.2.7): an exception on this order gets classified —
 * credited, reshipped, accepted as a loss, corrected by a recount. The
 * classification lives in `inventory_exceptions.resolution`; the settlement
 * instant and actor stay where the first settlement put them (spec §6).
 *
 * Two things make this route more than a thin call:
 *
 *   THE KEY IS BOUND TO THE URL. `exceptionKey` must be one of this LINE'S two
 *   deterministic keys, and the line must be one of THIS order's — anything else
 *   is a 404, never a resolution written across orders.
 *   THE MONEY IS RECOMPUTED. Every resolution refreshes the row's subject from
 *   the LOCKED counters (spec §6), so the register can answer "how much was
 *   settled" from the row alone rather than from figures raised weeks earlier.
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
    inboundShipment: { findUnique: jest.fn() },
    stagingItem: { findMany: jest.fn() },
    inventoryException: { findMany: jest.fn(async () => []) },
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
  newBatchId: jest.fn(() => 'batch-resolve-0001'),
}));

jest.mock('@/lib/exceptions/write', () => ({
  __esModule: true,
  upsertException: jest.fn(async () => ({ id: 1 })),
  resolveException: jest.fn(async () => ({ id: 1 })),
}));

import { POST as resolvePOST } from '@/app/api/inbound-shipments/[id]/lines/[lineId]/resolve/route';
import { requireApproved } from '@/lib/api-utils';
import { validateCSRFToken } from '@/lib/csrf';
import { enforceRateLimit, applyRateLimitHeaders } from '@/lib/rateLimit';
import { recordChange, newBatchId } from '@/lib/change-tracking';
import { resolveException } from '@/lib/exceptions/write';
import prisma from '@/lib/prisma';

const db = prisma as unknown as Record<string, any>;
const mockRecordChange = recordChange as jest.Mock;
const mockNewBatchId = newBatchId as jest.Mock;
const mockResolveException = resolveException as jest.Mock;

const APPROVED_USER = { id: 7, isAdmin: false, isApproved: true };
const ORDER_ID = 'cksupplyorder00000000001';
const LINE_ID = 501;
const PRODUCT_ID = 31;

const lineParams = { params: { id: ORDER_ID, lineId: String(LINE_ID) } } as never;

function mkReq(body: unknown) {
  return new NextRequest(
    `http://t/api/inbound-shipments/${ORDER_ID}/lines/${LINE_ID}/resolve`,
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
    },
  );
}

let lockedLineRow: Record<string, unknown> | null = null;

function lineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    status: StagingItemStatus.LABELING,
    description: 'Vial Blue',
    shipmentId: ORDER_ID,
    orderedProductId: PRODUCT_ID,
    resolvedProductId: PRODUCT_ID,
    orderedQuantity: 100,
    verifiedQuantity: 90,
    stockedQuantity: 0,
    disposedQuantity: 0,
    lineTotalCents: 100_000,
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

function headerRow() {
  return {
    id: ORDER_ID,
    supplierRef: 'PO-42',
    supplier: 'Acme',
    status: InboundShipmentStatus.RECEIVING,
    notes: null,
    createdBy: APPROVED_USER.id,
    closedBy: null,
    orderedAt: new Date('2026-08-14T00:00:00.000Z'),
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
  mockNewBatchId.mockReturnValue('batch-resolve-0001');
  mockResolveException.mockResolvedValue({ id: 1 });
  lockedLineRow = lineRow();

  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw.mockImplementation(async () => (lockedLineRow === null ? [] : [lockedLineRow]));
  db.inboundShipment.findUnique.mockImplementation(async () => headerRow());
  db.stagingItem.findMany.mockImplementation(async () => (lockedLineRow ? [lockedLineRow] : []));
  db.inventoryException.findMany.mockResolvedValue([]);
});

describe('POST .../resolve — the preamble', () => {
  it('requires approval, validates CSRF, rate-limits under a stable key and applies the headers', async () => {
    const res = await resolvePOST(
      mkReq({ exceptionKey: `recv-discrepancy:${LINE_ID}`, resolution: 'accepted-loss' }),
      lineParams,
    );

    expect(res.status).toBe(200);
    expect(requireApproved).toHaveBeenCalled();
    expect(validateCSRFToken).toHaveBeenCalled();
    expect((enforceRateLimit as jest.Mock).mock.calls[0][1]).toBe(
      'supply-order-exception-resolve:POST',
    );
    expect(applyRateLimitHeaders).toHaveBeenCalled();
  });

  it('mints ONE batchId, outside the retry', async () => {
    await resolvePOST(
      mkReq({ exceptionKey: `recv-discrepancy:${LINE_ID}`, resolution: 'accepted-loss' }),
      lineParams,
    );
    expect(mockNewBatchId).toHaveBeenCalledTimes(1);
  });

  it('400s a resolution outside the closed vocabulary', async () => {
    const res = await resolvePOST(
      mkReq({ exceptionKey: `recv-discrepancy:${LINE_ID}`, resolution: 'wrote-it-off' }),
      lineParams,
    );
    expect(res.status).toBe(400);
    expect(mockResolveException).not.toHaveBeenCalled();
  });
});

describe('POST .../resolve — the key must belong to this order + line', () => {
  it("404s a key for a DIFFERENT line", async () => {
    const res = await resolvePOST(
      mkReq({ exceptionKey: 'recv-discrepancy:999', resolution: 'accepted-loss' }),
      lineParams,
    );

    expect(res.status).toBe(404);
    expect(mockResolveException).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('404s a key of a kind this route does not settle', async () => {
    const res = await resolvePOST(
      mkReq({ exceptionKey: `cost-differs:${LINE_ID}`, resolution: 'accepted-loss' }),
      lineParams,
    );

    expect(res.status).toBe(404);
    expect(mockResolveException).not.toHaveBeenCalled();
  });

  it('404s when the line is not on this order (the locked read pins both ids)', async () => {
    lockedLineRow = null;

    const res = await resolvePOST(
      mkReq({ exceptionKey: `recv-discrepancy:${LINE_ID}`, resolution: 'accepted-loss' }),
      lineParams,
    );

    expect(res.status).toBe(404);
    expect(mockResolveException).not.toHaveBeenCalled();
  });

  it('404s when the key was never raised (nothing to settle, nothing to audit)', async () => {
    mockResolveException.mockResolvedValue(null);

    const res = await resolvePOST(
      mkReq({ exceptionKey: `recv-discrepancy:${LINE_ID}`, resolution: 'accepted-loss' }),
      lineParams,
    );

    expect(res.status).toBe(404);
    expect(recorded('EXCEPTION_RESOLVE')).toHaveLength(0);
  });
});

describe('POST .../resolve — recv-discrepancy', () => {
  it('recomputes the COMPLETE subject from the locked counters', async () => {
    const res = await resolvePOST(
      mkReq({
        exceptionKey: `recv-discrepancy:${LINE_ID}`,
        resolution: 'supplier-credited',
        note: 'credit note CN-9',
        creditRef: 'CN-9',
      }),
      lineParams,
    );

    expect(res.status).toBe(200);
    expect(mockResolveException).toHaveBeenCalledTimes(1);
    const [, args] = mockResolveException.mock.calls[0];
    expect(args).toMatchObject({
      key: `recv-discrepancy:${LINE_ID}`,
      resolvedBy: APPROVED_USER.id,
      resolution: 'supplier-credited',
      note: 'credit note CN-9',
    });
    expect(args.subjectPatch).toEqual({
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
      relatedShipmentId: null,
      creditRef: 'CN-9',
    });
  });

  it('carries relatedShipmentId when the units were reshipped, and NULLS the other', async () => {
    await resolvePOST(
      mkReq({
        exceptionKey: `recv-discrepancy:${LINE_ID}`,
        resolution: 'reshipped',
        relatedShipmentId: 'cksupplyorder00000000002',
      }),
      lineParams,
    );

    expect(mockResolveException.mock.calls[0][1].subjectPatch).toMatchObject({
      relatedShipmentId: 'cksupplyorder00000000002',
      creditRef: null,
    });
  });

  it('recomputes an OVER-delivery as surplus, never as a loss', async () => {
    lockedLineRow = lineRow({ verifiedQuantity: 110 });

    await resolvePOST(
      mkReq({ exceptionKey: `recv-discrepancy:${LINE_ID}`, resolution: 'surplus-kept' }),
      lineParams,
    );

    expect(mockResolveException.mock.calls[0][1].subjectPatch).toMatchObject({
      shortUnits: 0,
      overUnits: 10,
      lossCents: 0,
      surplusValueCents: 10_000,
    });
  });

  it('422s a line nobody has verified — there is no counted quantity to state', async () => {
    lockedLineRow = lineRow({ status: StagingItemStatus.ORDERED, verifiedQuantity: null });

    const res = await resolvePOST(
      mkReq({ exceptionKey: `recv-discrepancy:${LINE_ID}`, resolution: 'accepted-loss' }),
      lineParams,
    );

    expect(res.status).toBe(422);
    expect(mockResolveException).not.toHaveBeenCalled();
  });
});

describe('POST .../resolve — labeling-loss', () => {
  it('recomputes the CUMULATIVE subject and leaves the operator reason alone', async () => {
    lockedLineRow = lineRow({
      status: StagingItemStatus.COMPLETE,
      verifiedQuantity: 100,
      stockedQuantity: 60,
      disposedQuantity: 40,
    });

    const res = await resolvePOST(
      mkReq({ exceptionKey: `labeling-loss:${LINE_ID}`, resolution: 'accepted-loss' }),
      lineParams,
    );

    expect(res.status).toBe(200);
    const [, args] = mockResolveException.mock.calls[0];
    expect(args.key).toBe(`labeling-loss:${LINE_ID}`);
    expect(args.subjectPatch).toEqual({
      stagingItemId: LINE_ID,
      shipmentId: ORDER_ID,
      productId: PRODUCT_ID,
      units: 40,
      unitCostCents: 1000,
      lossCents: 40_000,
    });
    // `reason` is deliberately NOT in the patch: the writer merges, so the
    // operator's own words survive the settlement (spec §6 "reason (latest)").
    expect(Object.keys(args.subjectPatch)).not.toContain('reason');
  });
});

describe('POST .../resolve — the audit', () => {
  it('records EXCEPTION_RESOLVE against the LINE with the key in details (no new EntityType)', async () => {
    await resolvePOST(
      mkReq({
        exceptionKey: `recv-discrepancy:${LINE_ID}`,
        resolution: 'accepted-loss',
        note: 'not worth chasing',
      }),
      lineParams,
    );

    const events = recorded('EXCEPTION_RESOLVE');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityType: 'STAGING',
      entityId: LINE_ID,
      batchId: 'batch-resolve-0001',
    });
    expect(events[0].details).toMatchObject({
      key: `recv-discrepancy:${LINE_ID}`,
      resolution: 'accepted-loss',
      note: 'not worth chasing',
    });
  });

  it('answers the settled key plus the refreshed line view', async () => {
    const res = await resolvePOST(
      mkReq({ exceptionKey: `recv-discrepancy:${LINE_ID}`, resolution: 'accepted-loss' }),
      lineParams,
    );
    const json = await res.json();

    expect(json).toMatchObject({
      key: `recv-discrepancy:${LINE_ID}`,
      resolution: 'accepted-loss',
      lineId: LINE_ID,
    });
    expect(json.line).toMatchObject({ id: LINE_ID });
  });

  it('a writer failure propagates — the audit never lands', async () => {
    mockResolveException.mockRejectedValue(new Error('exception writer exploded'));

    const res = await resolvePOST(
      mkReq({ exceptionKey: `recv-discrepancy:${LINE_ID}`, resolution: 'accepted-loss' }),
      lineParams,
    );

    expect(res.status).toBe(500);
    expect(recorded('EXCEPTION_RESOLVE')).toHaveLength(0);
  });
});
