// @jest-environment node
/**
 * W1-2b — the PATCH guard + the post-graduation FREEZE (contract pack REV-3 T2,
 * owned wholly here; W1-3a consumes it).
 *
 * Two rules, one surface:
 *
 *  1. countedQuantity is GONE from the generic PATCH body. Counting is a
 *     physical act with an actor and a timestamp, so it happens ONLY through
 *     `POST /api/staging-items/[id]/count`. A body that still carries it is a
 *     clean 400 that names the endpoint — NOT a silently stripped key, which
 *     would let a caller believe it counted something it did not.
 *
 *  2. The five state-bearing fields (expectedQuantity, countedQuantity,
 *     resolvedProductId, locationId, shipmentId) are legal only while the line
 *     is still RECEIVED. Once it graduated, those values are the history of a
 *     real stock movement; editing them would rewrite the story after the fact
 *     => 409 CONFLICT.
 *
 *  2b. expectedQuantity additionally requires its shipment to be OPEN (it is
 *      the count's counterpart in the discrepancy arithmetic, so it freezes
 *      when receiving ends). resolvedProductId / locationId do NOT: per the
 *      STRANDED-LINE AMENDMENT, closing a shipment ends RECEIVING, not
 *      stocking — those two fields are exactly what a graduation still needs.
 *
 * Free-text annotation (description / vendor / reference / notes) is
 * deliberately NOT frozen: it labels the box, it does not restate the movement.
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
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    inboundShipment: {
      findUnique: jest.fn(),
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

import { PATCH } from '@/app/api/staging-items/[id]/route';
import { requireApproved } from '@/lib/api-utils';
import { recordChange } from '@/lib/change-tracking';
import prisma from '@/lib/prisma';

const db: any = prisma as any;
const mockRecordChange = recordChange as jest.Mock;

const APPROVED_USER = { id: 7, isAdmin: false, isApproved: true };
const SHIPMENT = 'ckshipment00000000000000a';

function mkReq(body: unknown) {
  return new NextRequest('http://t/api/staging-items/5', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
  });
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    description: 'Box of vials',
    status: 'RECEIVED',
    expectedQuantity: 10,
    countedQuantity: null,
    resolvedProductId: null,
    locationId: 1,
    shipmentId: null,
    vendor: null,
    reference: null,
    notes: null,
    ...overrides,
  };
}

const patch = (body: unknown) => PATCH(mkReq(body), { params: { id: '5' } });

/** Every `stagingItem.updateMany` call, in order, as {where, data}. */
const itemClaims = () => db.stagingItem.updateMany.mock.calls.map((c: any[]) => c[0]);
/**
 * The claims that actually WRITE a state-bearing field — i.e. everything except
 * the route's leading no-op lock claim, whose data names only `status`.
 */
const stateWrites = () =>
  itemClaims().filter((args: any) => args?.data && Object.keys(args.data).some((k) => k !== 'status'));

/**
 * A REAL two-step race: the row is RECEIVED when the route reads it, and a
 * concurrent graduation commits before the route writes. The mocked `updateMany`
 * evaluates its own WHERE against the row's CURRENT status, exactly as MySQL
 * would, so a claim conditioned on RECEIVED matches 0 rows.
 */
function graduateBetweenReadAndWrite(overrides: Record<string, unknown> = {}) {
  let status = 'RECEIVED';
  db.stagingItem.findUnique.mockImplementation(async () => {
    const row = itemRow({ status, ...overrides });
    status = 'GRADUATED'; // <- the concurrent graduation commits here
    return row;
  });
  db.stagingItem.updateMany.mockImplementation(async (args: any) => ({
    count: args?.where?.status === undefined || args.where.status === status ? 1 : 0,
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({ user: APPROVED_USER });
  (db.$transaction as jest.Mock) = jest.fn(async (fn: any) => fn(db));
  db.stagingItem.update.mockResolvedValue(itemRow());
  db.stagingItem.updateMany.mockResolvedValue({ count: 1 });
  db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
});

describe('countedQuantity is removed from the PATCH surface', () => {
  it('400s a body carrying countedQuantity, before the transaction opens', async () => {
    const resp = await patch({ countedQuantity: 12 });
    const json = await resp.json();

    expect(resp.status).toBe(400);
    expect(json.code).toBe('VALIDATION_ERROR');
    // The error must point at the surface that CAN do it — a bare "unknown
    // field" would send the caller hunting.
    expect(json.error).toMatch(/count/i);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.stagingItem.update).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('400s even when countedQuantity rides along with legal fields (never partially applied)', async () => {
    const resp = await patch({ notes: 'pallet 3', countedQuantity: 12 });

    expect(resp.status).toBe(400);
    expect(db.stagingItem.update).not.toHaveBeenCalled();
  });

  it('400s countedQuantity: null too (clearing a count is still counting)', async () => {
    const resp = await patch({ countedQuantity: null });

    expect(resp.status).toBe(400);
    expect(db.stagingItem.update).not.toHaveBeenCalled();
  });

  it('a body WITHOUT countedQuantity is unaffected', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow());
    db.stagingItem.update.mockResolvedValue(itemRow({ notes: 'pallet 3' }));

    const resp = await patch({ notes: 'pallet 3' });

    expect(resp.status).toBe(200);
    expect(db.stagingItem.update.mock.calls[0][0].data).toEqual({ notes: 'pallet 3' });
  });
});

describe('post-graduation freeze — every frozen field, one at a time', () => {
  const frozen: Array<[string, unknown]> = [
    ['expectedQuantity', 25],
    ['resolvedProductId', 77],
    ['locationId', 3],
    ['shipmentId', SHIPMENT],
  ];

  it.each(frozen)('409s PATCH %s on a GRADUATED item', async (field, value) => {
    db.stagingItem.findUnique.mockResolvedValue(
      itemRow({ status: 'GRADUATED', countedQuantity: 10, resolvedProductId: 4 }),
    );

    const resp = await patch({ [field as string]: value });

    expect(resp.status).toBe(409);
    expect(db.stagingItem.update).not.toHaveBeenCalled();
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it.each(frozen)('409s PATCH %s on a DISCARDED item', async (field, value) => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ status: 'DISCARDED' }));

    const resp = await patch({ [field as string]: value });

    expect(resp.status).toBe(409);
    expect(db.stagingItem.update).not.toHaveBeenCalled();
  });

  it('the 409 names the item state and the refused fields', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ status: 'GRADUATED' }));

    const resp = await patch({ expectedQuantity: 25, locationId: 3 });
    const json = await resp.json();

    expect(resp.status).toBe(409);
    expect(json.code).toBe('CONFLICT');
    expect(json.error).toMatch(/graduated/i);
    expect(json.error).toMatch(/expectedQuantity/);
    expect(json.error).toMatch(/locationId/);
  });

  it('unlinking a GRADUATED line is refused too (shipmentId: null is a frozen edit)', async () => {
    db.stagingItem.findUnique.mockResolvedValue(
      itemRow({ status: 'GRADUATED', shipmentId: SHIPMENT }),
    );

    const resp = await patch({ shipmentId: null });

    expect(resp.status).toBe(409);
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
  });

  it('a frozen field mixed with a legal one aborts the WHOLE patch (no partial write)', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ status: 'GRADUATED' }));

    const resp = await patch({ notes: 'audit trail', expectedQuantity: 25 });

    expect(resp.status).toBe(409);
    expect(db.stagingItem.update).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('free-text annotation stays editable after graduation (deliberately NOT frozen)', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ status: 'GRADUATED' }));
    db.stagingItem.update.mockResolvedValue(itemRow({ status: 'GRADUATED', notes: 'RMA 44' }));

    const resp = await patch({ notes: 'RMA 44', vendor: 'Acme', reference: 'PO-9' });

    expect(resp.status).toBe(200);
    expect(db.stagingItem.update.mock.calls[0][0].data).toEqual({
      notes: 'RMA 44',
      vendor: 'Acme',
      reference: 'PO-9',
    });
  });
});

// ---------------------------------------------------------------------------
// W1S-1 (W1-C fix round) — the freeze is ATOMIC, not advisory.
//
// The verdict above is computed from a READ. Between that read and the closing
// write, a concurrent graduation can commit — and the write that followed was
// unconditional, so the loser of the race silently rewrote the receipt figures
// of a line that had already become real stock. The fix makes the write itself
// the guard: every state-bearing update is an `updateMany` whose WHERE carries
// `status: RECEIVED`, so the race is settled by MySQL and the loser gets a 409.
// ---------------------------------------------------------------------------

describe('the post-graduation freeze is ATOMIC (W1S-1)', () => {
  const stateBodies: Array<[string, unknown]> = [
    ['unitCostCents', { unitCostCents: 1250 }],
    ['expectedQuantity', { expectedQuantity: 25 }],
    ['resolvedProductId', { resolvedProductId: 77 }],
    ['locationId', { locationId: 3 }],
    ['a mixed body', { locationId: 3, notes: 'pallet 3' }],
  ];

  it.each(stateBodies)(
    'RACE: %s graduating between the read and the write is a 409 with ZERO writes',
    async (_label, body) => {
      graduateBetweenReadAndWrite();

      const resp = await patch(body);

      expect(resp.status).toBe(409);
      expect((await resp.json()).code).toBe('CONFLICT');
      // The claim was attempted and matched nothing; nothing else ran.
      expect(stateWrites()).toHaveLength(1);
      expect(db.stagingItem.update).not.toHaveBeenCalled();
      expect(mockRecordChange).not.toHaveBeenCalled();
    },
  );

  it('conditions the state write on status RECEIVED', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow());

    await patch({ unitCostCents: 1250 });

    expect(stateWrites()[0].where).toEqual({ id: 5, status: 'RECEIVED' });
    expect(stateWrites()[0].data).toEqual({ unitCostCents: 1250 });
    // The state path never uses the unconditional `update` any more.
    expect(db.stagingItem.update).not.toHaveBeenCalled();
  });

  it('carries the label fields along in the SAME conditional write (no partial apply)', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow());

    const resp = await patch({ locationId: 3, notes: 'pallet 3' });

    expect(resp.status).toBe(200);
    expect(stateWrites()).toHaveLength(1);
    expect(stateWrites()[0].data).toEqual({ locationId: 3, notes: 'pallet 3' });
  });

  it('a LABEL-only edit stays unconditional — annotation is legal after graduation', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ status: 'GRADUATED' }));
    db.stagingItem.update.mockResolvedValue(itemRow({ status: 'GRADUATED', notes: 'RMA 44' }));

    const resp = await patch({ notes: 'RMA 44' });

    expect(resp.status).toBe(200);
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
    expect(db.stagingItem.update.mock.calls[0][0].data).toEqual({ notes: 'RMA 44' });
  });
});

describe('RECEIVED-only rules — the legal paths still work', () => {
  it('PATCHes expectedQuantity on an unlinked RECEIVED item (no shipment claim)', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow());
    db.stagingItem.update.mockResolvedValue(itemRow({ expectedQuantity: 25 }));

    const resp = await patch({ expectedQuantity: 25 });

    expect(resp.status).toBe(200);
    expect(db.inboundShipment.updateMany).not.toHaveBeenCalled();
    expect(stateWrites()[0].data).toEqual({ expectedQuantity: 25 });
    expect(mockRecordChange.mock.calls[0][1]).toMatchObject({
      actionType: 'STAGING_UPDATE',
      changes: { expectedQuantity: { from: 10, to: 25 } },
    });
  });

  it('PATCHes expectedQuantity on a line whose shipment is OPEN (claim taken)', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT }));
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
    db.stagingItem.update.mockResolvedValue(itemRow({ shipmentId: SHIPMENT, expectedQuantity: 25 }));

    const resp = await patch({ expectedQuantity: 25 });

    expect(resp.status).toBe(200);
    expect(db.inboundShipment.updateMany.mock.calls[0][0].where).toEqual({
      id: SHIPMENT,
      status: 'OPEN',
    });
  });

  it('409s expectedQuantity when the line sits on a CLOSED shipment (receipt is settled)', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT }));
    db.inboundShipment.updateMany.mockResolvedValue({ count: 0 });
    db.inboundShipment.findUnique.mockResolvedValue({ id: SHIPMENT, status: 'CLOSED' });

    const resp = await patch({ expectedQuantity: 25 });

    expect(resp.status).toBe(409);
    expect(stateWrites()).toHaveLength(0);
    expect(db.stagingItem.update).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('STRANDED-LINE: resolvedProductId + locationId stay editable on a CLOSED shipment', async () => {
    // Closing ends RECEIVING, not stocking — these two fields are precisely
    // what the still-legal graduation of this line consumes.
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT }));
    db.stagingItem.update.mockResolvedValue(itemRow({ shipmentId: SHIPMENT, resolvedProductId: 77 }));

    const resp = await patch({ resolvedProductId: 77, locationId: 3 });

    expect(resp.status).toBe(200);
    // No shipment claim is taken at all for these fields.
    expect(db.inboundShipment.updateMany).not.toHaveBeenCalled();
    // Scalar FKs, not Prisma relation connects: the write is an `updateMany`
    // now, because it has to carry the RECEIVED precondition (W1S-1).
    expect(stateWrites()[0].data).toEqual({ resolvedProductId: 77, locationId: 3 });
  });

  it('404s an unknown item before any freeze verdict', async () => {
    db.stagingItem.findUnique.mockResolvedValue(null);

    const resp = await patch({ expectedQuantity: 25 });

    expect(resp.status).toBe(404);
  });
});
