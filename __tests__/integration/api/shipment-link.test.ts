// @jest-environment node
/**
 * W1-2a — staging-item <-> shipment linkage (contract pack REV-2 T4).
 *
 * The link/unlink verb rides the EXISTING `PATCH /api/staging-items/[id]` and is
 * legal ONLY while the item is RECEIVED and every shipment involved (the one it
 * leaves AND the one it joins) is OPEN. Everything else is a 409.
 *
 * W1-2b owns the count endpoint and the post-graduation field freeze; this file
 * deliberately asserts only that a body WITHOUT `shipmentId` behaves exactly as
 * it did before (countedQuantity semantics untouched).
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
import { validateCSRFToken } from '@/lib/csrf';
import { recordChange } from '@/lib/change-tracking';
import prisma from '@/lib/prisma';

const db: any = prisma as any;
const mockValidateCSRF = validateCSRFToken as jest.Mock;
const mockRecordChange = recordChange as jest.Mock;

const APPROVED_USER = { id: 7, isAdmin: false, isApproved: true };
const SHIPMENT_A = 'ckshipment00000000000000a';
const SHIPMENT_B = 'ckshipment00000000000000b';

function setApprovedUser(user: any = APPROVED_USER) {
  (requireApproved as jest.Mock).mockResolvedValue({ user });
}

function mkReq(body: any) {
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
    shipmentId: null,
    notes: null,
    ...overrides,
  };
}

const actionTypes = () => mockRecordChange.mock.calls.map((c) => c[1].actionType);

beforeEach(() => {
  jest.clearAllMocks();
  mockValidateCSRF.mockResolvedValue(true);
  (db.$transaction as jest.Mock) = jest.fn(async (fn: any) => fn(db));
  db.stagingItem.update.mockResolvedValue(itemRow());
});

describe('PATCH /api/staging-items/[id] — link', () => {
  it('links a RECEIVED item to an OPEN shipment through two atomic claims (200)', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow());
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
    db.stagingItem.updateMany.mockResolvedValue({ count: 1 });

    const resp = await PATCH(mkReq({ shipmentId: SHIPMENT_A }), { params: { id: '5' } });

    expect(resp.status).toBe(200);
    // (1) the target shipment is claimed OPEN — a no-op write whose WHERE is the
    //     guard, so a concurrent close/cancel serializes against it.
    expect(db.inboundShipment.updateMany.mock.calls[0][0].where).toEqual({
      id: SHIPMENT_A,
      status: 'OPEN',
    });
    // (2) the item itself is claimed on (RECEIVED, current link) — never read-then-write.
    const claim = db.stagingItem.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({ id: 5, status: 'RECEIVED', shipmentId: null });
    expect(claim.data).toEqual({ shipmentId: SHIPMENT_A });
  });

  it('records SHIPMENT_LINK against the shipment', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow());
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
    db.stagingItem.updateMany.mockResolvedValue({ count: 1 });

    await PATCH(mkReq({ shipmentId: SHIPMENT_A }), { params: { id: '5' } });

    expect(actionTypes()).toEqual(['SHIPMENT_LINK']);
    expect(mockRecordChange.mock.calls[0][1]).toMatchObject({
      actionType: 'SHIPMENT_LINK',
      entityType: 'SHIPMENT',
      entityId: SHIPMENT_A,
      details: { stagingItemId: 5, previousShipmentId: null },
    });
  });

  it('rejects linking a GRADUATED item with 409 (post-graduation)', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ status: 'GRADUATED' }));

    const resp = await PATCH(mkReq({ shipmentId: SHIPMENT_A }), { params: { id: '5' } });

    expect(resp.status).toBe(409);
    expect(db.inboundShipment.updateMany).not.toHaveBeenCalled();
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('rejects linking a DISCARDED item with 409', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ status: 'DISCARDED' }));

    const resp = await PATCH(mkReq({ shipmentId: SHIPMENT_A }), { params: { id: '5' } });

    expect(resp.status).toBe(409);
  });

  it('rejects linking to a CLOSED shipment with 409', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow());
    db.inboundShipment.updateMany.mockResolvedValue({ count: 0 });
    db.inboundShipment.findUnique.mockResolvedValue({ id: SHIPMENT_A, status: 'CLOSED' });

    const resp = await PATCH(mkReq({ shipmentId: SHIPMENT_A }), { params: { id: '5' } });

    expect(resp.status).toBe(409);
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('rejects linking to a CANCELLED shipment with 409', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow());
    db.inboundShipment.updateMany.mockResolvedValue({ count: 0 });
    db.inboundShipment.findUnique.mockResolvedValue({ id: SHIPMENT_A, status: 'CANCELLED' });

    const resp = await PATCH(mkReq({ shipmentId: SHIPMENT_A }), { params: { id: '5' } });

    expect(resp.status).toBe(409);
  });

  it('returns 404 when the target shipment does not exist', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow());
    db.inboundShipment.updateMany.mockResolvedValue({ count: 0 });
    db.inboundShipment.findUnique.mockResolvedValue(null);

    const resp = await PATCH(mkReq({ shipmentId: SHIPMENT_A }), { params: { id: '5' } });

    expect(resp.status).toBe(404);
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
  });

  it('RACE: a lost item claim (count 0 — it graduated mid-flight) is a 409, no audit', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow());
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
    db.stagingItem.updateMany.mockResolvedValue({ count: 0 });

    const resp = await PATCH(mkReq({ shipmentId: SHIPMENT_A }), { params: { id: '5' } });

    expect(resp.status).toBe(409);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('is a no-op (no writes, no audit) when the item is already on that shipment', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT_A }));

    const resp = await PATCH(mkReq({ shipmentId: SHIPMENT_A }), { params: { id: '5' } });

    expect(resp.status).toBe(200);
    expect(db.inboundShipment.updateMany).not.toHaveBeenCalled();
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/staging-items/[id] — unlink', () => {
  it('clears the link while both the item and its shipment are eligible (200)', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT_A }));
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
    db.stagingItem.updateMany.mockResolvedValue({ count: 1 });

    const resp = await PATCH(mkReq({ shipmentId: null }), { params: { id: '5' } });

    expect(resp.status).toBe(200);
    const claim = db.stagingItem.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({ id: 5, status: 'RECEIVED', shipmentId: SHIPMENT_A });
    expect(claim.data).toEqual({ shipmentId: null });
    expect(actionTypes()).toEqual(['SHIPMENT_UNLINK']);
    expect(mockRecordChange.mock.calls[0][1]).toMatchObject({
      actionType: 'SHIPMENT_UNLINK',
      entityType: 'SHIPMENT',
      entityId: SHIPMENT_A,
      details: { stagingItemId: 5 },
    });
  });

  it('rejects unlinking from a CLOSED shipment with 409', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT_A }));
    db.inboundShipment.updateMany.mockResolvedValue({ count: 0 });
    db.inboundShipment.findUnique.mockResolvedValue({ id: SHIPMENT_A, status: 'CLOSED' });

    const resp = await PATCH(mkReq({ shipmentId: null }), { params: { id: '5' } });

    expect(resp.status).toBe(409);
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
  });

  it('is a no-op when the item carries no link', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: null }));

    const resp = await PATCH(mkReq({ shipmentId: null }), { params: { id: '5' } });

    expect(resp.status).toBe(200);
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/staging-items/[id] — relink', () => {
  it('moves a line between two OPEN shipments and records both verbs', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT_A }));
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
    db.stagingItem.updateMany.mockResolvedValue({ count: 1 });

    const resp = await PATCH(mkReq({ shipmentId: SHIPMENT_B }), { params: { id: '5' } });

    expect(resp.status).toBe(200);
    // BOTH shipments are claimed OPEN — leaving a closed shipment is as illegal
    // as joining one.
    expect(db.inboundShipment.updateMany.mock.calls.map((c: any[]) => c[0].where.id)).toEqual([
      SHIPMENT_A,
      SHIPMENT_B,
    ]);
    expect(actionTypes()).toEqual(['SHIPMENT_UNLINK', 'SHIPMENT_LINK']);
    expect(mockRecordChange.mock.calls[1][1]).toMatchObject({
      entityId: SHIPMENT_B,
      details: { stagingItemId: 5, previousShipmentId: SHIPMENT_A },
    });
  });

  it('rejects the move when the SOURCE shipment is no longer OPEN (409)', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT_A }));
    db.inboundShipment.updateMany.mockResolvedValue({ count: 0 });
    db.inboundShipment.findUnique.mockResolvedValue({ id: SHIPMENT_A, status: 'CLOSED' });

    const resp = await PATCH(mkReq({ shipmentId: SHIPMENT_B }), { params: { id: '5' } });

    expect(resp.status).toBe(409);
    expect(db.inboundShipment.updateMany).toHaveBeenCalledTimes(1);
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/staging-items/[id] — the pre-existing field path is untouched', () => {
  it('a body without shipmentId never touches the shipment tables', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow());
    db.stagingItem.update.mockResolvedValue(itemRow({ notes: 'pallet 3' }));

    // W1-2b landed after this file: countedQuantity left the PATCH surface, and
    // expectedQuantity (the other quantity field) now claims the linked
    // shipment. `notes` is the field that still touches nothing but the row.
    const resp = await PATCH(mkReq({ notes: 'pallet 3' }), { params: { id: '5' } });

    expect(resp.status).toBe(200);
    expect(db.stagingItem.update.mock.calls[0][0].data).toEqual({ notes: 'pallet 3' });
    expect(db.inboundShipment.updateMany).not.toHaveBeenCalled();
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
    expect(actionTypes()).toEqual(['STAGING_UPDATE']);
  });

  it('a link rides the SAME transaction as a field edit, and both verbs record', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(itemRow());
    db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
    db.stagingItem.updateMany.mockResolvedValue({ count: 1 });
    db.stagingItem.update.mockResolvedValue(itemRow({ notes: 'pallet 3' }));

    const resp = await PATCH(mkReq({ shipmentId: SHIPMENT_A, notes: 'pallet 3' }), {
      params: { id: '5' },
    });

    expect(resp.status).toBe(200);
    expect((db.$transaction as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(actionTypes()).toEqual(['SHIPMENT_LINK', 'STAGING_UPDATE']);
  });

  it('returns 404 before any shipment work when the item does not exist', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(null);

    const resp = await PATCH(mkReq({ shipmentId: SHIPMENT_A }), { params: { id: '999' } });

    expect(resp.status).toBe(404);
    expect(db.inboundShipment.updateMany).not.toHaveBeenCalled();
  });
});
