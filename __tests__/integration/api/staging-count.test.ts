// @jest-environment node
/**
 * W1-2b — `POST /api/staging-items/[id]/count` (contract pack REV-3 T2/T4).
 *
 * Counting is its OWN verb, removed from the generic PATCH surface: a count is
 * a physical act by a named person at a named time, so it stamps countedBy /
 * countedAt and it is ALWAYS audited — the first count as much as the fifth
 * (the recount line carries old -> new, which is the whole point of the weekly
 * count protocol).
 *
 * The 409 matrix (amended T4):
 *   item not RECEIVED           -> 409   (graduated stock is not re-countable)
 *   linked shipment CLOSED      -> 409   (receiving ended; graduation still legal)
 *   linked shipment CANCELLED   -> 409
 *   lost claim (raced)          -> 409, nothing recorded
 *
 * A countedQuantity of 0 is LEGAL here — "the box was empty" is a fact. The
 * 422 for a zero count is W1-3a's GRADUATION rule, not this endpoint's.
 *
 * W1-3b RIDE-ALONG A (lock order): the item claim now runs BEFORE the shipment
 * claim, matching graduation's item -> shipment order (the ABBA deadlock found
 * at W1-3a). The shipment-guard 409s therefore reach the DB with the item claim
 * already issued — and are still absolutely safe, because the guard's throw
 * unwinds the transaction and rolls that claim back. Those tests now assert the
 * ROLLBACK (the tx callback rejected) instead of "the claim was never issued",
 * which is what the transaction actually guarantees.
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
  const tx = {
    stagingItem: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    inboundShipment: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    // W1-2c wired the exceptions register into this route's transaction. The
    // delegate is stubbed here so the route LOADS and runs; what it writes is
    // owned by staging-count-exceptions.test.ts, not by this file.
    inventoryException: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
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
import { recordChange } from '@/lib/change-tracking';
import prisma from '@/lib/prisma';

const db: any = prisma as any;
const mockValidateCSRF = validateCSRFToken as jest.Mock;
const mockRecordChange = recordChange as jest.Mock;

const APPROVED_USER = { id: 7, isAdmin: false, isApproved: true };
const SHIPMENT = 'ckshipment00000000000000a';

function setApprovedUser(user: any = APPROVED_USER) {
  (requireApproved as jest.Mock).mockResolvedValue({ user });
}

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
    shipmentId: null,
    ...overrides,
  };
}

const actionTypes = () => mockRecordChange.mock.calls.map((c) => c[1].actionType);

/**
 * True when the transaction callback threw — i.e. the whole transaction unwound
 * and every write inside it (the count claim included) rolled back. With a
 * mocked client that is the only honest way to say "nothing persisted".
 */
let txRolledBack: boolean;

beforeEach(() => {
  jest.clearAllMocks();
  mockValidateCSRF.mockResolvedValue(true);
  txRolledBack = false;
  (db.$transaction as jest.Mock) = jest.fn(async (fn: any) => {
    try {
      return await fn(db);
    } catch (err) {
      txRolledBack = true;
      throw err;
    }
  });
  db.stagingItem.updateMany.mockResolvedValue({ count: 1 });
  db.inventoryException.findUnique.mockResolvedValue(null);
});

describe('POST /api/staging-items/[id]/count — the first count', () => {
  it('stamps countedQuantity + countedBy + countedAt in ONE claim (200)', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow());

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);

    // The write is an atomic claim on (id, RECEIVED) — never a read-then-write.
    const claim = db.stagingItem.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({ id: 5, status: 'RECEIVED' });
    expect(claim.data.countedQuantity).toBe(12);
    expect(claim.data.countedBy).toBe(7);
    expect(claim.data.countedAt).toBeInstanceOf(Date);
  });

  it('returns the shape W1-3a + W1-4b consume (incl. the computed discrepancy)', async () => {
    setApprovedUser();
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
    // countedAt round-trips as the SAME instant that was written.
    expect(json.countedAt).toBe(
      db.stagingItem.updateMany.mock.calls[0][0].data.countedAt.toISOString(),
    );
  });

  it('audits the first count as STAGING_RECOUNT with from = NULL', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow());

    await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(actionTypes()).toEqual(['STAGING_RECOUNT']);
    expect(mockRecordChange.mock.calls[0][1]).toMatchObject({
      actor: { userId: 7 },
      entityType: 'STAGING',
      entityId: 5,
      changes: { countedQuantity: { from: null, to: 12 } },
      details: { previousCountedQuantity: null, recount: false, shipmentId: null },
    });
  });

  it('accepts a count of ZERO (an empty box is a fact; the 422 is graduation-side)', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ expectedQuantity: 12 }));

    const resp = await POST(mkReq({ countedQuantity: 0 }), { params: { id: '5' } });
    const json = await resp.json();

    expect(resp.status).toBe(200);
    expect(db.stagingItem.updateMany.mock.calls[0][0].data.countedQuantity).toBe(0);
    expect(json.discrepancy).toEqual({
      counted: true,
      expectedMissing: false,
      delta: -12,
      direction: 'UNDER',
    });
  });

  it('counts an UNEXPECTED arrival in full (NULL expected -> delta = counted)', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ expectedQuantity: null }));

    const resp = await POST(mkReq({ countedQuantity: 6 }), { params: { id: '5' } });
    const json = await resp.json();

    expect(json.discrepancy).toEqual({
      counted: true,
      expectedMissing: true,
      delta: 6,
      direction: 'OVER',
    });
  });
});

describe('POST /api/staging-items/[id]/count — recount', () => {
  it('audits old -> new and reports previousCountedQuantity + recount:true', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ countedQuantity: 9 }));

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });
    const json = await resp.json();

    expect(resp.status).toBe(200);
    expect(json.previousCountedQuantity).toBe(9);
    expect(json.recount).toBe(true);
    expect(mockRecordChange.mock.calls[0][1]).toMatchObject({
      actionType: 'STAGING_RECOUNT',
      changes: { countedQuantity: { from: 9, to: 12 } },
      details: { previousCountedQuantity: 9, recount: true },
    });
  });

  it('a CONFIRMING recount (same number) still stamps and still records', async () => {
    // Deliberate divergence from the ER-B9 "from === to drops" diff idiom: the
    // event's subject is the COUNT ACT, not the field delta. "We recounted and
    // it is still 12" is exactly the evidence the weekly protocol produces.
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ countedQuantity: 12 }));

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(resp.status).toBe(200);
    expect(db.stagingItem.updateMany.mock.calls[0][0].data.countedAt).toBeInstanceOf(Date);
    expect(actionTypes()).toEqual(['STAGING_RECOUNT']);
    expect(mockRecordChange.mock.calls[0][1].changes).toEqual({
      countedQuantity: { from: 12, to: 12 },
    });
  });
});

describe('POST /api/staging-items/[id]/count — the 409 matrix', () => {
  it('409s a GRADUATED item, writing and recording nothing', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ status: 'GRADUATED', countedQuantity: 4 }));

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(resp.status).toBe(409);
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('409s a DISCARDED item', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ status: 'DISCARDED' }));

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(resp.status).toBe(409);
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
  });

  it('409s when the linked shipment is CLOSED (count is receiving work)', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT }));
    db.inboundShipment.updateMany.mockResolvedValue({ count: 0 });
    db.inboundShipment.findUnique.mockResolvedValue({ id: SHIPMENT, status: 'CLOSED' });

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(resp.status).toBe(409);
    expect(db.inboundShipment.updateMany.mock.calls[0][0].where).toEqual({
      id: SHIPMENT,
      status: 'OPEN',
    });
    // W1-3b: the item claim is issued first now, and the guard's throw unwinds
    // the transaction — so it never persists.
    expect(txRolledBack).toBe(true);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('409s when the linked shipment is CANCELLED', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT }));
    db.inboundShipment.updateMany.mockResolvedValue({ count: 0 });
    db.inboundShipment.findUnique.mockResolvedValue({ id: SHIPMENT, status: 'CANCELLED' });

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(resp.status).toBe(409);
    expect(txRolledBack).toBe(true);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('counts a line on an OPEN shipment (the claim is the guard)', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT }));
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });
    const json = await resp.json();

    expect(resp.status).toBe(200);
    expect(json.shipmentId).toBe(SHIPMENT);
    expect(actionTypes()).toEqual(['STAGING_RECOUNT']);
    expect(mockRecordChange.mock.calls[0][1].details.shipmentId).toBe(SHIPMENT);
  });

  it('404s when the linked shipment id is unknown', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT }));
    db.inboundShipment.updateMany.mockResolvedValue({ count: 0 });
    db.inboundShipment.findUnique.mockResolvedValue(null);

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(resp.status).toBe(404);
    expect(txRolledBack).toBe(true);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('RACE: a lost item claim (it graduated mid-flight) is a 409 and records nothing', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow());
    db.stagingItem.updateMany.mockResolvedValue({ count: 0 });

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(resp.status).toBe(409);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('404s an unknown staging item before any shipment work', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(null);

    const resp = await POST(mkReq({ countedQuantity: 12 }, '999'), { params: { id: '999' } });

    expect(resp.status).toBe(404);
    expect(db.inboundShipment.updateMany).not.toHaveBeenCalled();
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/staging-items/[id]/count — request validation + guards', () => {
  it('400s a negative count, without touching the DB', async () => {
    setApprovedUser();

    const resp = await POST(mkReq({ countedQuantity: -1 }), { params: { id: '5' } });

    expect(resp.status).toBe(400);
    expect(db.stagingItem.findUnique).not.toHaveBeenCalled();
  });

  it('400s a non-integer count', async () => {
    setApprovedUser();

    const resp = await POST(mkReq({ countedQuantity: 1.5 }), { params: { id: '5' } });

    expect(resp.status).toBe(400);
  });

  it('400s a missing countedQuantity', async () => {
    setApprovedUser();

    const resp = await POST(mkReq({}), { params: { id: '5' } });

    expect(resp.status).toBe(400);
  });

  it('400s a non-numeric route id', async () => {
    setApprovedUser();

    const resp = await POST(mkReq({ countedQuantity: 1 }, 'abc'), { params: { id: 'abc' } });

    expect(resp.status).toBe(400);
    expect(db.stagingItem.findUnique).not.toHaveBeenCalled();
  });

  it('403s without a valid CSRF token, before any read', async () => {
    setApprovedUser();
    mockValidateCSRF.mockResolvedValue(false);

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(resp.status).toBe(403);
    expect(db.stagingItem.findUnique).not.toHaveBeenCalled();
  });

  it('propagates the approval guard (403 for an unapproved account)', async () => {
    const { AppError } = jest.requireActual('@/lib/error-handling');
    (requireApproved as jest.Mock).mockRejectedValue(
      new AppError('Account pending approval', 'FORBIDDEN', 403),
    );

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(resp.status).toBe(403);
    expect(db.stagingItem.findUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// W1-3b RIDE-ALONG A — THE LOCK ORDER (the ABBA found at W1-3a).
// ---------------------------------------------------------------------------

/**
 * Counting and graduating touch the SAME two rows: the staging item and its
 * inbound shipment. W1-3a took them in the order item -> shipment; this endpoint
 * took them shipment -> item. Two people working the same box at the same
 * instant could therefore each hold the lock the other needed — a real InnoDB
 * deadlock, on the exact pair of actions the receiving workflow tells people to
 * do back-to-back.
 *
 * The fix is not a retry, it is an ORDER: every writer takes the item first.
 * A call-sequence pin is the only thing that can hold that, because nothing in
 * the type system or the response shape changes when someone reorders two
 * awaits.
 */
describe('POST /api/staging-items/[id]/count — lock order (ABBA fix)', () => {
  it('claims the ITEM before the SHIPMENT, matching graduation', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT }));

    const order: string[] = [];
    db.stagingItem.updateMany.mockImplementation(async () => {
      order.push('item-claim');
      return { count: 1 };
    });
    db.inboundShipment.updateMany.mockImplementation(async () => {
      order.push('shipment-claim');
      return { count: 1 };
    });

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(resp.status).toBe(200);
    expect(order).toEqual(['item-claim', 'shipment-claim']);
  });

  it('an UNLINKED item takes exactly one lock (no shipment work at all)', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: null }));

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(resp.status).toBe(200);
    expect(db.inboundShipment.updateMany).not.toHaveBeenCalled();
  });

  it('a LOST item claim never reaches the shipment (the 409 settles it first)', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT }));
    db.stagingItem.updateMany.mockResolvedValue({ count: 0 });

    const resp = await POST(mkReq({ countedQuantity: 12 }), { params: { id: '5' } });

    expect(resp.status).toBe(409);
    expect(db.inboundShipment.updateMany).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });
});
