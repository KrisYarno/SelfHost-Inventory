// @jest-environment node
/**
 * M3a — `PATCH /api/inbound-shipments/[id]`, REWRITTEN for the supply order.
 *
 * The route forks on the header's MODEL first (a legacy W1 receipt is history:
 * 409 `LEGACY_READ_ONLY`) and then on its STATUS, never on the body. Three
 * shapes live here: header field edits (legal while ORDERED|RECEIVING),
 * `action:'close'` (RECEIVING only, refused while any line is still ORDERED) and
 * `action:'cancel'` (ORDERED only, its lines DISCARDED).
 *
 * The claim helpers (`lockLinesForUpdate`, `claimHeaderTransition`) are REAL:
 * this suite pins their SQL SHAPE through a mocked Prisma, because the FD2-1
 * locking read and the ascending line claims ARE the close's correctness.
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
    inboundShipment: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
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
  newBatchId: jest.fn(() => 'batch-patch-0001'),
}));

import { PATCH } from '@/app/api/inbound-shipments/[id]/route';
import { requireApproved } from '@/lib/api-utils';
import { validateCSRFToken } from '@/lib/csrf';
import { recordChange, newBatchId } from '@/lib/change-tracking';
import prisma from '@/lib/prisma';

const db = prisma as unknown as Record<string, any>;
const mockRecordChange = recordChange as jest.Mock;
const mockNewBatchId = newBatchId as jest.Mock;

const APPROVED_USER = { id: 7, isAdmin: false, isApproved: true };
const ORDER_ID = 'cksupplyorder00000000001';

function setApprovedUser() {
  (requireApproved as jest.Mock).mockResolvedValue({ user: APPROVED_USER });
}

function mkReq(body: unknown) {
  return new NextRequest(`http://t/api/inbound-shipments/${ORDER_ID}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
  });
}

const params = { params: { id: ORDER_ID } } as never;

function headerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    supplierRef: 'PO-42',
    supplier: 'Acme',
    status: 'ORDERED',
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
    ...overrides,
  };
}

function lockedLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 501,
    status: 'VERIFIED',
    verifiedQuantity: 90,
    stockedQuantity: 0,
    disposedQuantity: 0,
    resolvedProductId: 31,
    orderedQuantity: 100,
    lineTotalCents: 100_000,
    shipmentId: ORDER_ID,
    locationId: null,
    labelingRequired: true,
    ...overrides,
  };
}

/** What the LOCKING header read finds — the FD4-2 before-image. */
let lockedHeaderRow: Record<string, unknown> | null = null;
/** What the FD2-1 locking line read finds. */
let lockedLineRows: Record<string, unknown>[] = [];

function setHeader(row: Record<string, unknown> | null) {
  db.inboundShipment.findUnique.mockResolvedValue(row);
  lockedHeaderRow = row;
}

/** ONE `$queryRaw` mock for the route's two raw statements, told apart by table. */
function rawReads() {
  db.$queryRaw.mockImplementation(async (statement: { sql?: string }) => {
    const sql = String(statement?.sql ?? '');
    if (/inbound_shipments/i.test(sql)) {
      return lockedHeaderRow === null ? [] : [{ ...lockedHeaderRow }];
    }
    return lockedLineRows;
  });
}

const rawStatements = () => db.$queryRaw.mock.calls.map((c: unknown[]) => c[0]);
const rawSql = (table: RegExp) =>
  rawStatements().find((s: { sql?: string }) => table.test(String(s?.sql ?? '')));
const rawOrder = (table: RegExp) => {
  const index = rawStatements().findIndex((s: { sql?: string }) =>
    table.test(String(s?.sql ?? '')),
  );
  return index < 0 ? Infinity : db.$queryRaw.mock.invocationCallOrder[index];
};

const recorded = (actionType: string) =>
  mockRecordChange.mock.calls.filter((c) => c[1].actionType === actionType).map((c) => c[1]);

beforeEach(() => {
  jest.clearAllMocks();
  (validateCSRFToken as jest.Mock).mockResolvedValue(true);
  mockNewBatchId.mockReturnValue('batch-patch-0001');
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.inboundShipment.updateMany.mockResolvedValue({ count: 1 });
  db.inboundShipment.update.mockResolvedValue(headerRow());
  db.stagingItem.updateMany.mockResolvedValue({ count: 1 });
  db.stagingItem.findMany.mockImplementation(async (args: { select?: unknown }) =>
    args?.select ? lockedLineRows.map((l) => ({ id: l.id })) : lockedLineRows,
  );
  db.inventoryException.findMany.mockResolvedValue([]);
  lockedHeaderRow = null;
  lockedLineRows = [];
  rawReads();
  setApprovedUser();
});

describe('PATCH /api/inbound-shipments/[id] — the model fork', () => {
  it('404s an unknown id', async () => {
    setHeader(null);

    const res = await PATCH(mkReq({ notes: 'x' }), params);

    expect(res.status).toBe(404);
  });

  it('409 LEGACY_READ_ONLY on a legacy header (orderedAt IS NULL), for edits and actions alike', async () => {
    setHeader(headerRow({ orderedAt: null, status: 'CLOSED' }));

    const edit = await PATCH(mkReq({ notes: 'x' }), params);
    const editJson = await edit.json();
    expect(edit.status).toBe(409);
    expect(editJson.code).toBe('LEGACY_READ_ONLY');

    const close = await PATCH(mkReq({ action: 'close' }), params);
    expect(close.status).toBe(409);
    expect((await close.json()).code).toBe('LEGACY_READ_ONLY');

    expect(mockRecordChange).not.toHaveBeenCalled();
    expect(db.inboundShipment.updateMany).not.toHaveBeenCalled();
  });

  it('400s an empty body and 403s an invalid CSRF token', async () => {
    setHeader(headerRow());

    expect((await PATCH(mkReq({}), params)).status).toBe(400);

    (validateCSRFToken as jest.Mock).mockResolvedValue(false);
    expect((await PATCH(mkReq({ notes: 'x' }), params)).status).toBe(403);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/inbound-shipments/[id] — header edits', () => {
  it('edits while ORDERED through a status-guarded claim and records the diff', async () => {
    setHeader(headerRow({ notes: 'old' }));
    db.stagingItem.findMany.mockResolvedValue([]);

    const res = await PATCH(
      mkReq({ notes: 'new', supplier: 'Beta', feesCents: 1500, orderedAt: '2026-08-15' }),
      params,
    );

    expect(res.status).toBe(200);
    const claim = db.inboundShipment.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({ id: ORDER_ID, status: { in: ['ORDERED', 'RECEIVING'] } });
    expect(claim.data).toEqual({
      notes: 'new',
      supplier: 'Beta',
      feesCents: 1500,
      orderedAt: new Date('2026-08-15T00:00:00.000Z'),
    });

    const updates = recorded('SHIPMENT_UPDATE');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ entityType: 'SHIPMENT', entityId: ORDER_ID });
    expect(updates[0].changes.notes).toEqual({ from: 'old', to: 'new' });
    expect(updates[0].changes.supplier).toEqual({ from: 'Acme', to: 'Beta' });
  });

  it('writes no audit line when the diff is empty (ER-B9)', async () => {
    setHeader(headerRow({ notes: 'same' }));

    const res = await PATCH(mkReq({ notes: 'same' }), params);

    expect(res.status).toBe(200);
    expect(recorded('SHIPMENT_UPDATE')).toHaveLength(0);
  });

  it('measures the diff against the LOCKED header, not the snapshot (FD4-2)', async () => {
    setHeader(headerRow({ notes: 'A' }));
    // A concurrent edit committed A -> B between the snapshot and our lock.
    lockedHeaderRow = headerRow({ notes: 'B' });

    await PATCH(mkReq({ notes: 'C' }), params);

    expect(recorded('SHIPMENT_UPDATE')[0].changes.notes).toEqual({ from: 'B', to: 'C' });
  });

  it('409s when the claim finds a settled header (CLOSED/CANCELLED)', async () => {
    setHeader(headerRow({ status: 'CLOSED' }));
    db.inboundShipment.updateMany.mockResolvedValue({ count: 0 });

    const res = await PATCH(mkReq({ notes: 'x' }), params);
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe('CONFLICT');
    expect(mockRecordChange).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/inbound-shipments/[id] — action: 'close'", () => {
  it('REFUSES while any line is still ORDERED: the frozen 409 UNVERIFIED envelope', async () => {
    setHeader(headerRow({ status: 'RECEIVING' }));
    lockedLineRows = [
      lockedLine(),
      lockedLine({ id: 502, status: 'ORDERED', verifiedQuantity: null }),
      lockedLine({ id: 503, status: 'ORDERED', verifiedQuantity: null }),
    ];

    const res = await PATCH(mkReq({ action: 'close' }), params);
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe('UNVERIFIED');
    expect(json.lineIds).toEqual([502, 503]);
    expect(typeof json.error).toBe('string');
    expect(mockRecordChange).not.toHaveBeenCalled();
    expect(db.inboundShipment.update).not.toHaveBeenCalled();
  });

  it('refuses an ORDERED header by name: nothing verified — cancel instead', async () => {
    setHeader(headerRow({ status: 'ORDERED' }));
    lockedLineRows = [lockedLine({ status: 'DISCARDED', verifiedQuantity: null })];

    const res = await PATCH(mkReq({ action: 'close' }), params);
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe('CONFLICT');
    expect(json.error).toMatch(/nothing verified/i);
    expect(json.error).toMatch(/cancel/i);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('closes a RECEIVING order, stamping closedBy/closedAt and recording the rollup', async () => {
    setHeader(headerRow({ status: 'RECEIVING' }));
    lockedLineRows = [
      lockedLine(),
      lockedLine({ id: 502, status: 'COMPLETE', verifiedQuantity: 100, stockedQuantity: 100 }),
      lockedLine({ id: 503, status: 'DISCARDED', verifiedQuantity: null, orderedQuantity: 5 }),
    ];

    const res = await PATCH(mkReq({ action: 'close' }), params);

    expect(res.status).toBe(200);
    const stamp = db.inboundShipment.update.mock.calls[0][0];
    expect(stamp.where).toEqual({ id: ORDER_ID });
    expect(stamp.data.closedBy).toBe(APPROVED_USER.id);
    expect(stamp.data.closedAt).toBeInstanceOf(Date);

    const closes = recorded('SHIPMENT_CLOSE');
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({
      entityType: 'SHIPMENT',
      entityId: ORDER_ID,
      batchId: 'batch-patch-0001',
    });
    expect(closes[0].details.discrepancy).toMatchObject({
      linesWithDiscrepancy: 1,
      shortUnits: 10,
    });
    expect(closes[0].details.lineStatusCounts).toEqual({
      ordered: 0,
      verified: 1,
      labeling: 0,
      complete: 1,
      discarded: 1,
    });
  });

  it('claims RECEIVING -> CLOSED and nothing else', async () => {
    setHeader(headerRow({ status: 'RECEIVING' }));
    lockedLineRows = [lockedLine()];

    await PATCH(mkReq({ action: 'close' }), params);

    expect(db.inboundShipment.updateMany).toHaveBeenCalledWith({
      where: { id: ORDER_ID, status: { in: ['RECEIVING'] } },
      data: { status: 'CLOSED' },
    });
  });

  it('takes the FD2-1 line locks — ascending claims, then ONE ORDER BY id FOR UPDATE — before the header lock', async () => {
    setHeader(headerRow({ status: 'RECEIVING' }));
    lockedLineRows = [lockedLine(), lockedLine({ id: 502 })];

    await PATCH(mkReq({ action: 'close' }), params);

    const lineRead = rawSql(/staging_items/i);
    expect(String(lineRead.sql)).toMatch(/ORDER BY id FOR UPDATE/i);
    expect(lineRead.values).toContain(ORDER_ID);
    // The snapshot pass claims each line by id, pinning membership.
    const claims = db.stagingItem.updateMany.mock.calls.map((c: any[]) => c[0].where);
    expect(claims).toEqual([
      { id: 501, shipmentId: ORDER_ID },
      { id: 502, shipmentId: ORDER_ID },
    ]);
    // Lock order: lines(asc) -> header.
    expect(rawOrder(/staging_items/i)).toBeLessThan(rawOrder(/inbound_shipments/i));
  });
});

describe("PATCH /api/inbound-shipments/[id] — action: 'cancel'", () => {
  it('discards every ORDERED line and CANCELS the header', async () => {
    setHeader(headerRow({ status: 'ORDERED' }));
    lockedLineRows = [
      lockedLine({ status: 'ORDERED', verifiedQuantity: null }),
      lockedLine({ id: 502, status: 'ORDERED', verifiedQuantity: null }),
    ];

    const res = await PATCH(mkReq({ action: 'cancel' }), params);

    expect(res.status).toBe(200);
    const discard = db.stagingItem.updateMany.mock.calls.find(
      (c: any[]) => c[0].data?.status === 'DISCARDED',
    );
    expect(discard[0].where).toEqual({
      shipmentId: ORDER_ID,
      status: 'ORDERED',
    });
    expect(db.inboundShipment.updateMany).toHaveBeenCalledWith({
      where: { id: ORDER_ID, status: { in: ['ORDERED'] } },
      data: { status: 'CANCELLED' },
    });

    const cancels = recorded('SHIPMENT_CANCEL');
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatchObject({ entityType: 'SHIPMENT', entityId: ORDER_ID });
    expect(cancels[0].details.discardedLineIds).toEqual([501, 502]);
  });

  it('409s a RECEIVING order (lines are verified — it closes, it does not cancel)', async () => {
    setHeader(headerRow({ status: 'RECEIVING' }));
    lockedLineRows = [lockedLine()];

    const res = await PATCH(mkReq({ action: 'cancel' }), params);
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe('CONFLICT');
    expect(mockRecordChange).not.toHaveBeenCalled();
    expect(
      db.stagingItem.updateMany.mock.calls.some((c: any[]) => c[0].data?.status === 'DISCARDED'),
    ).toBe(false);
  });
});

describe('PATCH /api/inbound-shipments/[id] — the batch', () => {
  it('mints ONE batchId outside the retry, even when the transaction re-runs', async () => {
    setHeader(headerRow({ status: 'RECEIVING' }));
    lockedLineRows = [lockedLine()];
    let attempts = 0;
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      attempts += 1;
      if (attempts === 1) {
        const deadlock: Error & { code?: string } = new Error('Deadlock found');
        deadlock.code = 'P2034';
        throw deadlock;
      }
      return fn(db);
    });

    const res = await PATCH(mkReq({ action: 'close' }), params);

    expect(res.status).toBe(200);
    expect(attempts).toBe(2);
    expect(mockNewBatchId).toHaveBeenCalledTimes(1);
  });
});
