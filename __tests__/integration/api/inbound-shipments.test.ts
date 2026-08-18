// @jest-environment node
/**
 * W1-2a, RETIRED AND RE-AIMED (M3a).
 *
 * This file used to own the W1 receiving header's whole state matrix — the
 * header-only create, the OPEN -> CLOSED / OPEN -> CANCELLED transitions, the
 * UNCOUNTED close guard, the FD2-1/FD4-2 locking reads and the auto-unlink. The
 * Receiving/Labeling overhaul REPLACED that machine: `POST` now enters a supply
 * order with its lines, and `PATCH` runs the supply-order state machine
 * (close/cancel per spec §4.0). Those cases are therefore DELETED here rather
 * than adapted — a test for a machine that no longer exists is not evidence.
 *
 * What is kept — and what this file is now FOR — is the promise the overhaul
 * made to the data that already exists: a LEGACY (W1) receipt is HISTORY, it
 * still renders exactly as it always did through the polymorphic endpoints, and
 * nothing can mutate it. The supply-order half of the same routes is pinned in
 * `supply-orders-create.test.ts`, `supply-orders-reads.test.ts`,
 * `supply-orders-patch.test.ts` and `supply-orders-lines.test.ts`.
 *
 * Prisma is mocked (no DB); the REAL apiHandler is kept so ZodError -> 400 and
 * AppError -> its status map centrally, and the REAL query modules are kept so
 * the legacy mapping under test is the one production runs.
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
  const client: Record<string, unknown> = {
    inboundShipment: { findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
    stagingItem: { findMany: jest.fn(), updateMany: jest.fn() },
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
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((resp: unknown) => resp),
}));

jest.mock('@/lib/change-tracking', () => ({
  __esModule: true,
  recordChange: jest.fn(async () => undefined),
  newBatchId: jest.fn(() => 'batch-legacy-0001'),
}));

import { SHIPMENT_LIST_LIMIT } from '@/lib/shipments/queries';
import { SUPPLY_ORDER_LIST_LIMIT } from '@/lib/supply-orders/queries';
import { GET as listGET } from '@/app/api/inbound-shipments/route';
import { GET as detailGET, PATCH } from '@/app/api/inbound-shipments/[id]/route';
import { requireApproved } from '@/lib/api-utils';
import { validateCSRFToken } from '@/lib/csrf';
import { recordChange } from '@/lib/change-tracking';
import prisma from '@/lib/prisma';

const db = prisma as unknown as Record<string, any>;
const mockRecordChange = recordChange as jest.Mock;

const APPROVED_USER = { id: 7, isAdmin: false, isApproved: true };
const SHIPMENT_ID = 'ckshipment000000000000001';

function setApprovedUser() {
  (requireApproved as jest.Mock).mockResolvedValue({ user: APPROVED_USER });
}

function mkReq(url: string, method = 'GET', body?: unknown) {
  return new NextRequest(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
  });
}

/** A LEGACY (W1) receipt header: `orderedAt IS NULL` is what makes it legacy. */
function shipmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SHIPMENT_ID,
    supplierRef: 'PO-1',
    supplier: null,
    status: 'CLOSED',
    notes: null,
    createdBy: APPROVED_USER.id,
    closedBy: null,
    orderedAt: null,
    feesCents: null,
    feesNote: null,
    createdAt: new Date('2026-08-13T10:00:00.000Z'),
    updatedAt: new Date('2026-08-13T10:00:00.000Z'),
    closedAt: null,
    creator: { id: APPROVED_USER.id, username: 'kris' },
    ...overrides,
  };
}

/** A legacy staging line: the three receipt columns are non-null by data invariant. */
function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    description: 'Box of vials',
    status: 'RECEIVED',
    expectedQuantity: 10,
    countedQuantity: null,
    unitCostCents: null,
    resolvedProductId: null,
    orderedProductId: null,
    orderedQuantity: null,
    verifiedQuantity: null,
    stockedQuantity: 0,
    disposedQuantity: 0,
    lineTotalCents: null,
    labelingRequired: true,
    locationId: 1,
    vendor: null,
    reference: null,
    notes: null,
    shipmentId: SHIPMENT_ID,
    receivedBy: APPROVED_USER.id,
    receivedAt: new Date('2026-08-13T11:00:00.000Z'),
    countedAt: null,
    countedBy: null,
    verifiedAt: null,
    verifiedBy: null,
    location: { id: 1, name: 'Main' },
    resolvedProduct: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (validateCSRFToken as jest.Mock).mockResolvedValue(true);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.inventoryException.findMany.mockResolvedValue([]);
  setApprovedUser();
});

// ---------------------------------------------------------------------------
// The legacy half of the polymorphic LIST
// ---------------------------------------------------------------------------

describe('GET /api/inbound-shipments — legacy headers keep their W1 shape', () => {
  it('rolls up the linked lines exactly as the W1 list did', async () => {
    db.inboundShipment.findMany.mockResolvedValue([shipmentRow()]);
    db.stagingItem.findMany.mockResolvedValue([
      itemRow(),
      itemRow({ id: 2, countedQuantity: 12, status: 'GRADUATED' }),
    ]);

    const res = await listGET(
      mkReq('http://t/api/inbound-shipments?status=CLOSED&model=legacy'),
      {} as never,
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.shipments[0].model).toBe('legacy');
    expect(json.shipments[0].legacy).toMatchObject({
      id: SHIPMENT_ID,
      supplierRef: 'PO-1',
      itemCount: 2,
      receivedItemCount: 1,
      graduatedItemCount: 1,
      uncountedReceivedItemCount: 1,
    });
    expect(json.shipments[0].legacy.discrepancy).toEqual({
      itemCount: 2,
      countedItemCount: 1,
      uncountedItemCount: 1,
      discrepancyItemCount: 1,
      totalOver: 2,
      totalUnder: 0,
    });
  });

  it('QA-5: a DISCARDED never-counted line is not permanently "uncounted"', async () => {
    db.inboundShipment.findMany.mockResolvedValue([shipmentRow()]);
    db.stagingItem.findMany.mockResolvedValue([
      itemRow({ id: 3, status: 'DISCARDED', countedQuantity: null }),
    ]);

    const res = await listGET(mkReq('http://t/api/inbound-shipments?status=CLOSED'), {} as never);
    const json = await res.json();

    expect(json.shipments[0].legacy.uncountedReceivedItemCount).toBe(0);
    expect(json.shipments[0].legacy.discrepancy.uncountedItemCount).toBe(0);
  });

  it('counts an unexpected arrival (expected NULL) in full', async () => {
    db.inboundShipment.findMany.mockResolvedValue([shipmentRow()]);
    db.stagingItem.findMany.mockResolvedValue([
      itemRow({ expectedQuantity: null, countedQuantity: 6 }),
    ]);

    const res = await listGET(mkReq('http://t/api/inbound-shipments?status=CLOSED'), {} as never);
    const json = await res.json();

    expect(json.shipments[0].legacy.discrepancy).toMatchObject({
      totalOver: 6,
      discrepancyItemCount: 1,
    });
  });

  it('QA-6: bounds the page (newest first) instead of listing every shipment ever', async () => {
    db.inboundShipment.findMany.mockResolvedValue([]);

    await listGET(mkReq('http://t/api/inbound-shipments?status=CLOSED'), {} as never);

    const args = db.inboundShipment.findMany.mock.calls[0][0];
    expect(args.take).toBe(SUPPLY_ORDER_LIST_LIMIT);
    expect(args.orderBy).toEqual([{ orderedAt: 'desc' }, { createdAt: 'desc' }]);
  });

  it('the legacy and supply-order list bounds agree (one page size for one dataset)', () => {
    // `lib/shipments/queries.ts` keeps its own bound until M6 deletes the legacy
    // entry point; a divergence would make a legacy page and an orders page two
    // different sizes over the SAME table.
    expect(SUPPLY_ORDER_LIST_LIMIT).toBe(SHIPMENT_LIST_LIMIT);
  });

  it('skips the line query entirely when no shipment matched', async () => {
    db.inboundShipment.findMany.mockResolvedValue([]);

    await listGET(mkReq('http://t/api/inbound-shipments?status=CLOSED'), {} as never);

    expect(db.stagingItem.findMany).not.toHaveBeenCalled();
  });

  it('rejects an unknown status with 400 rather than silently listing everything', async () => {
    const res = await listGET(mkReq('http://t/api/inbound-shipments?status=NOPE'), {} as never);

    expect(res.status).toBe(400);
    expect(db.inboundShipment.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The legacy half of the polymorphic DETAIL
// ---------------------------------------------------------------------------

describe('GET /api/inbound-shipments/[id] — legacy detail, verbatim', () => {
  it('returns 404 for an unknown id', async () => {
    db.inboundShipment.findUnique.mockResolvedValue(null);

    const res = await detailGET(mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`), {
      params: { id: SHIPMENT_ID },
    } as never);

    expect(res.status).toBe(404);
  });

  it('returns the header, the linked lines with per-item flags, and the rollup', async () => {
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
    db.stagingItem.findMany.mockResolvedValue([itemRow({ countedQuantity: 8 })]);

    const res = await detailGET(mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`), {
      params: { id: SHIPMENT_ID },
    } as never);
    const json = await res.json();

    expect(json.model).toBe('legacy');
    expect(json.legacy).toMatchObject({ id: SHIPMENT_ID, itemCount: 1, receivedItemCount: 1 });
    expect(json.legacy.items[0]).toMatchObject({
      id: 1,
      description: 'Box of vials',
      expectedQuantity: 10,
      countedQuantity: 8,
      location: { id: 1, name: 'Main' },
      flags: { counted: true, expectedMissing: false, delta: -2, direction: 'UNDER' },
    });
    expect(json.legacy.discrepancy.totalUnder).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Legacy receipts are HISTORY — no mutation path at all (G2s3-1)
// ---------------------------------------------------------------------------

describe('PATCH /api/inbound-shipments/[id] — a legacy receipt is read-only', () => {
  it('409 LEGACY_READ_ONLY for a field edit, a close and a cancel alike', async () => {
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());

    for (const body of [{ notes: 'x' }, { action: 'close' }, { action: 'cancel' }]) {
      const res = await PATCH(
        mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', body),
        { params: { id: SHIPMENT_ID } } as never,
      );
      const json = await res.json();
      expect(res.status).toBe(409);
      expect(json.code).toBe('LEGACY_READ_ONLY');
    }

    expect(db.inboundShipment.updateMany).not.toHaveBeenCalled();
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown shipment', async () => {
    db.inboundShipment.findUnique.mockResolvedValue(null);

    const res = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { notes: 'x' }),
      { params: { id: SHIPMENT_ID } } as never,
    );

    expect(res.status).toBe(404);
  });

  it('returns 400 for an empty body (nothing to change)', async () => {
    db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());

    const res = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', {}),
      { params: { id: SHIPMENT_ID } } as never,
    );

    expect(res.status).toBe(400);
  });

  it('returns 403 on an invalid CSRF token, before anything is read or written', async () => {
    (validateCSRFToken as jest.Mock).mockResolvedValue(false);

    const res = await PATCH(
      mkReq(`http://t/api/inbound-shipments/${SHIPMENT_ID}`, 'PATCH', { notes: 'x' }),
      { params: { id: SHIPMENT_ID } } as never,
    );

    expect(res.status).toBe(403);
    expect(db.inboundShipment.findUnique).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });
});
