// @jest-environment node
/**
 * FD3-1 (fix round 4) — `POST /api/inbound-shipments/[id]/costs`: THE WHOLE BILL,
 * IN ONE TRANSACTION.
 *
 * Three consecutive rounds of partial-commit hazards (W1S-5, FD-1, FD3-1) all
 * came out of the same shape: the freight panel's Accept fanned out into one
 * PATCH per line, and those PATCHes were not one transaction. The last of them
 * is the sharpest — line A lands, line B refuses, and the recovery the panel
 * offers ("clear and re-enter the FULL freight") re-allocates the whole invoice
 * INCLUDING onto A's base, which has already absorbed its share. Landed costs
 * silently overstated, by following the instructions on screen.
 *
 * So the fan-out is gone. A bill is ONE request and ONE `prisma.$transaction`:
 *
 *   - lines are written ASCENDING BY ID (the house item lock order, shared with
 *     the count endpoint, graduation and the settle paths);
 *   - every line's write is a CLAIM whose WHERE carries the whole precondition —
 *     the line, ITS SHIPMENT, still RECEIVED, and still holding the exact cost
 *     the split was computed against;
 *   - `count === 0` disambiguates exactly as the round-3 PATCH did (a no-op
 *     re-claim answers "is this still one of my receiving lines?") and then
 *     THROWS, which rolls back every line that already wrote. All-or-nothing is
 *     the entire point: after a refusal there is nothing to recover from, so
 *     re-entering the full freight is safe again;
 *   - the per-line audit rides the SAME transaction (house D4).
 */

import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

jest.mock('@/lib/api-utils', () => {
  const actual = jest.requireActual('@/lib/api-utils');
  return {
    __esModule: true,
    ...actual,
    requireApproved: jest.fn(),
  };
});

// The transaction client is a DISTINCT set of mocks from the root client, so
// "every write happened inside the transaction" is an assertion this file can
// actually make rather than a claim it has to take on trust.
jest.mock('@/lib/prisma', () => {
  const txClient = {
    stagingItem: {
      updateMany: jest.fn(),
    },
  };
  return {
    __esModule: true,
    default: {
      stagingItem: {
        updateMany: jest.fn(),
        findMany: jest.fn(async () => []),
      },
      inboundShipment: {
        findUnique: jest.fn(async () => null),
      },
      $transaction: jest.fn(async (fn: any) => fn(txClient)),
      __txClient: txClient,
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

import { POST } from '@/app/api/inbound-shipments/[id]/costs/route';
import { requireApproved } from '@/lib/api-utils';
import { validateCSRFToken } from '@/lib/csrf';
import { enforceRateLimit } from '@/lib/rateLimit';
import { recordChange } from '@/lib/change-tracking';
import prisma from '@/lib/prisma';

const db: any = prisma as any;
const tx: any = db.__txClient;
const mockValidateCSRF = validateCSRFToken as jest.Mock;
const mockRecordChange = recordChange as jest.Mock;
const mockEnforceRateLimit = enforceRateLimit as jest.Mock;

const APPROVED_USER = { id: 7, isAdmin: false, isApproved: true };
const SHIPMENT_ID = 'ckshipment000000000000001';
const OTHER_SHIPMENT = 'ckshipment000000000000002';

/** Did the transaction CALLBACK reject? That rejection IS the rollback. */
let txRejected = false;

function setApprovedUser(user: any = APPROVED_USER) {
  (requireApproved as jest.Mock).mockResolvedValue({ user });
}

function mkReq(body: unknown, id: string = SHIPMENT_ID) {
  return new NextRequest(`http://t/api/inbound-shipments/${id}/costs`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
  });
}

const post = (body: unknown, id: string = SHIPMENT_ID) =>
  POST(mkReq(body, id), { params: { id } });

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

/** The detail re-read a successful bill performs before responding. */
function primeDetailRead(items: any[] = []) {
  db.inboundShipment.findUnique.mockResolvedValue(shipmentRow());
  db.stagingItem.findMany.mockResolvedValue(items);
}

/** Every in-transaction claim, in call order, as {where, data}. */
const claims = () => tx.stagingItem.updateMany.mock.calls.map((c: any[]) => c[0]);
/** The claims that actually WRITE a cost (the no-op re-claims restate status). */
const costWrites = () =>
  claims().filter((args: any) => args?.data && 'unitCostCents' in args.data);

/**
 * Drive the per-line claims. `drifted` names lines whose cost precondition
 * misses while the line is otherwise untouched (somebody repriced it);
 * `departed` names lines that are no longer this shipment's RECEIVED lines at
 * all (graduated, unlinked, cancelled out) — for those even the no-op re-claim
 * misses.
 */
function lineClaims({
  drifted = [],
  departed = [],
}: { drifted?: number[]; departed?: number[] } = {}) {
  tx.stagingItem.updateMany.mockImplementation(async (args: any) => {
    const id = args?.where?.id;
    if (departed.includes(id)) return { count: 0 };
    if (drifted.includes(id) && args?.data && 'unitCostCents' in args.data) {
      return { count: 0 };
    }
    return { count: 1 };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  txRejected = false;
  mockValidateCSRF.mockResolvedValue(true);
  mockEnforceRateLimit.mockReturnValue({});
  setApprovedUser();
  db.$transaction = jest.fn(async (fn: any) => {
    try {
      return await fn(tx);
    } catch (error) {
      txRejected = true;
      throw error;
    }
  });
  tx.stagingItem.updateMany.mockResolvedValue({ count: 1 });
  db.stagingItem.updateMany.mockResolvedValue({ count: 1 });
  primeDetailRead();
});

// ---------------------------------------------------------------------------
// 1. THE BATCH WRITE — one transaction, every line, or nothing
// ---------------------------------------------------------------------------

describe('POST /api/inbound-shipments/[id]/costs (the whole bill)', () => {
  it('writes every line of the bill inside ONE transaction', async () => {
    lineClaims();

    const resp = await post({
      lines: [
        { id: 11, unitCostCents: 600, ifUnitCostCents: 500 },
        { id: 12, unitCostCents: 240, ifUnitCostCents: 200 },
      ],
    });

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(costWrites()).toHaveLength(2);
    // ...and NOTHING wrote outside it: a bill that escapes the transaction is
    // exactly the fan-out this route replaces.
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
  });

  it('claims the lines ASCENDING BY ID, whatever order they arrived in', async () => {
    lineClaims();

    await post({
      lines: [
        { id: 31, unitCostCents: 600, ifUnitCostCents: 500 },
        { id: 11, unitCostCents: 240, ifUnitCostCents: 200 },
        { id: 22, unitCostCents: 100, ifUnitCostCents: null },
      ],
    });

    expect(costWrites().map((args: any) => args.where.id)).toEqual([11, 22, 31]);
  });

  it('pins the WHERE on the line, ITS SHIPMENT, RECEIVED, and the expected cost', async () => {
    lineClaims();

    await post({ lines: [{ id: 11, unitCostCents: 600, ifUnitCostCents: 500 }] });

    const write = costWrites()[0];
    expect(write.where).toEqual({
      id: 11,
      shipmentId: SHIPMENT_ID,
      status: 'RECEIVED',
      unitCostCents: 500,
    });
    // The precondition is a GUARD, never a written column.
    expect(write.data).toEqual({ unitCostCents: 600 });
  });

  it('an explicit NULL precondition means "only if it is still unpriced"', async () => {
    lineClaims();

    const resp = await post({
      lines: [{ id: 11, unitCostCents: 600, ifUnitCostCents: null }],
    });

    expect(resp.status).toBe(200);
    expect(costWrites()[0].where).toMatchObject({ id: 11, unitCostCents: null });
  });

  it('audits EVERY line inside the same transaction, in the per-line cost shape', async () => {
    lineClaims();

    await post({
      lines: [
        { id: 11, unitCostCents: 600, ifUnitCostCents: 500 },
        { id: 12, unitCostCents: 240, ifUnitCostCents: null },
      ],
    });

    expect(mockRecordChange).toHaveBeenCalledTimes(2);
    // The tx handle, not the root client (D4: the audit cannot outlive a
    // rolled-back write, and a write cannot commit without its audit).
    expect(mockRecordChange.mock.calls[0][0]).toBe(tx);
    expect(mockRecordChange.mock.calls[0][1]).toMatchObject({
      actionType: 'STAGING_UPDATE',
      entityType: 'STAGING',
      entityId: 11,
      actor: { userId: APPROVED_USER.id },
      changes: { unitCostCents: { from: 500, to: 600 } },
    });
    // The precondition IS the before-image: the write only matched because the
    // row still carried it, so the diff needs no second read to be honest.
    expect(mockRecordChange.mock.calls[1][1]).toMatchObject({
      entityId: 12,
      changes: { unitCostCents: { from: null, to: 240 } },
    });
  });

  it('writes but does NOT audit a line whose cost is unchanged (ER-B9)', async () => {
    lineClaims();

    // Freight of 0 (or a zero-value line) suggests the base back: the guarded
    // write still runs — it is what proves the row is untouched — but a
    // from===to diff is not a change, and the house rule writes no event for it.
    await post({
      lines: [
        { id: 11, unitCostCents: 500, ifUnitCostCents: 500 },
        { id: 12, unitCostCents: 240, ifUnitCostCents: 200 },
      ],
    });

    expect(costWrites()).toHaveLength(2);
    expect(mockRecordChange).toHaveBeenCalledTimes(1);
    expect(mockRecordChange.mock.calls[0][1]).toMatchObject({ entityId: 12 });
  });

  it('responds with the SAME detail shape GET serves', async () => {
    lineClaims();
    primeDetailRead([
      {
        id: 11,
        description: 'Vials',
        status: 'RECEIVED',
        expectedQuantity: 10,
        countedQuantity: 10,
        unitCostCents: 600,
        resolvedProductId: null,
        locationId: 1,
        vendor: null,
        reference: null,
        notes: null,
        receivedAt: new Date('2026-08-13T11:00:00.000Z'),
        countedAt: null,
        countedBy: null,
        location: { id: 1, name: 'Main' },
        resolvedProduct: null,
        shipmentId: SHIPMENT_ID,
      },
    ]);

    const resp = await post({
      lines: [{ id: 11, unitCostCents: 600, ifUnitCostCents: 500 }],
    });

    const body = await resp.json();
    expect(body.id).toBe(SHIPMENT_ID);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].unitCostCents).toBe(600);
    expect(body.discrepancy).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. FD3-1 — a refusal on ANY line rolls back EVERY line
// ---------------------------------------------------------------------------

describe('POST /api/inbound-shipments/[id]/costs — all or nothing (FD3-1)', () => {
  it('THE FD3-1 SCENARIO: line A lands, line B drifts, and A rolls back with it', async () => {
    // Line 12's cost moved under the bill; line 11's write already ran.
    lineClaims({ drifted: [12] });

    const resp = await post({
      lines: [
        { id: 11, unitCostCents: 600, ifUnitCostCents: 500 },
        { id: 12, unitCostCents: 240, ifUnitCostCents: 200 },
      ],
    });

    expect(resp.status).toBe(409);
    const json = await resp.json();
    expect(json.code).toBe('COST_DRIFT');
    // THE ROLLBACK: the refusal is a THROW out of the transaction callback, so
    // line 11's write — which really did run — never commits. A returned refusal
    // would have COMMITTED it, which is the whole of FD3-1.
    expect(txRejected).toBe(true);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // Line 11's write happened INSIDE that transaction and nowhere else.
    expect(costWrites().map((args: any) => args.where.id)).toEqual([11, 12]);
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
  });

  it('names the line whose cost drifted', async () => {
    lineClaims({ drifted: [12] });

    const resp = await post({
      lines: [
        { id: 11, unitCostCents: 600, ifUnitCostCents: 500 },
        { id: 12, unitCostCents: 240, ifUnitCostCents: 200 },
      ],
    });

    const json = await resp.json();
    expect(json.error).toMatch(/12/);
    expect(json.error).toMatch(/cost changed/i);
  });

  it('a line that LEFT the shipment mid-bill refuses as a state CONFLICT', async () => {
    // The no-op re-claim pins shipmentId too, so an unlinked line misses BOTH
    // claims: it is not priced while it sits outside the receipt.
    lineClaims({ departed: [12] });

    const resp = await post({
      lines: [
        { id: 11, unitCostCents: 600, ifUnitCostCents: 500 },
        { id: 12, unitCostCents: 240, ifUnitCostCents: 200 },
      ],
    });

    expect(resp.status).toBe(409);
    const json = await resp.json();
    expect(json.code).toBe('CONFLICT');
    expect(json.error).toMatch(/12/);
    expect(txRejected).toBe(true);
  });

  it('a GRADUATED line is a state CONFLICT, never COST_DRIFT', async () => {
    lineClaims({ departed: [11] });

    const resp = await post({
      lines: [{ id: 11, unitCostCents: 600, ifUnitCostCents: 500 }],
    });

    expect(resp.status).toBe(409);
    expect((await resp.json()).code).toBe('CONFLICT');
  });

  it('the disambiguating re-claim writes NOTHING new and pins the shipment', async () => {
    lineClaims({ drifted: [11] });

    await post({ lines: [{ id: 11, unitCostCents: 600, ifUnitCostCents: 500 }] });

    const reclaim = claims().find((args: any) => !('unitCostCents' in (args.data ?? {})));
    expect(reclaim.where).toEqual({ id: 11, shipmentId: SHIPMENT_ID, status: 'RECEIVED' });
    expect(reclaim.data).toEqual({ status: 'RECEIVED' });
  });

  it('a refusal on the FIRST line never reaches the second (nothing is written after it)', async () => {
    lineClaims({ drifted: [11] });

    await post({
      lines: [
        { id: 11, unitCostCents: 600, ifUnitCostCents: 500 },
        { id: 12, unitCostCents: 240, ifUnitCostCents: 200 },
      ],
    });

    expect(costWrites().map((args: any) => args.where.id)).toEqual([11]);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('a bill aimed at ANOTHER shipment writes nothing (the WHERE pins the route id)', async () => {
    lineClaims();

    await post({ lines: [{ id: 11, unitCostCents: 600, ifUnitCostCents: 500 }] }, OTHER_SHIPMENT);

    expect(costWrites()[0].where.shipmentId).toBe(OTHER_SHIPMENT);
  });
});

// ---------------------------------------------------------------------------
// 3. The request contract
// ---------------------------------------------------------------------------

describe('POST /api/inbound-shipments/[id]/costs — the request', () => {
  it('400s an EMPTY bill — a request that writes nothing is a client bug', async () => {
    const resp = await post({ lines: [] });

    expect(resp.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('400s a DUPLICATE line id — the same line twice has no single answer', async () => {
    const resp = await post({
      lines: [
        { id: 11, unitCostCents: 600, ifUnitCostCents: 500 },
        { id: 11, unitCostCents: 700, ifUnitCostCents: 600 },
      ],
    });

    expect(resp.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('400s a line missing its precondition (every field is required per line)', async () => {
    const resp = await post({ lines: [{ id: 11, unitCostCents: 600 }] });

    expect(resp.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('400s a fractional or negative cost (cents are whole, and never negative)', async () => {
    expect(
      (await post({ lines: [{ id: 11, unitCostCents: 6.5, ifUnitCostCents: 500 }] })).status,
    ).toBe(400);
    expect(
      (await post({ lines: [{ id: 11, unitCostCents: -1, ifUnitCostCents: 500 }] })).status,
    ).toBe(400);
    expect(
      (await post({ lines: [{ id: 11, unitCostCents: 600, ifUnitCostCents: 1.5 }] })).status,
    ).toBe(400);
  });

  it('400s a NULL cost — un-pricing a line is the manual save\'s job, not a bill\'s', async () => {
    const resp = await post({
      lines: [{ id: 11, unitCostCents: null, ifUnitCostCents: 500 }],
    });

    expect(resp.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. The guards every mutating receiving route carries
// ---------------------------------------------------------------------------

describe('POST /api/inbound-shipments/[id]/costs — guards', () => {
  it('403s an invalid CSRF token (no write, no audit)', async () => {
    mockValidateCSRF.mockResolvedValue(false);

    const resp = await post({ lines: [{ id: 11, unitCostCents: 600, ifUnitCostCents: 500 }] });

    expect(resp.status).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('refuses an unapproved caller before anything else happens', async () => {
    const { AppError } = jest.requireActual('@/lib/error-handling');
    (requireApproved as jest.Mock).mockRejectedValue(
      new AppError('Account pending approval', 'FORBIDDEN', 403),
    );

    const resp = await post({ lines: [{ id: 11, unitCostCents: 600, ifUnitCostCents: 500 }] });

    expect(resp.status).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('rate-limits per user, under its own key', async () => {
    lineClaims();

    await post({ lines: [{ id: 11, unitCostCents: 600, ifUnitCostCents: 500 }] });

    expect(mockEnforceRateLimit).toHaveBeenCalledWith(expect.anything(), 'inbound-shipment-costs:POST', {
      identifier: APPROVED_USER.id,
    });
  });
});

// ---------------------------------------------------------------------------
// 5. D9 — a new mutating route joins the change-tracking gate, unexempted
// ---------------------------------------------------------------------------

describe('D9 coverage', () => {
  it('exposes a mutating method and RECORDS its changes (never an exemption)', () => {
    expect(typeof POST).toBe('function');

    const source = fs.readFileSync(
      path.join(process.cwd(), 'app/api/inbound-shipments/[id]/costs/route.ts'),
      'utf8',
    );
    // The exact two conditions __tests__/integration/change-tracking-coverage.test.ts
    // classifies a route as RECORDS by. A route that fails them and is not in the
    // EXEMPT list fails that gate — which is the enforcement, not this pin.
    expect(source).toContain('@/lib/change-tracking');
    expect(/\brecordChange\s*\(/.test(source)).toBe(true);
    // The PER-HANDLER half of that gate: the call has to be inside the handler,
    // not one helper deep, so a route's recording cannot go missing unnoticed.
    expect(/\brecordChange\s*\(/.test(source.slice(source.indexOf('export const POST')))).toBe(
      true,
    );
  });

  it('is NOT listed as exempt in the change-tracking coverage gate', () => {
    const gate = fs.readFileSync(
      path.join(process.cwd(), '__tests__/integration/change-tracking-coverage.test.ts'),
      'utf8',
    );
    expect(gate).not.toContain('inbound-shipments/[id]/costs');
  });
});
