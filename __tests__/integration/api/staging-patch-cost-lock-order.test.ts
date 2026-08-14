// @jest-environment node
/**
 * W1-4b — `PATCH /api/staging-items/[id]`: the receipt-line COST write path and
 * the RESIDUAL ABBA (both registered at W1-3b close).
 *
 * 1. THE LOCK ORDER. Counting (W1-3b ride-along A) and graduating both take the
 *    staging item's row lock FIRST and its shipment's second. This route still
 *    took them the other way round: `claimShipmentForCount` (and, inside
 *    `applyShipmentLink`, the link claims) hit `inbound_shipments` while the
 *    item row was only ever READ — its lock arriving at the closing
 *    `stagingItem.update`. Two people editing and counting the same box at the
 *    same instant could each hold the lock the other needed.
 *
 *    The fix is an ORDER, not a retry: the route issues its own item claim
 *    BEFORE any shipment work, on exactly the paths that do shipment work. The
 *    claim is a NO-OP write (it re-writes the status it matched) whose value is
 *    the row lock, pinned on (id, status, shipmentId) so a line that moved
 *    between the read and the write loses with `count === 0` -> 409.
 *
 *    Paths that touch NO shipment (a label edit, an unlinked line, a link that
 *    is already where it was asked to be) take NO extra lock — there is no ABBA
 *    to prevent, and an unconditional claim would write on every PATCH.
 *
 * 2. `unitCostCents`. T3 has the operator type per-line costs on the receiving
 *    detail and calls this route the write path, but the field was never on the
 *    PATCH surface (see the deviation note in the task report). It is a RECEIPT
 *    FIGURE, so it joins the post-graduation freeze; it does NOT take the
 *    OPEN-only shipment claim, because the stranded-line amendment keeps a
 *    CLOSED shipment's lines gradable and a graduation consumes this cost.
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

function mkReq(body: unknown) {
  return new NextRequest('http://t/api/staging-items/5', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
  });
}

const patch = (body: unknown) => PATCH(mkReq(body), { params: { id: '5' } });

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    description: 'Box of vials',
    status: 'RECEIVED',
    expectedQuantity: 10,
    countedQuantity: null,
    unitCostCents: null,
    shipmentId: null,
    notes: null,
    ...overrides,
  };
}

/** Every `stagingItem.updateMany` call, in order, as {where, data}. */
const itemClaims = () => db.stagingItem.updateMany.mock.calls.map((c: any[]) => c[0]);
/**
 * The claims that WRITE a state-bearing field. W1S-1 turned the closing state
 * write into a conditional `updateMany` too, so the leading no-op lock claim
 * (data names only `status`) is separated by its data, never by call index.
 */
const stateWrites = () =>
  itemClaims().filter((args: any) => args?.data && Object.keys(args.data).some((k) => k !== 'status'));
/** The leading NO-OP lock claims — the ones this file is actually about. */
const lockClaims = () =>
  itemClaims().filter((args: any) => args?.data && Object.keys(args.data).every((k) => k === 'status'));
/** Every shipment header claimed, in call order (FD-3: order AND multiplicity). */
const shipmentClaimIds = () =>
  db.inboundShipment.updateMany.mock.calls.map((c: any[]) => c[0].where.id);
/** The interleaving of item-table and shipment-table claims, in call order. */
function claimOrder(): string[] {
  const order: string[] = [];
  db.stagingItem.updateMany.mockImplementation(async () => {
    order.push('item');
    return { count: 1 };
  });
  db.inboundShipment.updateMany.mockImplementation(async () => {
    order.push('shipment');
    return { count: 1 };
  });
  return order;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockValidateCSRF.mockResolvedValue(true);
  (requireApproved as jest.Mock).mockResolvedValue({ user: APPROVED_USER });
  (db.$transaction as jest.Mock) = jest.fn(async (fn: any) => fn(db));
  db.stagingItem.updateMany.mockResolvedValue({ count: 1 });
  db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
  db.stagingItem.update.mockResolvedValue(itemRow());
});

// ---------------------------------------------------------------------------
// 1. THE LOCK ORDER (the residual ABBA registered at W1-3b)
// ---------------------------------------------------------------------------

describe('PATCH /api/staging-items/[id] — lock order (residual ABBA)', () => {
  it('claims the ITEM before the SHIPMENT on an expectedQuantity edit', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT_A }));
    const order = claimOrder();

    const resp = await patch({ expectedQuantity: 25 });

    expect(resp.status).toBe(200);
    expect(order[0]).toBe('item');
    expect(order).toContain('shipment');
  });

  it('claims the ITEM before the SHIPMENT on a link', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow());
    const order = claimOrder();

    const resp = await patch({ shipmentId: SHIPMENT_A });

    expect(resp.status).toBe(200);
    expect(order[0]).toBe('item');
    expect(order).toContain('shipment');
  });

  it('claims the ITEM before the SHIPMENT on an unlink', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT_A }));
    const order = claimOrder();

    const resp = await patch({ shipmentId: null });

    expect(resp.status).toBe(200);
    expect(order[0]).toBe('item');
  });

  it('claims the ITEM before BOTH shipments on a relink', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT_A }));
    const order = claimOrder();

    const resp = await patch({ shipmentId: SHIPMENT_B });

    expect(resp.status).toBe(200);
    expect(order[0]).toBe('item');
    expect(order.filter((o) => o === 'shipment')).toHaveLength(2);
  });

  it('pins the lock claim on (id, status, shipmentId) and writes nothing new', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT_A }));

    await patch({ expectedQuantity: 25 });

    const lock = itemClaims()[0];
    expect(lock.where).toEqual({ id: 5, status: 'RECEIVED', shipmentId: SHIPMENT_A });
    // A NO-OP write: it re-states the status it matched, so the lock is the
    // only thing it takes.
    expect(lock.data).toEqual({ status: 'RECEIVED' });
  });

  it('a LOST lock claim is a 409 that never reaches the shipment or the audit', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT_A }));
    db.stagingItem.updateMany.mockResolvedValue({ count: 0 });

    const resp = await patch({ expectedQuantity: 25 });

    expect(resp.status).toBe(409);
    expect(db.inboundShipment.updateMany).not.toHaveBeenCalled();
    expect(db.stagingItem.update).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('takes NO extra lock when the body touches no shipment (label edit)', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT_A }));

    const resp = await patch({ notes: 'pallet 3' });

    expect(resp.status).toBe(200);
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
    expect(db.inboundShipment.updateMany).not.toHaveBeenCalled();
  });

  it('takes NO extra lock for expectedQuantity on an UNLINKED line', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: null }));

    const resp = await patch({ expectedQuantity: 25 });

    expect(resp.status).toBe(200);
    // No shipment work -> no ABBA to order -> no lock claim. (The state write
    // itself is still a conditional claim; that is W1S-1, not this rule.)
    expect(lockClaims()).toHaveLength(0);
    expect(db.inboundShipment.updateMany).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // FD-3 (fix round 2) — the residual W1S-7 hole. `applyShipmentLink` sorts the
  // headers it claims, but this route claimed the SOURCE header first (the
  // expectedQuantity OPEN-guard) and only then called in. A PATCH carrying BOTH
  // an expectedQuantity edit and a relink therefore took source-then-sorted:
  // two operators relinking the same pair in opposite directions were back to
  // claiming the two headers in opposite orders. Every header claim now rides
  // the ONE sorted, deduped set inside applyShipmentLink.
  // -------------------------------------------------------------------------

  it('a combined expectedQuantity + relink claims the headers SORTED, once each', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT_B }));

    const resp = await patch({ expectedQuantity: 25, shipmentId: SHIPMENT_A });

    expect(resp.status).toBe(200);
    expect(shipmentClaimIds()).toEqual([SHIPMENT_A, SHIPMENT_B]);
  });

  it('claims the SAME order for the opposite move (A -> B carrying a quantity edit)', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT_A }));

    const resp = await patch({ expectedQuantity: 25, shipmentId: SHIPMENT_B });

    expect(resp.status).toBe(200);
    expect(shipmentClaimIds()).toEqual([SHIPMENT_A, SHIPMENT_B]);
  });

  it('claims the header ONCE on a combined expectedQuantity + UNLINK', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT_A }));

    const resp = await patch({ expectedQuantity: 25, shipmentId: null });

    expect(resp.status).toBe(200);
    expect(shipmentClaimIds()).toEqual([SHIPMENT_A]);
  });

  it('still claims the shipment for an expectedQuantity edit with NO link change', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT_A }));

    const resp = await patch({ expectedQuantity: 25 });

    expect(resp.status).toBe(200);
    expect(shipmentClaimIds()).toEqual([SHIPMENT_A]);
  });

  it('a combined PATCH still refuses when a header is not OPEN (409, nothing written)', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT_B }));
    db.inboundShipment.updateMany.mockResolvedValue({ count: 0 });
    db.inboundShipment.findUnique.mockResolvedValue({ id: SHIPMENT_A, status: 'CLOSED' });

    const resp = await patch({ expectedQuantity: 25, shipmentId: SHIPMENT_A });

    expect(resp.status).toBe(409);
    expect(stateWrites()).toHaveLength(0);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('takes NO lock for a link that is already where it was asked to be', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT_A }));

    const resp = await patch({ shipmentId: SHIPMENT_A });

    expect(resp.status).toBe(200);
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
    expect(db.inboundShipment.updateMany).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. unitCostCents — the receipt-line cost write path (T3)
// ---------------------------------------------------------------------------

describe('PATCH /api/staging-items/[id] — unitCostCents', () => {
  it('writes the typed cost and audits the change', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow());
    db.stagingItem.update.mockResolvedValue(itemRow({ unitCostCents: 1250 }));

    const resp = await patch({ unitCostCents: 1250 });

    expect(resp.status).toBe(200);
    expect(stateWrites()[0].data).toEqual({ unitCostCents: 1250 });
    expect(mockRecordChange.mock.calls[0][1]).toMatchObject({
      actionType: 'STAGING_UPDATE',
      entityType: 'STAGING',
      changes: { unitCostCents: { from: null, to: 1250 } },
    });
  });

  it('accepts 0 — a free sample is a fact, not a missing value', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ unitCostCents: 500 }));
    db.stagingItem.update.mockResolvedValue(itemRow({ unitCostCents: 0 }));

    const resp = await patch({ unitCostCents: 0 });

    expect(resp.status).toBe(200);
    expect(stateWrites()[0].data).toEqual({ unitCostCents: 0 });
  });

  it('accepts null — clearing a cost restores "unknown", never 0', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ unitCostCents: 500 }));
    db.stagingItem.update.mockResolvedValue(itemRow({ unitCostCents: null }));

    const resp = await patch({ unitCostCents: null });

    expect(resp.status).toBe(200);
    expect(stateWrites()[0].data).toEqual({ unitCostCents: null });
    expect(mockRecordChange.mock.calls[0][1].changes).toEqual({
      unitCostCents: { from: 500, to: null },
    });
  });

  it('400s a fractional cost (cents are whole)', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow());

    const resp = await patch({ unitCostCents: 12.5 });

    expect(resp.status).toBe(400);
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
  });

  it('400s a negative cost', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow());

    const resp = await patch({ unitCostCents: -1 });

    expect(resp.status).toBe(400);
  });

  it('409s after graduation — the receipt cost is settled history', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ status: 'GRADUATED' }));

    const resp = await patch({ unitCostCents: 1250 });

    expect(resp.status).toBe(409);
    const json = await resp.json();
    expect(json.error).toMatch(/unitCostCents/);
    expect(stateWrites()).toHaveLength(0);
    expect(db.stagingItem.update).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('stays writable on a CLOSED shipment (the stranded line still graduates)', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ shipmentId: SHIPMENT_A }));
    db.stagingItem.update.mockResolvedValue(itemRow({ shipmentId: SHIPMENT_A, unitCostCents: 1250 }));

    const resp = await patch({ unitCostCents: 1250 });

    expect(resp.status).toBe(200);
    // No OPEN-only claim is taken, so a CLOSED shipment cannot refuse it.
    expect(db.inboundShipment.updateMany).not.toHaveBeenCalled();
  });
});
