// @jest-environment node
/**
 * W1-2c — the count endpoint's EXCEPTION seam (contract pack REV-3 T1 + T4).
 *
 * The count endpoint is where a discrepancy becomes KNOWN, so it is where the
 * discrepancy becomes a ROW. Everything here is about that one seam:
 *
 *   delta != 0   ->  upsert `recv-discrepancy:<stagingItemId>` with the VALUES
 *   delta == 0   ->  resolve the key (auto: resolvedBy NULL, "recount matched")
 *
 * Delta is T4's arithmetic, unchanged and NOT re-derived here: the route feeds
 * the exception from the SAME `lineDiscrepancy` result it puts in the response,
 * so an unexpected arrival (`expectedQuantity` NULL) raises an exception for the
 * FULL counted quantity rather than quietly reporting "no discrepancy".
 *
 * SAME TRANSACTION, always: the exception delegate used is the tx client the
 * count claim was written through, so a rolled-back count can never leave an
 * exception row behind — and a 409'd count writes nothing at all.
 *
 * The writer module is deliberately NOT mocked. These tests assert the ROW,
 * because "an exception row appears" is the contract, not "a function was
 * called".
 */

import { NextRequest } from 'next/server';

jest.mock('@/lib/api-utils', () => {
  const actual = jest.requireActual('@/lib/api-utils');
  return {
    __esModule: true,
    ...actual,
    requireApproved: jest.fn(),
  };
});

jest.mock('@/lib/prisma', () => {
  const tx: any = {
    stagingItem: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    inboundShipment: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    inventoryException: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      // M7B-D1: the writer's WRITE is now `updateMany` (DML on the latest
      // committed row) followed by a locking re-read. The stub delegates to the
      // `update` mock these cases already assert on, so the args pins hold, and
      // reports the one row MySQL would.
      updateMany: jest.fn(async (args: any) => {
        await tx.inventoryException.update(args);
        return { count: 1 };
      }),
    },
    // Receiving/Labeling overhaul (pack C2b.3 / PK-11): the writer's read is now a
    // LOCKING `SELECT ... FOR UPDATE` rather than a `findUnique`. The stub answers
    // from the same `findUnique` mock these cases already configure, so the
    // register's row shape stays set up in exactly one place.
    $queryRaw: jest.fn(async () => {
      const row = await tx.inventoryException.findUnique({});
      return row ? [row] : [];
    }),
  };
  return {
    __esModule: true,
    default: {
      ...tx,
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    },
  };
});

jest.mock('@/lib/csrf', () => ({
  validateCSRFToken: jest.fn(async () => true),
}));

jest.mock('@/lib/rateLimit', () => ({
  __esModule: true,
  RateLimitError: jest.requireActual('@/lib/rateLimit').RateLimitError,
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((resp: any) => resp),
}));

jest.mock('@/lib/change-tracking', () => ({
  __esModule: true,
  recordChange: jest.fn(async () => undefined),
}));

import { POST } from '@/app/api/staging-items/[id]/count/route';
import { requireApproved } from '@/lib/api-utils';
import { validateCSRFToken } from '@/lib/csrf';
import prisma from '@/lib/prisma';

const db: any = prisma as any;
const mockValidateCSRF = validateCSRFToken as jest.Mock;

const APPROVED_USER = { id: 7, isAdmin: false, isApproved: true };
const SHIPMENT = 'ckshipment00000000000000a';
const KEY = 'recv-discrepancy:5';

function mkReq(body: unknown, id = '5') {
  return new NextRequest(`http://t/api/staging-items/${id}/count`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
  });
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    status: 'RECEIVED',
    expectedQuantity: 10,
    countedQuantity: null,
    resolvedProductId: null,
    shipmentId: null,
    ...overrides,
  };
}

/** A stored exception row as the DB would hand it back. */
function exceptionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    key: KEY,
    kind: 'recv-discrepancy',
    subject: { stagingItemId: 5, shipmentId: null, productId: null, expectedQty: 10, countedQty: 12 },
    firstSeenAt: new Date('2026-08-12T00:00:00.000Z'),
    lastSeenAt: new Date('2026-08-12T00:00:00.000Z'),
    resolvedAt: null,
    resolvedBy: null,
    note: null,
    ...overrides,
  };
}

const created = () => db.inventoryException.create.mock.calls[0][0].data;
const updated = () => db.inventoryException.update.mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
  mockValidateCSRF.mockResolvedValue(true);
  (requireApproved as jest.Mock).mockResolvedValue({ user: APPROVED_USER });
  (db.$transaction as jest.Mock) = jest.fn(async (fn: any) => fn(db));
  db.stagingItem.updateMany.mockResolvedValue({ count: 1 });
  // Default: a linked shipment is OPEN, so the claim guard passes (the 409 cases
  // below override it).
  db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
  db.inventoryException.findUnique.mockResolvedValue(null);
  db.inventoryException.create.mockImplementation(async ({ data }: any) => ({ id: 1, ...data }));
  db.inventoryException.update.mockImplementation(async ({ data }: any) => ({ id: 1, ...data }));
});

describe('count -> a NON-ZERO delta raises the discrepancy row', () => {
  it('creates recv-discrepancy:<stagingItemId> in the same transaction as the count', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ expectedQuantity: 10 }));

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.inventoryException.create).toHaveBeenCalledTimes(1);
    expect(created()).toMatchObject({ key: KEY, kind: 'recv-discrepancy' });
  });

  it('carries the VALUES in subject, not just the ids (retroactive tolerance)', async () => {
    db.stagingItem.findUnique.mockResolvedValue(
      itemRow({ expectedQuantity: 10, resolvedProductId: 42, shipmentId: SHIPMENT }),
    );

    await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(created().subject).toEqual({
      stagingItemId: 5,
      shipmentId: SHIPMENT,
      productId: 42,
      expectedQty: 10,
      countedQty: 12,
    });
  });

  it('stamps lastSeenAt with the SAME instant the count was stamped with', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow());

    await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    const countedAt = db.stagingItem.updateMany.mock.calls[0][0].data.countedAt;
    expect(created().lastSeenAt).toBe(countedAt);
    expect(created().firstSeenAt).toBe(countedAt);
  });

  it('raises the row for an UNDER-count too', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ expectedQuantity: 12 }));

    await POST(mkReq({ countedQuantity: 9 }), { params: { id: '5' } });

    expect(created().subject).toMatchObject({ expectedQty: 12, countedQty: 9 });
  });

  it('an UNEXPECTED arrival (NULL expected) raises for the FULL count, recording expectedQty NULL', async () => {
    // The T4 rule: delta = counted - COALESCE(expected, 0). The SUBJECT keeps the
    // truth (`null`), never a fabricated 0 — the delta is derivable from it.
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ expectedQuantity: null }));

    await POST(mkReq({ countedQuantity: 6 }), { params: { id: '5' } });

    expect(db.inventoryException.create).toHaveBeenCalledTimes(1);
    expect(created().subject).toEqual({
      stagingItemId: 5,
      shipmentId: null,
      productId: null,
      expectedQty: null,
      countedQty: 6,
    });
  });

  it('an existing key is UPDATED, not duplicated (a recount that stays wrong)', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ expectedQuantity: 10, countedQuantity: 12 }));
    db.inventoryException.findUnique.mockResolvedValue(exceptionRow());

    await POST(mkReq({ countedQuantity: 15 }), { params: { id: '5' } });

    expect(db.inventoryException.create).not.toHaveBeenCalled();
    expect(updated().where).toEqual({ key: KEY });
    expect(updated().data.subject).toMatchObject({ countedQty: 15 });
  });

  it('a recount that DISAGREES with a resolved row REOPENS it', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ expectedQuantity: 10, countedQuantity: 10 }));
    db.inventoryException.findUnique.mockResolvedValue(
      exceptionRow({ resolvedAt: new Date('2026-08-12T10:00:00.000Z'), resolvedBy: 7, note: 'auto: recount matched' }),
    );

    await POST(mkReq({ countedQuantity: 13 }), { params: { id: '5' } });

    expect(updated().data.resolvedAt).toBeNull();
    expect(updated().data.resolvedBy).toBeNull();
    expect(updated().data.note).toContain('auto: recount matched');
    expect(updated().data.note).toMatch(/reopen/i);
  });
});

describe('count -> a ZERO delta auto-resolves', () => {
  it('resolves a previously-nonzero discrepancy with resolvedBy NULL and the auto note', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ expectedQuantity: 12, countedQuantity: 9 }));
    db.inventoryException.findUnique.mockResolvedValue(
      exceptionRow({ subject: { stagingItemId: 5, shipmentId: null, productId: null, expectedQty: 12, countedQty: 9 } }),
    );

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(resp.status).toBe(200);
    expect(db.inventoryException.create).not.toHaveBeenCalled();
    expect(updated().where).toEqual({ key: KEY });
    expect(updated().data.resolvedAt).toBeInstanceOf(Date);
    expect(updated().data.resolvedBy).toBeNull();
    expect(updated().data.note).toBe('auto: recount matched');
  });

  it('writes NOTHING when a matching count never had an exception (the common path)', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ expectedQuantity: 12 }));
    db.inventoryException.findUnique.mockResolvedValue(null);

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(resp.status).toBe(200);
    expect(db.inventoryException.create).not.toHaveBeenCalled();
    expect(db.inventoryException.update).not.toHaveBeenCalled();
  });

  it('a CONFIRMING recount on an already-resolved row rewrites nothing (idempotent)', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ expectedQuantity: 12, countedQuantity: 12 }));
    db.inventoryException.findUnique.mockResolvedValue(
      exceptionRow({ resolvedAt: new Date('2026-08-12T10:00:00.000Z'), note: 'auto: recount matched' }),
    );

    await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(db.inventoryException.update).not.toHaveBeenCalled();
  });

  it('a count of ZERO against a ZERO expectation is a match, not a discrepancy', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ expectedQuantity: 0 }));

    await POST(mkReq({ countedQuantity: 0 }), { params: { id: '5' } });

    expect(db.inventoryException.create).not.toHaveBeenCalled();
  });
});

describe('count -> a refused count writes NO exception', () => {
  it('409 (item already GRADUATED): nothing raised', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ status: 'GRADUATED', countedQuantity: 4 }));

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(resp.status).toBe(409);
    expect(db.inventoryException.create).not.toHaveBeenCalled();
    expect(db.inventoryException.update).not.toHaveBeenCalled();
  });

  it('409 (shipment CLOSED): nothing raised', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT }));
    db.inboundShipment.updateMany.mockResolvedValue({ count: 0 });
    db.inboundShipment.findUnique.mockResolvedValue({ id: SHIPMENT, status: 'CLOSED' });

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(resp.status).toBe(409);
    expect(db.inventoryException.create).not.toHaveBeenCalled();
  });

  it('409 (LOST claim — the row moved mid-flight): nothing raised', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow());
    db.stagingItem.updateMany.mockResolvedValue({ count: 0 });

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(resp.status).toBe(409);
    expect(db.inventoryException.create).not.toHaveBeenCalled();
  });

  it('400 (invalid body): nothing raised, nothing read', async () => {
    const resp = await POST(mkReq({ countedQuantity: -1 }), { params: { id: '5' } });

    expect(resp.status).toBe(400);
    expect(db.inventoryException.findUnique).not.toHaveBeenCalled();
  });
});

describe('the W1-2b response contract is unchanged by the exception wiring (seam S2/S10)', () => {
  it('returns exactly the documented shape — no exception fields leak into it', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ expectedQuantity: 10 }));

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });
    const json = await resp.json();

    expect(json).toEqual({
      id: 5,
      status: 'RECEIVED',
      countedQuantity: 12,
      previousCountedQuantity: null,
      recount: false,
      countedBy: 7,
      countedAt: expect.any(String),
      expectedQuantity: 10,
      shipmentId: null,
      discrepancy: { counted: true, expectedMissing: false, delta: 2, direction: 'OVER' },
    });
  });
});
