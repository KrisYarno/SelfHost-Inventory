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
    // FD2-1: the settle paths' ONE current read (`... FOR UPDATE`).
    $queryRaw: jest.fn(async () => []),
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

import { SHIPMENT_LIST_LIMIT } from '@/lib/shipments/queries';
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

/** A staging line as the two reads below hand it back. */
function stagingLine(over: Record<string, unknown> = {}) {
  return { id: 1, status: 'RECEIVED', expectedQuantity: 10, countedQuantity: 10, ...over };
}

/**
 * Drive the settle paths' TWO reads of the shipment's lines, which FD2-1 made
 * deliberately different things:
 *
 *   SNAPSHOT  `stagingItem.findMany` — what this transaction's REPEATABLE READ
 *             snapshot shows, and therefore the set the ascending first-pass
 *             locks are taken over (deadlock ordering);
 *   CURRENT   `$queryRaw ... FOR UPDATE` — what MySQL holds RIGHT NOW, after the
 *             header claim. Every downstream decision reads THIS.
 *
 * Passing only `snapshot` makes the two agree, which is the uneventful case.
 * `include` is getInboundShipmentDetail's re-read (shape-only here).
 */
function shipmentLines(snapshot: any[], current: any[] = snapshot) {
  db.stagingItem.findMany.mockImplementation(async (args: any) => {
    if (args?.include) return [];
    const status = args?.where?.status;
    if (status === undefined) return snapshot;
    return snapshot.filter((l: any) => (l.status ?? 'RECEIVED') === status);
  });
  db.$queryRaw.mockResolvedValue(current);
}

/**
 * Drive the staging-item CLAIMS. After FD2-1 exactly two shapes reach the
 * delegate on a settle path: the per-line no-op LOCK of the first pass, and the
 * cancel's set-wide unlink.
 *
 * `lockable` is which lines the first pass can still claim — leave it null for
 * "all of them" (nothing moved), or name a subset to simulate a line that left
 * the shipment (or graduated) between the snapshot and the locks.
 */
function stagingClaims({ lockable = null }: { lockable?: number[] | null } = {}) {
  db.stagingItem.updateMany.mockImplementation(async (args: any) => {
    if (args.data && 'shipmentId' in args.data) return { count: 1 };
    if (args.where.id !== undefined) {
      return { count: lockable === null || lockable.includes(args.where.id) ? 1 : 0 };
    }
    return { count: 1 };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockValidateCSRF.mockResolvedValue(true);
  (db.$transaction as jest.Mock) = jest.fn(async (fn: any) => fn(db));
  db.$queryRaw.mockResolvedValue([]);
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

  it('QA-5: a DISCARDED never-counted line is not permanently "uncounted" on the list', async () => {
    setApprovedUser();
    db.inboundShipment.findMany.mockResolvedValue([shipmentRow()]);
    db.stagingItem.findMany.mockResolvedValue([
      { id: 1, shipmentId: SHIPMENT_ID, status: 'RECEIVED', expectedQuantity: 10, countedQuantity: 10 },
      // Logged, then thrown away before anybody counted it: a decision, not an
      // omission. It used to pin "1 uncounted" on this shipment forever and
      // suppress "No discrepancies" with it.
      { id: 2, shipmentId: SHIPMENT_ID, status: 'DISCARDED', expectedQuantity: 4, countedQuantity: null },
    ]);

    const resp = await listGET(mkReq('http://t/api/inbound-shipments', 'GET'));
    const entry = (await resp.json()).shipments[0];

    expect(entry.discrepancy.uncountedItemCount).toBe(0);
    // The close guard's number and the rollup's now AGREE, which is the whole fix.
    expect(entry.uncountedReceivedItemCount).toBe(0);
    // The census is unchanged: both lines are still linked to this shipment.
    expect(entry.itemCount).toBe(2);
    expect(entry.discrepancy.countedItemCount).toBe(1);
  });

  it('QA-6: bounds the page (newest first) instead of listing every shipment ever', async () => {
    setApprovedUser();
    db.inboundShipment.findMany.mockResolvedValue([shipmentRow()]);
    db.stagingItem.findMany.mockResolvedValue([]);

    await listGET(mkReq('http://t/api/inbound-shipments', 'GET'));

    const args = db.inboundShipment.findMany.mock.calls[0][0];
    expect(SHIPMENT_LIST_LIMIT).toBe(100);
    expect(args.take).toBe(SHIPMENT_LIST_LIMIT);
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    // The line query is scoped to the ids the bounded page returned — never to
    // "every shipment id in the table".
    expect(db.stagingItem.findMany.mock.calls[0][0].where).toEqual({
      shipmentId: { in: [SHIPMENT_ID] },
    });
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
    shipmentLines([
      stagingLine({ id: 1 }),
      stagingLine({ id: 2, status: 'GRADUATED', expectedQuantity: 5, countedQuantity: 5 }),
    ]);
    stagingClaims();
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
    shipmentLines([
      stagingLine({ id: 1, countedQuantity: 12 }),
      stagingLine({ id: 2, countedQuantity: 9 }),
    ]);
    stagingClaims();
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

  it('QA-14: notes riding the CLOSE carry their diff on the SHIPMENT_CLOSE record', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow({ notes: null }));
    shipmentLines([stagingLine({ id: 1, countedQuantity: 10 })]);
    stagingClaims();
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });

    await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', {
        status: 'CLOSED',
        notes: 'two boxes short, supplier notified',
      }),
      { params: { id: SHIPMENT_ID } }
    );

    // The claim writes the field...
    expect(db.inboundShipment.updateMany.mock.calls[0][0].data.notes).toBe(
      'two boxes short, supplier notified'
    );
    // ...and the ONE record this transition writes now says so.
    expect(mockRecordChange).toHaveBeenCalledTimes(1);
    const recorded = mockRecordChange.mock.calls[0][1];
    expect(recorded.actionType).toBe('SHIPMENT_CLOSE');
    expect(recorded.changes).toEqual({
      notes: { from: null, to: 'two boxes short, supplier notified' },
    });
    // The rollup details ride the same record, unchanged.
    expect(recorded.details).toMatchObject({ itemCount: 1 });
  });

  it('QA-14/ER-B9: a from === to field riding the CLOSE attaches no diff at all', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow({ notes: 'late truck' }));
    shipmentLines([stagingLine({ id: 1, countedQuantity: 10 })]);
    stagingClaims();
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });

    await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', {
        status: 'CLOSED',
        notes: 'late truck',
      }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(mockRecordChange).toHaveBeenCalledTimes(1);
    expect(mockRecordChange.mock.calls[0][1].changes).toBeUndefined();
  });

  it('REFUSES to close with uncounted RECEIVED lines: 409 listing the offenders', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
    shipmentLines([
      stagingLine({ id: 1 }),
      stagingLine({ id: 4, countedQuantity: null }),
      stagingLine({ id: 6, expectedQuantity: null, countedQuantity: null }),
    ]);
    stagingClaims();
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });

    const resp = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CLOSED' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.uncountedItemIds).toEqual([4, 6]);
    // The header claim happened and ROLLED BACK with the throw (FD2-1: the
    // uncounted verdict is read from rows only a claimed header can hold
    // still), so nothing settled and nothing was recorded.
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('ignores GRADUATED/DISCARDED lines when deciding closeability', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
    shipmentLines([
      stagingLine({ id: 1, status: 'DISCARDED', countedQuantity: null }),
      stagingLine({ id: 2, status: 'GRADUATED', expectedQuantity: 5, countedQuantity: 5 }),
    ]);
    stagingClaims();
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
    shipmentLines([]);
    stagingClaims();
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
    shipmentLines([stagingLine({ id: 11 }), stagingLine({ id: 12 })]);
    stagingClaims(); // no GRADUATED line remains linked

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
    const unlink = db.stagingItem.updateMany.mock.calls
      .map((c: any[]) => c[0])
      .find((a: any) => a.data && 'shipmentId' in a.data);
    expect(unlink.where).toEqual({ shipmentId: SHIPMENT_ID, status: 'RECEIVED' });
    expect(unlink.data).toEqual({ shipmentId: null });
  });

  it('records SHIPMENT_CANCEL naming the auto-unlinked lines', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
    shipmentLines([stagingLine({ id: 11 }), stagingLine({ id: 12 })]);
    stagingClaims();

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

  it('QA-14: a supplierRef edit riding the CANCEL carries its diff on SHIPMENT_CANCEL', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow({ supplierRef: 'PO-1' }));
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
    shipmentLines([stagingLine({ id: 11 })]);
    stagingClaims();

    await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', {
        status: 'CANCELLED',
        supplierRef: 'PO-1-VOID',
      }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(mockRecordChange).toHaveBeenCalledTimes(1);
    const recorded = mockRecordChange.mock.calls[0][1];
    expect(recorded.actionType).toBe('SHIPMENT_CANCEL');
    expect(recorded.changes).toEqual({ supplierRef: { from: 'PO-1', to: 'PO-1-VOID' } });
    expect(recorded.details).toEqual({ unlinkedItemIds: [11] });
  });

  it('RACE (cancel vs graduate) — GRADUATE WON: a linked GRADUATED line aborts the cancel (409, no audit)', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
    // the racing line already flipped out of RECEIVED in the snapshot...
    shipmentLines([], [stagingLine({ id: 12, status: 'GRADUATED' })]);
    // ...and the CURRENT read finds it linked as GRADUATED
    stagingClaims();

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
    shipmentLines([stagingLine({ id: 12 })]);
    stagingClaims();

    const resp = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CANCELLED' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(resp.status).toBe(200);
    const unlink = db.stagingItem.updateMany.mock.calls
      .map((c: any[]) => c[0])
      .find((a: any) => a.data && 'shipmentId' in a.data);
    expect(unlink.data).toEqual({ shipmentId: null });
    expect(mockRecordChange).toHaveBeenCalledTimes(1);
  });

  it('RACE (two cancels) — a lost claim (count 0) never unlinks anything', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
    db.inboundShipment.updateMany.mockResolvedValue({ count: 0 });
    shipmentLines([stagingLine({ id: 12 })]);
    stagingClaims();

    const resp = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CANCELLED' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(resp.status).toBe(409);
    // The line locks were taken and roll back with the refusal; nothing was
    // unlinked and nothing was recorded.
    expect(
      db.stagingItem.updateMany.mock.calls
        .map((c: any[]) => c[0])
        .filter((a: any) => a.data && 'shipmentId' in a.data)
    ).toHaveLength(0);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('cancelling an already-CANCELLED shipment is a 409', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow({ status: 'CANCELLED' }));
    db.inboundShipment.updateMany.mockResolvedValue({ count: 0 });
    shipmentLines([]);
    stagingClaims();

    const resp = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CANCELLED' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(resp.status).toBe(409);
  });
});


// ---------------------------------------------------------------------------
// W1S-2 (W1-C fix round) — LOCK ORDER on the settle paths.
//
// Every other writer in this lane takes the STAGING ROW first and its SHIPMENT
// second (the count endpoint, the staging PATCH, graduation). Close and cancel
// took them the other way round — header first, lines after — which is a
// textbook ABBA against the very acts they race with.
//
// So each settle locks the lines it knows about in ASCENDING id order and only
// then claims the header. FD2-1 kept that pass exactly as the deadlock ordering
// it is, and moved every DECISION onto the current read below.
//
// NOTE: this pins the CALL SEQUENCE. Real MySQL row-lock behavior rides the
// W1-C drive.
// ---------------------------------------------------------------------------

describe('PATCH /api/inbound-shipments/[id] — lock order (W1S-2)', () => {
  /** Records which table each claim hit, in call order. */
  function recorder() {
    const order: string[] = [];
    db.stagingItem.updateMany.mockImplementation(async (args: any) => {
      if (args.data && 'shipmentId' in args.data) {
        order.push('unlink');
        return { count: 1 };
      }
      order.push(`item:${args.where.id}`);
      return { count: 1 };
    });
    db.inboundShipment.updateMany.mockImplementation(async () => {
      order.push('shipment');
      return { count: 1 };
    });
    db.$queryRaw.mockImplementation(async () => {
      order.push('current');
      return [];
    });
    return order;
  }

  /** The no-op LOCK claims: data restates the status the WHERE matched. */
  const lockClaims = () =>
    db.stagingItem.updateMany.mock.calls
      .map((c: any[]) => c[0])
      .filter((a: any) => a.where.id !== undefined && a.data?.status === a.where.status);

  describe('CANCEL', () => {
    it('locks every linked line ASCENDING, and only then claims the header', async () => {
      setApprovedUser();
      db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
      db.stagingItem.findMany.mockResolvedValue([{ id: 7 }, { id: 12 }]);
      const order = recorder();

      const resp = await PATCH(
        mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CANCELLED' }),
        { params: { id: SHIPMENT_ID } }
      );

      expect(resp.status).toBe(409); // the current read below is empty -> membership drift
      // ascending ids, both BEFORE the header claim, and the current read last
      expect(order.slice(0, 4)).toEqual(['item:7', 'item:12', 'shipment', 'current']);
      expect(lockClaims().map((a: any) => a.where)).toEqual([
        { id: 7, shipmentId: SHIPMENT_ID, status: 'RECEIVED' },
        { id: 12, shipmentId: SHIPMENT_ID, status: 'RECEIVED' },
      ]);
      // and it asked the DB for that order rather than sorting in JS
      expect(db.stagingItem.findMany.mock.calls[0][0].orderBy).toEqual({ id: 'asc' });
    });
  });

  describe('CLOSE', () => {
    it('locks the RECEIVED lines ASCENDING before the header claim', async () => {
      setApprovedUser();
      db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
      shipmentLines([
        stagingLine({ id: 4 }),
        stagingLine({ id: 9, status: 'GRADUATED', expectedQuantity: 5, countedQuantity: 5 }),
        stagingLine({ id: 11, expectedQuantity: 2, countedQuantity: 2 }),
      ]);
      const order = recorder();
      db.$queryRaw.mockImplementation(async () => {
        order.push('current');
        return [
          stagingLine({ id: 4 }),
          stagingLine({ id: 9, status: 'GRADUATED', expectedQuantity: 5, countedQuantity: 5 }),
          stagingLine({ id: 11, expectedQuantity: 2, countedQuantity: 2 }),
        ];
      });

      const resp = await PATCH(
        mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CLOSED' }),
        { params: { id: SHIPMENT_ID } }
      );

      expect(resp.status).toBe(200);
      // only the RECEIVED lines are locked (a graduated line is not receiving work)
      expect(lockClaims().map((a: any) => a.where.id)).toEqual([4, 11]);
      expect(order).toEqual(['item:4', 'item:11', 'shipment', 'current']);
    });

    it('locks only the RECEIVED lines — the snapshot read is scoped to them', async () => {
      setApprovedUser();
      db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
      shipmentLines([stagingLine({ id: 4 })]);
      stagingClaims();
      db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });

      await PATCH(
        mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CLOSED' }),
        { params: { id: SHIPMENT_ID } }
      );

      expect(db.stagingItem.findMany.mock.calls[0][0]).toMatchObject({
        where: { shipmentId: SHIPMENT_ID, status: 'RECEIVED' },
        orderBy: { id: 'asc' },
      });
    });
  });
});

// ---------------------------------------------------------------------------
// FD2-1 (fix round 3) — the settle's ONE CURRENT READ.
//
// Fix round 2 re-derived the membership with a second pass of no-op claims, and
// left two holes open:
//
//   (a) THE ABA. The FIRST pass's results were thrown away, so a line that
//       departed before its claim and rejoined before the final check slipped
//       through the continuous-coverage proof: it was counted (or graduated, or
//       priced) while it was away, and this transaction never held it.
//   (b) THE STALE AUDIT. The close's rollup and its UNCOUNTED list were computed
//       from the PRE-LOCK snapshot. Under REPEATABLE READ a plain re-read
//       answers from that same snapshot, so a count committed between the
//       findMany and the claims was invisible to the audit even when NOTHING
//       raced at all — the close recorded numbers that were already wrong.
//
// One mechanism closes both. The ascending first pass stays (it is the deadlock
// ordering), but a MISS is now fatal — MEMBERSHIP_CHANGED, retriable, even if
// the id reappears. And after the header claim, ONE locking read
// (`SELECT ... FOR UPDATE`) becomes the single source of current truth: the
// membership comparison, the graduation gate, the uncounted gate and its ids,
// the rollup and the unlink set are ALL derived from it. FOR UPDATE reads the
// latest committed rows and re-confirms our locks; a row that joined since is
// not held by us, so that read can genuinely deadlock — which is what
// withDeadlockRetry is wrapped around the whole transaction for.
// ---------------------------------------------------------------------------

describe('PATCH /api/inbound-shipments/[id] — the ONE current read (FD2-1)', () => {
  const itemClaims = () => db.stagingItem.updateMany.mock.calls.map((c: any[]) => c[0]);
  const unlinkClaims = () => itemClaims().filter((a: any) => a.data && 'shipmentId' in a.data);
  const lineClaims = () => itemClaims().filter((a: any) => a.where.id !== undefined);

  describe('the read itself', () => {
    it('is a LOCKING read of this shipment, ordered by id, taken AFTER the header claim', async () => {
      setApprovedUser();
      db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
      db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
      shipmentLines([stagingLine({ id: 11 })]);
      stagingClaims();

      const resp = await PATCH(
        mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CANCELLED' }),
        { params: { id: SHIPMENT_ID } }
      );

      expect(resp.status).toBe(200);
      expect(db.$queryRaw).toHaveBeenCalledTimes(1);
      const statement = db.$queryRaw.mock.calls[0][0];
      expect(statement.sql).toMatch(/FROM\s+staging_items/i);
      expect(statement.sql).toMatch(/ORDER BY id/i);
      expect(statement.sql).toMatch(/FOR UPDATE/i);
      // scoped to THIS shipment, as a bound parameter (never interpolated)
      expect(statement.values).toEqual([SHIPMENT_ID]);
      // ...and it runs with the header already held.
      expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeGreaterThan(
        db.inboundShipment.updateMany.mock.invocationCallOrder[0]
      );
    });

    it('the close path takes exactly ONE of them (no second snapshot read decides anything)', async () => {
      setApprovedUser();
      db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
      db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
      shipmentLines([stagingLine({ id: 4 })]);
      stagingClaims();

      const resp = await PATCH(
        mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CLOSED' }),
        { params: { id: SHIPMENT_ID } }
      );

      expect(resp.status).toBe(200);
      expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // PIN 1 — the ABA.
  // -------------------------------------------------------------------------

  describe('the ABA (a first-pass MISS is fatal even if the id comes back)', () => {
    it('CANCEL: a line that left and rejoined by the current read is a retriable 409', async () => {
      setApprovedUser();
      db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
      db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
      // The snapshot named line 11; the lock MISSED it (it was somewhere else at
      // that instant); by the current read it is linked and RECEIVED again.
      shipmentLines([stagingLine({ id: 11 })], [stagingLine({ id: 11 })]);
      stagingClaims({ lockable: [] });

      const resp = await PATCH(
        mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CANCELLED' }),
        { params: { id: SHIPMENT_ID } }
      );

      expect(resp.status).toBe(409);
      const body = await resp.json();
      expect(body.error).toMatch(/membership changed/i);
      expect(body.retriable).toBe(true);
      // The set LOOKED identical — that is exactly the trap. Nothing settled.
      expect(unlinkClaims()).toHaveLength(0);
      expect(mockRecordChange).not.toHaveBeenCalled();
    });

    it('CLOSE: the same ABA refuses instead of closing over an unheld line', async () => {
      setApprovedUser();
      db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
      db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
      shipmentLines([stagingLine({ id: 4 })], [stagingLine({ id: 4 })]);
      stagingClaims({ lockable: [] });

      const resp = await PATCH(
        mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CLOSED' }),
        { params: { id: SHIPMENT_ID } }
      );

      expect(resp.status).toBe(409);
      expect((await resp.json()).retriable).toBe(true);
      expect(mockRecordChange).not.toHaveBeenCalled();
    });

    it('CANCEL: a GRADUATED line still gets its NAMED refusal, not the generic one', async () => {
      setApprovedUser();
      db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
      db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
      // It graduated mid-flight: the first-pass claim missed it (it is no longer
      // RECEIVED) AND the current read shows why.
      shipmentLines(
        [stagingLine({ id: 11 })],
        [stagingLine({ id: 11, status: 'GRADUATED' })]
      );
      stagingClaims({ lockable: [] });

      const resp = await PATCH(
        mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CANCELLED' }),
        { params: { id: SHIPMENT_ID } }
      );

      expect(resp.status).toBe(409);
      const body = await resp.json();
      expect(body.graduatedItemIds).toEqual([11]);
      expect(body.error).toMatch(/graduated/i);
      expect(mockRecordChange).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // PIN 2 — the stale rollup. NOTHING races here: one count simply committed
  // between this transaction's snapshot and its locks, which is enough to make a
  // plain re-read lie under REPEATABLE READ.
  // -------------------------------------------------------------------------

  describe('the audit rollup is the CURRENT truth', () => {
    it('a count that landed between the snapshot and the locks is IN the close audit', async () => {
      setApprovedUser();
      db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
      db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
      shipmentLines(
        // the snapshot still says "nobody counted this"...
        [stagingLine({ id: 4, expectedQuantity: 10, countedQuantity: null })],
        // ...MySQL says it was counted at 12 (+2 over) before we took the locks
        [stagingLine({ id: 4, expectedQuantity: 10, countedQuantity: 12 })]
      );
      stagingClaims();

      const resp = await PATCH(
        mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CLOSED' }),
        { params: { id: SHIPMENT_ID } }
      );

      expect(resp.status).toBe(200);
      expect(mockRecordChange.mock.calls[0][1]).toMatchObject({
        actionType: 'SHIPMENT_CLOSE',
        details: {
          itemCount: 1,
          countedItemCount: 1,
          discrepancyItemCount: 1,
          totalOver: 2,
          totalUnder: 0,
        },
      });
    });

    it('the rollup censuses every linked line, GRADUATED ones included (unchanged)', async () => {
      setApprovedUser();
      db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
      db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
      shipmentLines([stagingLine({ id: 4, countedQuantity: 9 })], [
        stagingLine({ id: 4, countedQuantity: 9 }),
        stagingLine({ id: 9, status: 'GRADUATED', expectedQuantity: 5, countedQuantity: 5 }),
      ]);
      stagingClaims();

      await PATCH(
        mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CLOSED' }),
        { params: { id: SHIPMENT_ID } }
      );

      expect(mockRecordChange.mock.calls[0][1].details).toMatchObject({
        itemCount: 2,
        countedItemCount: 2,
        totalUnder: 1,
      });
    });

    it('the UNCOUNTED list names the CURRENT offenders, not the snapshot approximation', async () => {
      setApprovedUser();
      db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
      db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
      shipmentLines(
        // the snapshot believes both lines are counted...
        [stagingLine({ id: 4 }), stagingLine({ id: 9 })],
        // ...but line 9's count was undone (or it was linked uncounted) since
        [stagingLine({ id: 4 }), stagingLine({ id: 9, countedQuantity: null })]
      );
      stagingClaims();

      const resp = await PATCH(
        mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CLOSED' }),
        { params: { id: SHIPMENT_ID } }
      );

      expect(resp.status).toBe(409);
      const body = await resp.json();
      // The OLD code named the snapshot's uncounted lines, which here was the
      // empty list: the guard blocked and could not say what blocked it.
      expect(body.uncountedItemIds).toEqual([9]);
      expect(mockRecordChange).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // PIN 3 — the exact close-vs-graduation race, both halves.
  // -------------------------------------------------------------------------

  describe('close vs graduation', () => {
    it('a line that graduates mid-close is a retriable 409, and the RETRY closes clean', async () => {
      setApprovedUser();
      db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
      db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
      // Attempt 1: the snapshot still calls line 4 RECEIVED, the lock misses
      // (graduation took it), and the current read shows it GRADUATED.
      shipmentLines(
        [stagingLine({ id: 4, countedQuantity: null })],
        [stagingLine({ id: 4, status: 'GRADUATED', countedQuantity: 10 })]
      );
      stagingClaims({ lockable: [] });

      const first = await PATCH(
        mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CLOSED' }),
        { params: { id: SHIPMENT_ID } }
      );

      expect(first.status).toBe(409);
      expect((await first.json()).retriable).toBe(true);
      expect(mockRecordChange).not.toHaveBeenCalled();

      // Attempt 2: the caller re-sends the identical request. Its snapshot now
      // agrees — line 4 is GRADUATED, so it is not receiving work, nothing is
      // locked, and the close settles with the graduated line in its rollup.
      shipmentLines(
        [stagingLine({ id: 4, status: 'GRADUATED', countedQuantity: 10 })],
        [stagingLine({ id: 4, status: 'GRADUATED', countedQuantity: 10 })]
      );
      stagingClaims();

      const second = await PATCH(
        mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CLOSED' }),
        { params: { id: SHIPMENT_ID } }
      );

      expect(second.status).toBe(200);
      expect(mockRecordChange).toHaveBeenCalledTimes(1);
      expect(mockRecordChange.mock.calls[0][1]).toMatchObject({
        actionType: 'SHIPMENT_CLOSE',
        details: { itemCount: 1, countedItemCount: 1 },
      });
    });
  });

  // -------------------------------------------------------------------------
  // The membership comparison is a real SET comparison now.
  // -------------------------------------------------------------------------

  describe('membership', () => {
    it('ABORTS when a line was LINKED since the snapshot', async () => {
      setApprovedUser();
      db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
      db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
      shipmentLines([stagingLine({ id: 11 })], [
        stagingLine({ id: 11 }),
        stagingLine({ id: 12 }),
      ]);
      stagingClaims();

      const resp = await PATCH(
        mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CANCELLED' }),
        { params: { id: SHIPMENT_ID } }
      );

      expect(resp.status).toBe(409);
      expect((await resp.json()).error).toMatch(/membership changed/i);
      expect(unlinkClaims()).toHaveLength(0);
      expect(mockRecordChange).not.toHaveBeenCalled();
    });

    it('ABORTS when a line LEFT since the snapshot (never reports it as unlinked)', async () => {
      setApprovedUser();
      db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
      db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
      shipmentLines([stagingLine({ id: 11 }), stagingLine({ id: 12 })], [
        stagingLine({ id: 11 }),
      ]);
      stagingClaims({ lockable: [11] });

      const resp = await PATCH(
        mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CANCELLED' }),
        { params: { id: SHIPMENT_ID } }
      );

      expect(resp.status).toBe(409);
      expect((await resp.json()).error).toMatch(/membership changed/i);
      expect(mockRecordChange).not.toHaveBeenCalled();
    });

    it('THE SIZE-EQUALITY TRAP: one line out, one line in, same COUNT — still refused', async () => {
      setApprovedUser();
      db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
      db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
      // Locked {11,12}; current {11,13}. Two before, two after — the old
      // size-equality argument would have called this an unchanged membership
      // and unlinked a box (13) it never held.
      shipmentLines([stagingLine({ id: 11 }), stagingLine({ id: 12 })], [
        stagingLine({ id: 11 }),
        stagingLine({ id: 13 }),
      ]);
      stagingClaims();

      const resp = await PATCH(
        mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CANCELLED' }),
        { params: { id: SHIPMENT_ID } }
      );

      expect(resp.status).toBe(409);
      expect((await resp.json()).error).toMatch(/membership changed/i);
      expect(unlinkClaims()).toHaveLength(0);
      expect(mockRecordChange).not.toHaveBeenCalled();
    });

    it('pins shipmentId in EVERY line claim (a line cannot be locked through another header)', async () => {
      setApprovedUser();
      db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
      db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
      shipmentLines([stagingLine({ id: 11 })]);
      stagingClaims();

      await PATCH(
        mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CANCELLED' }),
        { params: { id: SHIPMENT_ID } }
      );

      expect(lineClaims().length).toBeGreaterThan(0);
      for (const claim of lineClaims()) {
        expect(claim.where).toEqual({
          id: claim.where.id,
          shipmentId: SHIPMENT_ID,
          status: 'RECEIVED',
        });
        expect(claim.data).toEqual({ status: 'RECEIVED' });
      }
    });

    it('names the CURRENT RECEIVED members as unlinkedItemIds', async () => {
      setApprovedUser();
      db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
      db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
      // A DISCARDED line rides along in the current read: it is linked, but it
      // is not what the unlink touches, so it must not be reported as unlinked.
      shipmentLines([stagingLine({ id: 11 }), stagingLine({ id: 12 })], [
        stagingLine({ id: 11 }),
        stagingLine({ id: 12 }),
        stagingLine({ id: 20, status: 'DISCARDED', countedQuantity: null }),
      ]);
      stagingClaims();

      const resp = await PATCH(
        mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CANCELLED' }),
        { params: { id: SHIPMENT_ID } }
      );

      expect(resp.status).toBe(200);
      expect(mockRecordChange.mock.calls[0][1].details).toEqual({
        unlinkedItemIds: [11, 12],
      });
    });
  });

  it('RETRIES the whole transaction on a deadlock (the retry re-derives the set)', async () => {
    setApprovedUser();
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
    shipmentLines([stagingLine({ id: 11 })]);
    stagingClaims();

    const deadlock: any = new Error('Transaction failed due to a write conflict or a deadlock');
    deadlock.code = 'P2034';
    let attempts = 0;
    (db.$transaction as jest.Mock) = jest.fn(async (fn: any) => {
      attempts += 1;
      if (attempts === 1) throw deadlock;
      return fn(db);
    });

    const resp = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { status: 'CANCELLED' }),
      { params: { id: SHIPMENT_ID } }
    );

    expect(resp.status).toBe(200);
    expect(attempts).toBe(2);
  });
});
