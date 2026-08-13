// @jest-environment node
/**
 * W1-2a — the receiving header API + its state matrix (contract pack REV-2 T4).
 *
 * Prisma is mocked (no DB); the REAL apiHandler is kept so ZodError -> 400 and
 * AppError -> its status map centrally, exactly as the routes rely on.
 *
 * The two atomic races are simulated at the CLAIM, which is where the real
 * serialization happens (the lib/staging/graduate.ts:69 idiom): the mocked
 * `updateMany` return count IS "did I win?". Nothing here reads-then-writes a
 * state decision, and the tests assert that.
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
    inboundShipment: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    stagingItem: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
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

import { GET as listGET, POST as createPOST } from '@/app/api/inbound-shipments/route';
import { GET as detailGET, PATCH } from '@/app/api/inbound-shipments/[id]/route';
import { requireApproved } from '@/lib/api-utils';
import { validateCSRFToken } from '@/lib/csrf';
import { recordChange } from '@/lib/change-tracking';
import prisma from '@/lib/prisma';

const db: any = prisma as any;
const mockValidateCSRF = validateCSRFToken as jest.Mock;
const mockRecordChange = recordChange as jest.Mock;

const APPROVED_USER = { id: 7, isAdmin: false, isApproved: true };
const SHIPMENT_ID = 'ckshipment000000000000001';

function setApprovedUser(user: any = APPROVED_USER) {
  (requireApproved as jest.Mock).mockResolvedValue({ user });
}

function mkReq(url: string, method: string, body?: any) {
  return new NextRequest(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
  });
}

function shipmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SHIPMENT_ID,
    supplierRef: 'PO-1',
    status: 'OPEN',
    notes: null,
    createdBy: APPROVED_USER.id,
    closedBy: null,
    createdAt: new Date('2026-08-13T10:00:00.000Z'),
    updatedAt: new Date('2026-08-13T10:00:00.000Z'),
    closedAt: null,
    creator: { id: APPROVED_USER.id, username: 'kris' },
    ...overrides,
  };
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    description: 'Box of vials',
    status: 'RECEIVED',
    expectedQuantity: 10,
    countedQuantity: null,
    unitCostCents: null,
    resolvedProductId: null,
    locationId: 1,
    vendor: null,
    reference: null,
    notes: null,
    shipmentId: SHIPMENT_ID,
    receivedAt: new Date('2026-08-13T11:00:00.000Z'),
    countedAt: null,
    countedBy: null,
    location: { id: 1, name: 'Main' },
    resolvedProduct: null,
    ...overrides,
  };
}

/** The detail re-read every successful PATCH performs before responding. */
function primeDetailRead(shipment = shipmentRow(), items: any[] = []) {
  db.inboundShipment.findUnique.mockResolvedValue(shipment);
  db.stagingItem.findMany.mockResolvedValue(items);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockValidateCSRF.mockResolvedValue(true);
  (db.$transaction as jest.Mock) = jest.fn(async (fn: any) => fn(db));
});

// ---------------------------------------------------------------------------
// POST /api/inbound-shipments
// ---------------------------------------------------------------------------

describe('POST /api/inbound-shipments (create)', () => {
  it('opens a shipment for the current user (201) and returns the summary shape', async () => {
    setApprovedUser();
    db.inboundShipment.create.mockResolvedValue(shipmentRow());

    const resp = await createPOST(
      mkReq('http://t/api/inbound-shipments', 'POST', { supplierRef: 'PO-1' })
    );

    expect(resp.status).toBe(201);
    const body = await resp.json();
    expect(body.id).toBe(SHIPMENT_ID);
    expect(body.status).toBe('OPEN');
    // A fresh shipment has no lines: the rollup is present and all-zero.
    expect(body.itemCount).toBe(0);
    expect(body.discrepancy).toEqual({
      itemCount: 0,
      countedItemCount: 0,
      uncountedItemCount: 0,
      discrepancyItemCount: 0,
      totalOver: 0,
      totalUnder: 0,
    });

    const args = db.inboundShipment.create.mock.calls[0][0];
    expect(args.data.createdBy).toBe(APPROVED_USER.id);
    expect(args.data.status).toBe('OPEN');
    expect(args.data.supplierRef).toBe('PO-1');
  });

  it('records SHIPMENT_CREATE against entityType SHIPMENT in the same tx', async () => {
    setApprovedUser();
    db.inboundShipment.create.mockResolvedValue(shipmentRow());

    await createPOST(mkReq('http://t/api/inbound-shipments', 'POST', {}));

    expect(mockRecordChange).toHaveBeenCalledTimes(1);
    expect(mockRecordChange.mock.calls[0][1]).toMatchObject({
      actionType: 'SHIPMENT_CREATE',
      entityType: 'SHIPMENT',
      entityId: SHIPMENT_ID,
      actor: { userId: APPROVED_USER.id },
    });
    // recordChange rides the SAME tx handle the create used (D4).
    expect(mockRecordChange.mock.calls[0][0]).toBe(db);
  });

  it('returns 403 on an invalid CSRF token (no write, no audit)', async () => {
    setApprovedUser();
    mockValidateCSRF.mockResolvedValue(false);

    const resp = await createPOST(
      mkReq('http://t/api/inbound-shipments', 'POST', { supplierRef: 'PO-1' })
    );

    expect(resp.status).toBe(403);
    expect(db.inboundShipment.create).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('returns 400 (Zod) when supplierRef exceeds the column width', async () => {
    setApprovedUser();

    const resp = await createPOST(
      mkReq('http://t/api/inbound-shipments', 'POST', { supplierRef: 'x'.repeat(256) })
    );

    expect(resp.status).toBe(400);
    expect(db.inboundShipment.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/inbound-shipments
// ---------------------------------------------------------------------------

describe('GET /api/inbound-shipments (list)', () => {
  it('lists every status when no filter is given and rolls up linked lines', async () => {
    setApprovedUser();
    db.inboundShipment.findMany.mockResolvedValue([shipmentRow()]);
    db.stagingItem.findMany.mockResolvedValue([
      { id: 1, shipmentId: SHIPMENT_ID, status: 'RECEIVED', expectedQuantity: 10, countedQuantity: 15 },
      { id: 2, shipmentId: SHIPMENT_ID, status: 'RECEIVED', expectedQuantity: 10, countedQuantity: 7 },
      { id: 3, shipmentId: SHIPMENT_ID, status: 'RECEIVED', expectedQuantity: 4, countedQuantity: null },
    ]);

    const resp = await listGET(mkReq('http://t/api/inbound-shipments', 'GET'));

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(db.inboundShipment.findMany.mock.calls[0][0].where).toEqual({});
    expect(body.shipments).toHaveLength(1);
    const entry = body.shipments[0];
    expect(entry.itemCount).toBe(3);
    expect(entry.receivedItemCount).toBe(3);
    expect(entry.uncountedReceivedItemCount).toBe(1);
    // NON-CANCELLING: +5 and -3 do not net to +2.
    expect(entry.discrepancy.totalOver).toBe(5);
    expect(entry.discrepancy.totalUnder).toBe(3);
    expect(entry.discrepancy.uncountedItemCount).toBe(1);
  });

  it('filters by status', async () => {
    setApprovedUser();
    db.inboundShipment.findMany.mockResolvedValue([]);

    const resp = await listGET(mkReq('http://t/api/inbound-shipments?status=OPEN', 'GET'));

    expect(resp.status).toBe(200);
    expect(db.inboundShipment.findMany.mock.calls[0][0].where).toEqual({ status: 'OPEN' });
  });

  it('rejects an unknown status with 400 rather than silently listing everything', async () => {
    setApprovedUser();

    const resp = await listGET(mkReq('http://t/api/inbound-shipments?status=BOGUS', 'GET'));

    expect(resp.status).toBe(400);
    expect(db.inboundShipment.findMany).not.toHaveBeenCalled();
  });

  it('skips the line query entirely when no shipment matched', async () => {
    setApprovedUser();
    db.inboundShipment.findMany.mockResolvedValue([]);

    const resp = await listGET(mkReq('http://t/api/inbound-shipments', 'GET'));

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ shipments: [] });
    expect(db.stagingItem.findMany).not.toHaveBeenCalled();
  });

  it('counts an unexpected arrival (expected NULL) in full', async () => {
    setApprovedUser();
    db.inboundShipment.findMany.mockResolvedValue([shipmentRow()]);
    db.stagingItem.findMany.mockResolvedValue([
      { id: 9, shipmentId: SHIPMENT_ID, status: 'RECEIVED', expectedQuantity: null, countedQuantity: 6 },
    ]);

    const resp = await listGET(mkReq('http://t/api/inbound-shipments', 'GET'));
    const body = await resp.json();

    expect(body.shipments[0].discrepancy.totalOver).toBe(6);
    expect(body.shipments[0].discrepancy.totalUnder).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/inbound-shipments/[id]
// ---------------------------------------------------------------------------

describe('GET /api/inbound-shipments/[id] (detail)', () => {
  it('returns 404 for an unknown id', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(null);

    const resp = await detailGET(mkReq('http://t/api/inbound-shipments/nope', 'GET'), {
      params: { id: 'nope' },
    });

    expect(resp.status).toBe(404);
  });

  it('returns the header, the linked lines with per-item flags, and the rollup', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
    db.stagingItem.findMany.mockResolvedValue([
      itemRow({ id: 1, expectedQuantity: 10, countedQuantity: 15 }),
      itemRow({ id: 2, expectedQuantity: null, countedQuantity: 3 }),
      itemRow({ id: 3, expectedQuantity: 8, countedQuantity: null }),
    ]);

    const resp = await detailGET(mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'GET'), {
      params: { id: SHIPMENT_ID },
    });

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.id).toBe(SHIPMENT_ID);
    expect(body.items).toHaveLength(3);
    expect(body.items[0].flags).toEqual({
      counted: true,
      expectedMissing: false,
      delta: 5,
      direction: 'OVER',
    });
    expect(body.items[1].flags).toEqual({
      counted: true,
      expectedMissing: true,
      delta: 3,
      direction: 'OVER',
    });
    expect(body.items[2].flags).toEqual({
      counted: false,
      expectedMissing: false,
      delta: null,
      direction: null,
    });
    expect(body.discrepancy.totalOver).toBe(8);
    expect(body.discrepancy.totalUnder).toBe(0);
    expect(body.discrepancy.uncountedItemCount).toBe(1);
    // the line query is scoped to this shipment
    expect(db.stagingItem.findMany.mock.calls[0][0].where).toEqual({ shipmentId: SHIPMENT_ID });
  });
});

// ---------------------------------------------------------------------------
// PATCH — field edits while OPEN
// ---------------------------------------------------------------------------

describe('PATCH /api/inbound-shipments/[id] (fields)', () => {
  it('edits notes/supplierRef while OPEN through an OPEN-guarded claim (200)', async () => {
    setApprovedUser();
    primeDetailRead(shipmentRow({ notes: 'late truck' }));
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });

    const resp = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { notes: 'late truck' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(resp.status).toBe(200);
    const claim = db.inboundShipment.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({ id: SHIPMENT_ID, status: 'OPEN' });
    expect(claim.data).toEqual({ notes: 'late truck' });
  });

  it('records SHIPMENT_UPDATE with a field diff', async () => {
    setApprovedUser();
    primeDetailRead(shipmentRow({ notes: null }));
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });

    await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { notes: 'late truck' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(mockRecordChange).toHaveBeenCalledTimes(1);
    expect(mockRecordChange.mock.calls[0][1]).toMatchObject({
      actionType: 'SHIPMENT_UPDATE',
      entityType: 'SHIPMENT',
      entityId: SHIPMENT_ID,
      changes: { notes: { from: null, to: 'late truck' } },
    });
  });

  it('writes no audit line when the value is unchanged (empty diff)', async () => {
    setApprovedUser();
    primeDetailRead(shipmentRow({ notes: 'same' }));
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });

    const resp = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { notes: 'same' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(resp.status).toBe(200);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('rejects a field edit on a CLOSED shipment with 409 (no audit)', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow({ status: 'CLOSED' }));
    db.inboundShipment.updateMany.mockResolvedValue({ count: 0 });

    const resp = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { notes: 'nope' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(resp.status).toBe(409);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('rejects a field edit on a CANCELLED shipment with 409', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow({ status: 'CANCELLED' }));
    db.inboundShipment.updateMany.mockResolvedValue({ count: 0 });

    const resp = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { supplierRef: 'PO-2' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(resp.status).toBe(409);
  });

  it('returns 404 for an unknown shipment', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(null);

    const resp = await PATCH(
      mkReq('http://t/api/inbound-shipments/nope', 'PATCH', { notes: 'x' }),
      { params: { id: 'nope' } }
    );

    expect(resp.status).toBe(404);
    expect(db.inboundShipment.updateMany).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty body (nothing to change)', async () => {
    setApprovedUser();

    const resp = await PATCH(mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', {}), {
      params: { id: SHIPMENT_ID },
    });

    expect(resp.status).toBe(400);
    expect(db.inboundShipment.updateMany).not.toHaveBeenCalled();
  });

  it('returns 400 for a reopen attempt (OPEN is not a transition in the matrix)', async () => {
    setApprovedUser();

    const resp = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'OPEN' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(resp.status).toBe(400);
    expect(db.inboundShipment.updateMany).not.toHaveBeenCalled();
  });

  it('returns 403 on an invalid CSRF token', async () => {
    setApprovedUser();
    mockValidateCSRF.mockResolvedValue(false);

    const resp = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { notes: 'x' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(resp.status).toBe(403);
    expect(db.inboundShipment.findUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PATCH — OPEN -> CLOSED
// ---------------------------------------------------------------------------

describe('PATCH /api/inbound-shipments/[id] (OPEN -> CLOSED)', () => {
  it('closes when every linked RECEIVED line is counted, stamping closedBy/closedAt', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
    db.stagingItem.findMany.mockResolvedValue([
      { id: 1, status: 'RECEIVED', expectedQuantity: 10, countedQuantity: 10 },
      { id: 2, status: 'GRADUATED', expectedQuantity: 5, countedQuantity: 5 },
    ]);
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });

    const resp = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CLOSED' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(resp.status).toBe(200);
    const claim = db.inboundShipment.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({ id: SHIPMENT_ID, status: 'OPEN' });
    expect(claim.data.status).toBe('CLOSED');
    expect(claim.data.closedBy).toBe(APPROVED_USER.id);
    expect(claim.data.closedAt).toBeInstanceOf(Date);
  });

  it('records SHIPMENT_CLOSE carrying the computed rollup', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
    db.stagingItem.findMany.mockResolvedValue([
      { id: 1, status: 'RECEIVED', expectedQuantity: 10, countedQuantity: 12 },
      { id: 2, status: 'RECEIVED', expectedQuantity: 10, countedQuantity: 9 },
    ]);
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });

    await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CLOSED' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(mockRecordChange).toHaveBeenCalledTimes(1);
    expect(mockRecordChange.mock.calls[0][1]).toMatchObject({
      actionType: 'SHIPMENT_CLOSE',
      entityType: 'SHIPMENT',
      entityId: SHIPMENT_ID,
      details: { itemCount: 2, totalOver: 2, totalUnder: 1 },
    });
  });

  it('REFUSES to close with uncounted RECEIVED lines: 409 listing the offenders', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
    db.stagingItem.findMany.mockResolvedValue([
      { id: 1, status: 'RECEIVED', expectedQuantity: 10, countedQuantity: 10 },
      { id: 4, status: 'RECEIVED', expectedQuantity: 10, countedQuantity: null },
      { id: 6, status: 'RECEIVED', expectedQuantity: null, countedQuantity: null },
    ]);

    const resp = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CLOSED' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.uncountedItemIds).toEqual([4, 6]);
    // nothing was written and nothing was recorded
    expect(db.inboundShipment.updateMany).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('ignores GRADUATED/DISCARDED lines when deciding closeability', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
    db.stagingItem.findMany.mockResolvedValue([
      { id: 1, status: 'DISCARDED', expectedQuantity: 10, countedQuantity: null },
      { id: 2, status: 'GRADUATED', expectedQuantity: 5, countedQuantity: 5 },
    ]);
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });

    const resp = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CLOSED' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(resp.status).toBe(200);
  });

  it('RACE: a lost close claim (count 0) is a 409 and records nothing', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
    db.stagingItem.findMany.mockResolvedValue([]);
    db.inboundShipment.updateMany.mockResolvedValue({ count: 0 });

    const resp = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CLOSED' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(resp.status).toBe(409);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PATCH — OPEN -> CANCELLED
// ---------------------------------------------------------------------------

describe('PATCH /api/inbound-shipments/[id] (OPEN -> CANCELLED)', () => {
  it('cancels via an atomic claim and AUTO-UNLINKS the linked RECEIVED lines', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
    db.stagingItem.findMany
      .mockResolvedValueOnce([{ id: 11 }, { id: 12 }]) // about to be unlinked
      .mockResolvedValueOnce([]) // no GRADUATED line remains linked
      .mockResolvedValue([]); // the detail re-read
    db.stagingItem.updateMany.mockResolvedValue({ count: 2 });

    const resp = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CANCELLED' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(resp.status).toBe(200);
    const claim = db.inboundShipment.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({ id: SHIPMENT_ID, status: 'OPEN' });
    expect(claim.data.status).toBe('CANCELLED');

    // The unlink is itself an atomic claim scoped to RECEIVED lines: the items
    // stay in staging, they only lose the header.
    const unlink = db.stagingItem.updateMany.mock.calls[0][0];
    expect(unlink.where).toEqual({ shipmentId: SHIPMENT_ID, status: 'RECEIVED' });
    expect(unlink.data).toEqual({ shipmentId: null });
  });

  it('records SHIPMENT_CANCEL naming the auto-unlinked lines', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
    db.stagingItem.findMany
      .mockResolvedValueOnce([{ id: 11 }, { id: 12 }])
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);
    db.stagingItem.updateMany.mockResolvedValue({ count: 2 });

    await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CANCELLED' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(mockRecordChange).toHaveBeenCalledTimes(1);
    expect(mockRecordChange.mock.calls[0][1]).toMatchObject({
      actionType: 'SHIPMENT_CANCEL',
      entityType: 'SHIPMENT',
      entityId: SHIPMENT_ID,
      details: { unlinkedItemIds: [11, 12] },
    });
  });

  it('RACE (cancel vs graduate) — GRADUATE WON: a linked GRADUATED line aborts the cancel (409, no audit)', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
    db.stagingItem.findMany
      .mockResolvedValueOnce([]) // the racing line already flipped out of RECEIVED
      .mockResolvedValueOnce([{ id: 12 }]); // ...and is linked as GRADUATED
    db.stagingItem.updateMany.mockResolvedValue({ count: 0 });

    const resp = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CANCELLED' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.graduatedItemIds).toEqual([12]);
    // The claim already wrote — the whole transaction must roll back, so no
    // SHIPMENT_CANCEL line is ever recorded.
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('RACE (cancel vs graduate) — CANCEL WON: the line is unlinked and stays in staging', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
    db.stagingItem.findMany
      .mockResolvedValueOnce([{ id: 12 }])
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);
    db.stagingItem.updateMany.mockResolvedValue({ count: 1 });

    const resp = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CANCELLED' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(resp.status).toBe(200);
    expect(db.stagingItem.updateMany.mock.calls[0][0].data).toEqual({ shipmentId: null });
    expect(mockRecordChange).toHaveBeenCalledTimes(1);
  });

  it('RACE (two cancels) — a lost claim (count 0) never unlinks anything', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
    db.inboundShipment.updateMany.mockResolvedValue({ count: 0 });

    const resp = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CANCELLED' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(resp.status).toBe(409);
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('cancelling an already-CANCELLED shipment is a 409', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow({ status: 'CANCELLED' }));
    db.inboundShipment.updateMany.mockResolvedValue({ count: 0 });

    const resp = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CANCELLED' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(resp.status).toBe(409);
  });
});
