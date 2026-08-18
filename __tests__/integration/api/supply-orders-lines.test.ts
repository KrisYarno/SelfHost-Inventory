// @jest-environment node
/**
 * M3a — the LINE routes: `POST /api/inbound-shipments/[id]/lines`,
 * `PATCH .../lines/[lineId]` and `POST .../lines/[lineId]/discard`.
 *
 * `POST .../lines` carries TWO acts behind one verb, chosen by the header's
 * status, never by the body: an ORDERED header gains an ORDERED line (something
 * else was ordered), a RECEIVING|CLOSED header gains an UNORDERED ARRIVAL
 * (something turned up that was never on the order). The second is the ONE new
 * exception writer M3a adds to the boundary allow-list, and its fan-out —
 * PRODUCT_CREATE (when the resolver minted one), STAGING_CREATE, and the
 * `recv-discrepancy` row with the COMPLETE unordered subject — commits under ONE
 * batchId minted outside the retry.
 *
 * The header claim is REAL (`claimShipmentForVerify`, which carries the legacy
 * discriminator as a locking read); the product resolver and the exception
 * writer are mocked at their seams (S10 / S14) — their own rules are pinned in
 * their own unit suites, and what these tests own is what the ROUTE asks of them.
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
    inboundShipment: { findUnique: jest.fn(), updateMany: jest.fn() },
    stagingItem: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
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
  newBatchId: jest.fn(() => 'batch-lines-0001'),
}));

jest.mock('@/lib/supply-orders/product-resolve', () => ({
  __esModule: true,
  resolveSupplyOrderProduct: jest.fn(),
}));

jest.mock('@/lib/exceptions/write', () => ({
  __esModule: true,
  upsertException: jest.fn(async () => ({ id: 1 })),
  resolveException: jest.fn(async () => null),
}));

import { POST as addLinePOST } from '@/app/api/inbound-shipments/[id]/lines/route';
import { PATCH as patchLinePATCH } from '@/app/api/inbound-shipments/[id]/lines/[lineId]/route';
import { POST as discardPOST } from '@/app/api/inbound-shipments/[id]/lines/[lineId]/discard/route';
import { requireApproved } from '@/lib/api-utils';
import { validateCSRFToken } from '@/lib/csrf';
import { recordChange, newBatchId } from '@/lib/change-tracking';
import { resolveSupplyOrderProduct } from '@/lib/supply-orders/product-resolve';
import { upsertException, resolveException } from '@/lib/exceptions/write';
import prisma from '@/lib/prisma';

const db = prisma as unknown as Record<string, any>;
const mockRecordChange = recordChange as jest.Mock;
const mockNewBatchId = newBatchId as jest.Mock;
const mockResolve = resolveSupplyOrderProduct as jest.Mock;
const mockUpsert = upsertException as jest.Mock;
const mockResolveExc = resolveException as jest.Mock;

const APPROVED_USER = { id: 7, isAdmin: false, isApproved: true };
const ORDER_ID = 'cksupplyorder00000000001';
const LINE_ID = 501;

function setApprovedUser() {
  (requireApproved as jest.Mock).mockResolvedValue({ user: APPROVED_USER });
}

function mkReq(path: string, body: unknown) {
  return new NextRequest(`http://t/api/inbound-shipments/${ORDER_ID}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
  });
}

const orderParams = { params: { id: ORDER_ID } } as never;
const lineParams = { params: { id: ORDER_ID, lineId: String(LINE_ID) } } as never;

/** The header's CURRENT status, driving both the pre-read and the claim. */
let headerStatus = 'ORDERED';
let headerOrderedAt: Date | null = new Date('2026-08-14T00:00:00.000Z');
/** The row the line routes' locking read returns. */
let lockedLineRow: Record<string, unknown> | null = null;

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

function lineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    description: 'Vial Blue',
    status: 'ORDERED',
    shipmentId: ORDER_ID,
    orderedProductId: 31,
    resolvedProductId: 31,
    orderedQuantity: 100,
    verifiedQuantity: null,
    stockedQuantity: 0,
    disposedQuantity: 0,
    lineTotalCents: 100_000,
    labelingRequired: true,
    locationId: null,
    notes: null,
    verifiedAt: null,
    verifiedBy: null,
    expectedQuantity: null,
    countedQuantity: null,
    ...overrides,
  };
}

const recorded = (actionType: string) =>
  mockRecordChange.mock.calls.filter((c) => c[1].actionType === actionType).map((c) => c[1]);

beforeEach(() => {
  jest.clearAllMocks();
  (validateCSRFToken as jest.Mock).mockResolvedValue(true);
  mockNewBatchId.mockReturnValue('batch-lines-0001');
  headerStatus = 'ORDERED';
  headerOrderedAt = new Date('2026-08-14T00:00:00.000Z');
  lockedLineRow = lineRow();
  setApprovedUser();

  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.inboundShipment.findUnique.mockImplementation(async () => headerRow());
  // The claim tries one status at a time; only the header's real status wins.
  db.inboundShipment.updateMany.mockImplementation(async (args: any) => ({
    count: args.where.status === headerStatus ? 1 : 0,
  }));
  db.$queryRaw.mockImplementation(async (statement: { sql?: string }) => {
    const sql = String(statement?.sql ?? '');
    if (/inbound_shipments/i.test(sql)) return [{ orderedAt: headerOrderedAt }];
    return lockedLineRow === null ? [] : [lockedLineRow];
  });
  db.stagingItem.create.mockImplementation(async ({ data }: any) => ({ ...lineRow(), ...data }));
  db.stagingItem.updateMany.mockResolvedValue({ count: 1 });
  db.stagingItem.findUnique.mockImplementation(async () => lockedLineRow);
  db.stagingItem.findMany.mockImplementation(async () => (lockedLineRow ? [lockedLineRow] : []));
  db.inventoryException.findMany.mockResolvedValue([]);
  mockResolve.mockResolvedValue({
    productId: 31,
    productName: 'Vial Blue',
    approvalStatus: 'APPROVED',
    created: false,
    locationId: 1,
  });
});

// ---------------------------------------------------------------------------
// POST .../lines — an ORDERED line
// ---------------------------------------------------------------------------

describe('POST /api/inbound-shipments/[id]/lines — ordered line (header ORDERED)', () => {
  const orderedBody = {
    product: { mode: 'existing', productId: 31 },
    orderedQuantity: 100,
    lineTotalCents: 100_000,
    labelingRequired: true,
    notes: 'second pallet',
  };

  it('creates the line ORDERED with the resolver name snapshotted', async () => {
    const res = await addLinePOST(mkReq('/lines', orderedBody), orderParams);

    expect(res.status).toBe(201);
    expect(db.stagingItem.create.mock.calls[0][0].data).toEqual({
      status: 'ORDERED',
      description: 'Vial Blue',
      orderedProductId: 31,
      resolvedProductId: 31,
      orderedQuantity: 100,
      lineTotalCents: 100_000,
      labelingRequired: true,
      notes: 'second pallet',
      shipmentId: ORDER_ID,
      receivedBy: null,
      receivedAt: null,
      locationId: null,
    });
  });

  it('records STAGING_CREATE against the LINE, kind "ordered", and raises NO exception', async () => {
    await addLinePOST(mkReq('/lines', orderedBody), orderParams);

    const creates = recorded('STAGING_CREATE');
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      entityType: 'STAGING',
      entityId: LINE_ID,
      batchId: 'batch-lines-0001',
    });
    expect(creates[0].details).toMatchObject({ kind: 'ordered', shipmentId: ORDER_ID });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('records PRODUCT_CREATE under the SAME batchId when the resolver minted one', async () => {
    mockResolve.mockResolvedValue({
      productId: 88,
      productName: 'Cap Red',
      approvalStatus: 'PENDING_REVIEW',
      created: true,
      locationId: 1,
    });

    await addLinePOST(
      mkReq('/lines', {
        ...orderedBody,
        product: { mode: 'new', productFields: { baseName: 'Cap', variant: 'Red' } },
      }),
      orderParams,
    );

    const products = recorded('PRODUCT_CREATE');
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      entityType: 'PRODUCT',
      entityId: 88,
      batchId: 'batch-lines-0001',
    });
    expect(recorded('STAGING_CREATE')[0].batchId).toBe('batch-lines-0001');
  });

  it('400s a body that carries costPrice on a new product (premise 1)', async () => {
    const res = await addLinePOST(
      mkReq('/lines', {
        ...orderedBody,
        product: {
          mode: 'new',
          productFields: { baseName: 'Cap', variant: 'Red', costPrice: 4 },
        },
      }),
      orderParams,
    );

    expect(res.status).toBe(400);
    expect(db.stagingItem.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST .../lines — an UNORDERED ARRIVAL
// ---------------------------------------------------------------------------

describe('POST /api/inbound-shipments/[id]/lines — unordered arrival (header RECEIVING|CLOSED)', () => {
  const arrivalBody = {
    product: { mode: 'existing', productId: 31 },
    verifiedQuantity: 6,
    lineTotalCents: 3_000,
    labelingRequired: true,
    note: 'supplier threw these in',
  };

  beforeEach(() => {
    headerStatus = 'RECEIVING';
  });

  it('creates the line already VERIFIED, unordered, with the verifier stamped', async () => {
    const res = await addLinePOST(mkReq('/lines', arrivalBody), orderParams);

    expect(res.status).toBe(201);
    const data = db.stagingItem.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      status: 'VERIFIED',
      description: 'Vial Blue',
      orderedProductId: null,
      resolvedProductId: 31,
      orderedQuantity: null,
      verifiedQuantity: 6,
      verifiedBy: APPROVED_USER.id,
      lineTotalCents: 3_000,
      labelingRequired: true,
      notes: 'supplier threw these in',
      shipmentId: ORDER_ID,
      receivedBy: null,
      receivedAt: null,
      locationId: null,
    });
    expect(data.verifiedAt).toBeInstanceOf(Date);
  });

  it('raises recv-discrepancy with the COMPLETE unordered subject', async () => {
    await addLinePOST(mkReq('/lines', arrivalBody), orderParams);

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const args = mockUpsert.mock.calls[0][1];
    expect(args.kind).toBe('recv-discrepancy');
    expect(args.key).toBe(`recv-discrepancy:${LINE_ID}`);
    expect(args.subject).toEqual({
      stagingItemId: LINE_ID,
      shipmentId: ORDER_ID,
      productId: 31,
      orderedProductId: null,
      expectedQty: null,
      countedQty: 6,
      orderedQuantity: null,
      verifiedQuantity: 6,
      shortUnits: 0,
      overUnits: 0,
      lossCents: 0,
      surplusValueCents: 0,
      unitCostCents: 500,
      note: 'supplier threw these in',
    });
  });

  it('prices the subject off the VERIFIED basis, and reports NULL when there is no total', async () => {
    await addLinePOST(
      mkReq('/lines', { ...arrivalBody, lineTotalCents: null, note: undefined }),
      orderParams,
    );

    expect(mockUpsert.mock.calls[0][1].subject).toMatchObject({
      unitCostCents: null,
      note: null,
    });
  });

  it('fans out PRODUCT_CREATE + STAGING_CREATE + the exception under ONE batchId', async () => {
    mockResolve.mockResolvedValue({
      productId: 88,
      productName: 'Cap Red',
      approvalStatus: 'PENDING_REVIEW',
      created: true,
      locationId: 1,
    });

    await addLinePOST(
      mkReq('/lines', {
        ...arrivalBody,
        product: { mode: 'new', productFields: { baseName: 'Cap', variant: 'Red' } },
      }),
      orderParams,
    );

    expect(recorded('PRODUCT_CREATE')[0].batchId).toBe('batch-lines-0001');
    const creates = recorded('STAGING_CREATE');
    expect(creates[0].batchId).toBe('batch-lines-0001');
    expect(creates[0].details).toMatchObject({ kind: 'unordered', verifiedQuantity: 6 });
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockNewBatchId).toHaveBeenCalledTimes(1);
  });

  it('is legal on a CLOSED order (box 2 after an early close)', async () => {
    headerStatus = 'CLOSED';

    const res = await addLinePOST(mkReq('/lines', arrivalBody), orderParams);

    expect(res.status).toBe(201);
    expect(db.stagingItem.create.mock.calls[0][0].data.status).toBe('VERIFIED');
  });
});

// ---------------------------------------------------------------------------
// POST .../lines — refusals
// ---------------------------------------------------------------------------

describe('POST /api/inbound-shipments/[id]/lines — refusals', () => {
  it('404s an unknown order', async () => {
    db.inboundShipment.findUnique.mockResolvedValue(null);

    const res = await addLinePOST(
      mkReq('/lines', { product: { mode: 'existing', productId: 31 }, verifiedQuantity: 1 }),
      orderParams,
    );

    expect(res.status).toBe(404);
  });

  it('409 LEGACY_READ_ONLY on a legacy header', async () => {
    headerOrderedAt = null;
    headerStatus = 'CLOSED';

    const res = await addLinePOST(
      mkReq('/lines', { product: { mode: 'existing', productId: 31 }, verifiedQuantity: 1 }),
      orderParams,
    );
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe('LEGACY_READ_ONLY');
    expect(db.stagingItem.create).not.toHaveBeenCalled();
  });

  it('409s a CANCELLED order', async () => {
    headerStatus = 'CANCELLED';

    const res = await addLinePOST(
      mkReq('/lines', { product: { mode: 'existing', productId: 31 }, verifiedQuantity: 1 }),
      orderParams,
    );

    expect(res.status).toBe(409);
    expect(db.stagingItem.create).not.toHaveBeenCalled();
  });

  it('403s an invalid CSRF token before any write', async () => {
    (validateCSRFToken as jest.Mock).mockResolvedValue(false);

    const res = await addLinePOST(
      mkReq('/lines', {
        product: { mode: 'existing', productId: 31 },
        orderedQuantity: 1,
        lineTotalCents: 0,
      }),
      orderParams,
    );

    expect(res.status).toBe(403);
    expect(db.stagingItem.create).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PATCH .../lines/[lineId]
// ---------------------------------------------------------------------------

describe('PATCH /api/inbound-shipments/[id]/lines/[lineId]', () => {
  function patchReq(body: unknown) {
    return new NextRequest(
      `http://t/api/inbound-shipments/${ORDER_ID}/lines/${LINE_ID}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
      },
    );
  }

  it('edits an ORDERED line through a status-guarded claim and records the diff', async () => {
    const res = await patchLinePATCH(
      patchReq({ orderedQuantity: 120, lineTotalCents: 150_000, notes: 'revised' }),
      lineParams,
    );

    expect(res.status).toBe(200);
    const claim = db.stagingItem.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({ id: LINE_ID, shipmentId: ORDER_ID, status: 'ORDERED' });
    expect(claim.data).toEqual({
      orderedQuantity: 120,
      lineTotalCents: 150_000,
      notes: 'revised',
    });

    const updates = recorded('STAGING_UPDATE');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ entityType: 'STAGING', entityId: LINE_ID });
    expect(updates[0].changes.orderedQuantity).toEqual({ from: 100, to: 120 });
  });

  it('re-maps the product through the resolver and RE-SNAPSHOTS the description', async () => {
    mockResolve.mockResolvedValue({
      productId: 88,
      productName: 'Cap Red',
      approvalStatus: 'APPROVED',
      created: false,
      locationId: 1,
    });

    await patchLinePATCH(patchReq({ product: { mode: 'existing', productId: 88 } }), lineParams);

    expect(db.stagingItem.updateMany.mock.calls[0][0].data).toEqual({
      orderedProductId: 88,
      resolvedProductId: 88,
      description: 'Cap Red',
    });
    const changes = recorded('STAGING_UPDATE')[0].changes;
    expect(changes.resolvedProductId).toEqual({ from: 31, to: 88 });
    expect(changes.description).toEqual({ from: 'Vial Blue', to: 'Cap Red' });
  });

  it('allows ONLY notes + labelingRequired on a VERIFIED line with nothing booked', async () => {
    lockedLineRow = lineRow({ status: 'VERIFIED', verifiedQuantity: 90 });

    const ok = await patchLinePATCH(patchReq({ labelingRequired: false }), lineParams);
    expect(ok.status).toBe(200);
    expect(db.stagingItem.updateMany.mock.calls[0][0].where).toEqual({
      id: LINE_ID,
      shipmentId: ORDER_ID,
      status: 'VERIFIED',
      stockedQuantity: 0,
      disposedQuantity: 0,
    });

    const refused = await patchLinePATCH(patchReq({ orderedQuantity: 5 }), lineParams);
    const json = await refused.json();
    expect(refused.status).toBe(409);
    expect(json.code).toBe('CONFLICT');
  });

  it('409 VERIFIED_LOCKED once anything is stocked or disposed', async () => {
    lockedLineRow = lineRow({
      status: 'LABELING',
      verifiedQuantity: 90,
      stockedQuantity: 40,
      disposedQuantity: 2,
    });

    const res = await patchLinePATCH(patchReq({ notes: 'late note' }), lineParams);
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe('VERIFIED_LOCKED');
    expect(json.stocked).toBe(40);
    expect(json.disposed).toBe(2);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('409s a COMPLETE line and 404s a line that belongs to another order', async () => {
    lockedLineRow = lineRow({ status: 'COMPLETE', verifiedQuantity: 90, stockedQuantity: 90 });
    expect((await patchLinePATCH(patchReq({ notes: 'x' }), lineParams)).status).toBe(409);

    lockedLineRow = null;
    expect((await patchLinePATCH(patchReq({ notes: 'x' }), lineParams)).status).toBe(404);
  });

  it('400s an empty patch and a non-numeric line id', async () => {
    expect((await patchLinePATCH(patchReq({}), lineParams)).status).toBe(400);
    expect(
      (
        await patchLinePATCH(patchReq({ notes: 'x' }), {
          params: { id: ORDER_ID, lineId: 'abc' },
        } as never)
      ).status,
    ).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The legacy discriminator (REV-10 clause 4)
// ---------------------------------------------------------------------------

describe('POST .../lines — receivedAt is written NULL, never left to the default', () => {
  const orderedLineBody = {
    product: { mode: 'existing', productId: 31 },
    orderedQuantity: 100,
    lineTotalCents: 100_000,
  };
  const arrivedLineBody = {
    product: { mode: 'existing', productId: 31 },
    verifiedQuantity: 6,
  };

  it('an ORDERED line create says receivedAt: null explicitly', async () => {
    await addLinePOST(mkReq('/lines', orderedLineBody), orderParams);

    const [args] = db.stagingItem.create.mock.calls[0];
    expect(args.data).toHaveProperty('receivedAt', null);
    expect(args.data).toHaveProperty('receivedBy', null);
  });

  it('an UNORDERED ARRIVAL create says receivedAt: null explicitly', async () => {
    headerStatus = 'RECEIVING';

    await addLinePOST(mkReq('/lines', arrivedLineBody), orderParams);

    const [args] = db.stagingItem.create.mock.calls[0];
    // The column's DB default is CURRENT_TIMESTAMP (kept for rollback
    // compatibility), so an omitted field would stamp a timestamp — and
    // `receivedAt IS NOT NULL` is what makes a row LEGACY.
    expect(args.data).toHaveProperty('receivedAt', null);
    expect(args.data).toHaveProperty('receivedBy', null);
  });
});

// ---------------------------------------------------------------------------
// POST .../lines/[lineId]/discard
// ---------------------------------------------------------------------------

describe('POST /api/inbound-shipments/[id]/lines/[lineId]/discard', () => {
  it('claims ORDERED -> DISCARDED and records STAGING_DISCARD with the fixed reason', async () => {
    const res = await discardPOST(mkReq(`/lines/${LINE_ID}/discard`, {}), lineParams);

    expect(res.status).toBe(200);
    // REV-10 clause 3: the guard gained the two counters, because VERIFIED is
    // now removable too and only a line with NOTHING booked may go.
    expect(db.stagingItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: LINE_ID,
        shipmentId: ORDER_ID,
        status: 'ORDERED',
        stockedQuantity: 0,
        disposedQuantity: 0,
      },
      data: { status: 'DISCARDED' },
    });

    const discards = recorded('STAGING_DISCARD');
    expect(discards).toHaveLength(1);
    expect(discards[0]).toMatchObject({
      entityType: 'STAGING',
      entityId: LINE_ID,
      batchId: 'batch-lines-0001',
    });
    expect(discards[0].details).toMatchObject({
      reason: 'order-line-removed',
      shipmentId: ORDER_ID,
      priorStatus: 'ORDERED',
    });
    // A line removed before anything arrived is not a money loss.
    expect(mockUpsert).not.toHaveBeenCalled();
    // An ORDERED line never had a discrepancy row to close.
    expect(mockResolveExc).not.toHaveBeenCalled();
  });

  it('removes a VERIFIED line with NOTHING booked, closing its discrepancy in the same tx', async () => {
    headerStatus = 'RECEIVING';
    lockedLineRow = lineRow({ status: 'VERIFIED', verifiedQuantity: 0 });

    const res = await discardPOST(mkReq(`/lines/${LINE_ID}/discard`, {}), lineParams);

    expect(res.status).toBe(200);
    expect(db.stagingItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: LINE_ID,
        shipmentId: ORDER_ID,
        status: 'VERIFIED',
        stockedQuantity: 0,
        disposedQuantity: 0,
      },
      data: { status: 'DISCARDED' },
    });
    expect(mockResolveExc).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        key: `recv-discrepancy:${LINE_ID}`,
        resolvedBy: APPROVED_USER.id,
        resolution: 'recount-corrected',
        note: 'line removed',
      }),
    );
    expect(recorded('STAGING_DISCARD')[0].details).toMatchObject({
      reason: 'order-line-removed',
      priorStatus: 'VERIFIED',
    });
  });

  it('409s a VERIFIED line that already has booked units, writing nothing', async () => {
    headerStatus = 'RECEIVING';
    lockedLineRow = lineRow({ status: 'VERIFIED', verifiedQuantity: 90, stockedQuantity: 10 });

    const res = await discardPOST(mkReq(`/lines/${LINE_ID}/discard`, {}), lineParams);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CONFLICT');
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
    expect(mockResolveExc).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('409s a LABELING line — removal stops once the bench has the units', async () => {
    headerStatus = 'RECEIVING';
    lockedLineRow = lineRow({ status: 'LABELING', verifiedQuantity: 90 });

    const res = await discardPOST(mkReq(`/lines/${LINE_ID}/discard`, {}), lineParams);

    expect(res.status).toBe(409);
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
  });

  it('409s a line that is no longer ORDERED, and 404s one this order does not own', async () => {
    db.stagingItem.updateMany.mockResolvedValue({ count: 0 });

    lockedLineRow = lineRow({ status: 'COMPLETE', verifiedQuantity: 90 });
    const conflict = await discardPOST(mkReq(`/lines/${LINE_ID}/discard`, {}), lineParams);
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe('CONFLICT');

    lockedLineRow = null;
    const missing = await discardPOST(mkReq(`/lines/${LINE_ID}/discard`, {}), lineParams);
    expect(missing.status).toBe(404);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });
});
