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
 *
 * FD4-1 (fix round 6) — THE PRECONDITION IS THE WHOLE FROZEN BASIS.
 *
 * Round 4 checked only what it wrote, and a freight split is not computed only
 * from what it writes. Two live gaps came out of that:
 *
 *   (a) QA-12 stopped sending no-op lines, so a line the panel EXCLUDED could be
 *       repriced after the last render and nothing on the server would notice —
 *       an all-onto-B split committing while the truth had become 50/50;
 *   (b) no line carried a QUANTITY precondition, so a count committing mid-Accept
 *       let per-unit costs computed over the OLD units land on the new ones.
 *
 * Now EVERY line of the frozen session travels — write lines carry
 * `unitCostCents`, verify-only lines do not — and every one of them is claimed
 * on its frozen cost AND its frozen quantity. A miss on any of them refuses the
 * whole bill as BASIS_DRIFT (the round-4 name, COST_DRIFT, would now be a lie:
 * the precondition covers quantity too).
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
    // FD5-1: the header lock and the current-membership read (`... FOR UPDATE`).
    $queryRaw: jest.fn(async () => []),
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

/** A WRITE line: the frozen basis, plus the cost to write against it. */
const write = (over: Record<string, unknown> = {}) => ({
  id: 11,
  qtySource: 'counted',
  qty: 10,
  ifUnitCostCents: 500,
  unitCostCents: 600,
  ...over,
});

/** A VERIFY-ONLY line (FD4-1): the frozen basis, claimed and checked, never written. */
const verify = (over: Record<string, unknown> = {}) => {
  const { unitCostCents: _unwritten, ...basis } = write(over);
  return basis;
};

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
/**
 * The BASIS claims — one per line of the bill, write and verify-only alike.
 * They are the ones whose WHERE carries the frozen cost (FD4-1); the
 * disambiguating re-claim below deliberately does not.
 */
const basisClaims = () => claims().filter((args: any) => 'unitCostCents' in (args?.where ?? {}));
/** The claims that actually WRITE a cost (verify-only claims restate status). */
const costWrites = () =>
  claims().filter((args: any) => args?.data && 'unitCostCents' in args.data);
/** The disambiguating no-op re-claims: id / shipment / status, nothing else. */
const reclaims = () => claims().filter((args: any) => !('unitCostCents' in (args?.where ?? {})));

/**
 * FD5-1 — the CURRENT RECEIVED membership, as the locking read finds it.
 *
 * NULL means "exactly what this bill submitted", which is the uneventful case
 * and keeps every pre-FD5-1 pin honest: nothing joined, nothing left. It is
 * derived from the claims the transaction just ran rather than restated by hand,
 * so a test that changes its bill never has to remember to change this too.
 */
let currentMembership: number[] | null = null;
const membershipIs = (ids: number[]) => {
  currentMembership = ids;
};

/** Every raw statement the route ran, as Prisma.Sql, in call order. */
const rawStatements = () => tx.$queryRaw.mock.calls.map((c: any[]) => c[0]);
const rawHeaderReads = () =>
  rawStatements().filter((s: any) => /inbound_shipments/i.test(String(s?.sql ?? '')));
const rawMembershipReads = () =>
  rawStatements().filter((s: any) => /staging_items/i.test(String(s?.sql ?? '')));
/** When the first statement matching `table` ran, on jest's global call clock. */
const rawOrder = (table: RegExp) => {
  const index = rawStatements().findIndex((s: any) => table.test(String(s?.sql ?? '')));
  return tx.$queryRaw.mock.invocationCallOrder[index];
};

/**
 * Drive the per-line claims. `drifted` names lines whose BASIS precondition
 * misses while the line is otherwise untouched (somebody repriced or recounted
 * it); `departed` names lines that are no longer this shipment's RECEIVED lines
 * at all (graduated, unlinked, cancelled out) — for those even the no-op
 * re-claim misses.
 */
function lineClaims({
  drifted = [],
  departed = [],
}: { drifted?: number[]; departed?: number[] } = {}) {
  tx.stagingItem.updateMany.mockImplementation(async (args: any) => {
    const id = args?.where?.id;
    if (departed.includes(id)) return { count: 0 };
    if (drifted.includes(id) && 'unitCostCents' in (args?.where ?? {})) {
      return { count: 0 };
    }
    return { count: 1 };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  txRejected = false;
  currentMembership = null;
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
  // ONE `$queryRaw` mock for the route's TWO raw statements (FD5-1), told apart
  // by the table they name: the header LOCK (which selects nothing anybody
  // reads) and the current RECEIVED membership.
  tx.$queryRaw.mockImplementation(async (statement: any) => {
    if (!/staging_items/i.test(String(statement?.sql ?? ''))) return [];
    const ids = currentMembership ?? basisClaims().map((args: any) => args.where.id);
    return [...ids].sort((a, b) => a - b).map((id) => ({ id }));
  });
  primeDetailRead();
});

// ---------------------------------------------------------------------------
// 1. THE BATCH WRITE — one transaction, every line, or nothing
// ---------------------------------------------------------------------------

describe('POST /api/inbound-shipments/[id]/costs (the whole bill)', () => {
  it('writes every line of the bill inside ONE transaction', async () => {
    lineClaims();

    const resp = await post({
      lines: [write({ id: 11 }), write({ id: 12, unitCostCents: 240, ifUnitCostCents: 200 })],
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
        write({ id: 31 }),
        write({ id: 11, unitCostCents: 240, ifUnitCostCents: 200 }),
        write({ id: 22, unitCostCents: 100, ifUnitCostCents: null }),
      ],
    });

    expect(costWrites().map((args: any) => args.where.id)).toEqual([11, 22, 31]);
  });

  it('pins the WHERE on the line, ITS SHIPMENT, RECEIVED, the expected cost and the frozen qty', async () => {
    lineClaims();

    await post({ lines: [write({ id: 11, qtySource: 'counted', qty: 10 })] });

    const claim = costWrites()[0];
    expect(claim.where).toEqual({
      id: 11,
      shipmentId: SHIPMENT_ID,
      status: 'RECEIVED',
      unitCostCents: 500,
      countedQuantity: 10,
    });
    // The precondition is a GUARD, never a written column.
    expect(claim.data).toEqual({ unitCostCents: 600 });
  });

  it('an explicit NULL precondition means "only if it is still unpriced"', async () => {
    lineClaims();

    const resp = await post({ lines: [write({ ifUnitCostCents: null })] });

    expect(resp.status).toBe(200);
    expect(costWrites()[0].where).toMatchObject({ id: 11, unitCostCents: null });
  });

  it('audits EVERY written line inside the same transaction, in the per-line cost shape', async () => {
    lineClaims();

    await post({
      lines: [write({ id: 11 }), write({ id: 12, unitCostCents: 240, ifUnitCostCents: null })],
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

    // A hand-edited split can land a line back on its own base: the guarded
    // write still runs — it is what proves the row is untouched — but a
    // from===to diff is not a change, and the house rule writes no event for it.
    await post({
      lines: [
        write({ id: 11, unitCostCents: 500, ifUnitCostCents: 500 }),
        write({ id: 12, unitCostCents: 240, ifUnitCostCents: 200 }),
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

    const resp = await post({ lines: [write({ id: 11 })] });

    const body = await resp.json();
    expect(body.id).toBe(SHIPMENT_ID);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].unitCostCents).toBe(600);
    expect(body.discrepancy).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. FD4-1 — THE WHOLE FROZEN BASIS IS THE PRECONDITION
// ---------------------------------------------------------------------------

describe('POST /api/inbound-shipments/[id]/costs — the frozen basis (FD4-1)', () => {
  it('PIN 5a: a COUNTED line is guarded on its counted quantity', async () => {
    lineClaims();

    await post({ lines: [write({ qtySource: 'counted', qty: 10 })] });

    expect(basisClaims()[0].where).toMatchObject({ countedQuantity: 10 });
    expect(basisClaims()[0].where).not.toHaveProperty('expectedQuantity');
  });

  it('PIN 5b: an EXPECTED line is guarded on "still uncounted, still expecting N"', async () => {
    lineClaims();

    await post({ lines: [write({ qtySource: 'expected', qty: 8 })] });

    // A count landing mid-bill makes countedQuantity non-null, so this misses —
    // which is the point: the split rested on the expectation.
    expect(basisClaims()[0].where).toMatchObject({
      countedQuantity: null,
      expectedQuantity: 8,
    });
  });

  it('PIN 5c: a NO-QUANTITY line is guarded on both quantities still being absent', async () => {
    lineClaims();

    await post({ lines: [write({ qtySource: 'none', qty: 0 })] });

    expect(basisClaims()[0].where).toMatchObject({
      countedQuantity: null,
      expectedQuantity: null,
    });
  });

  it('PIN 3: verify-only lines are claimed ASCENDING, interleaved with the writes (one order)', async () => {
    lineClaims();

    await post({
      lines: [
        write({ id: 30 }),
        verify({ id: 20, ifUnitCostCents: 100 }),
        write({ id: 10, unitCostCents: 300, ifUnitCostCents: 200 }),
        verify({ id: 40, ifUnitCostCents: null }),
      ],
    });

    // ONE pass over the whole basis in the house lock order — not "the writes,
    // then the checks", which would be two lock orders in one transaction.
    expect(basisClaims().map((args: any) => args.where.id)).toEqual([10, 20, 30, 40]);
  });

  it('a verify-only line is CLAIMED on its full basis and writes NOTHING', async () => {
    lineClaims();

    await post({
      lines: [write({ id: 11 }), verify({ id: 12, qty: 4, ifUnitCostCents: 200 })],
    });

    const check = basisClaims().find((args: any) => args.where.id === 12);
    expect(check.where).toEqual({
      id: 12,
      shipmentId: SHIPMENT_ID,
      status: 'RECEIVED',
      unitCostCents: 200,
      countedQuantity: 4,
    });
    // The house no-op claim idiom: the claim IS the verification and the lock.
    expect(check.data).toEqual({ status: 'RECEIVED' });
    expect(costWrites().map((args: any) => args.where.id)).toEqual([11]);
  });

  it('never audits a verify-only line — nothing about it changed', async () => {
    lineClaims();

    await post({
      lines: [verify({ id: 10, ifUnitCostCents: 100 }), write({ id: 11 })],
    });

    expect(mockRecordChange).toHaveBeenCalledTimes(1);
    expect(mockRecordChange.mock.calls[0][1]).toMatchObject({ entityId: 11 });
  });

  it('PIN 2 — THE FD4-1 SCENARIO: the EXCLUDED line moved, so the bill refuses', async () => {
    // A carried all the freight because B's base was 0 at freeze time. B was
    // priced to 100c since, so the true split is now 50/50 — and B is the line
    // the panel had no write for. Verify-only or not, it is basis.
    lineClaims({ drifted: [12] });

    const resp = await post({
      lines: [write({ id: 11, unitCostCents: 700, ifUnitCostCents: 500 }), verify({ id: 12 })],
    });

    expect(resp.status).toBe(409);
    expect((await resp.json()).code).toBe('BASIS_DRIFT');
    // Line 11's write really ran; the throw is what unwinds it.
    expect(txRejected).toBe(true);
    expect(costWrites().map((args: any) => args.where.id)).toEqual([11]);
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
  });

  it('PIN 1: a RECOUNT under a write line refuses — old per-unit costs never land on new units', async () => {
    // The quantity precondition is the only thing standing between a bill
    // computed over 10 units and a row that now holds 40.
    lineClaims({ drifted: [11] });

    const resp = await post({ lines: [write({ id: 11, qtySource: 'counted', qty: 10 })] });

    expect(resp.status).toBe(409);
    const json = await resp.json();
    expect(json.code).toBe('BASIS_DRIFT');
    expect(json.error).toMatch(/quantity/i);
    expect(txRejected).toBe(true);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('PIN 4: a WITHHELD line travels as basis, and its drift refuses too', async () => {
    // W1S-3 holds an inexact split back, and W1S-3's "Accept writes the rest"
    // rests on the withheld line's own base and quantity. Stale there is stale.
    lineClaims({ drifted: [12] });

    const resp = await post({
      lines: [write({ id: 11 }), verify({ id: 12, qty: 3, ifUnitCostCents: 100 })],
    });

    expect(resp.status).toBe(409);
    expect((await resp.json()).code).toBe('BASIS_DRIFT');
    expect(txRejected).toBe(true);
  });

  it('a verify-only line that LEFT the shipment is a state CONFLICT, not basis drift', async () => {
    lineClaims({ departed: [12] });

    const resp = await post({ lines: [write({ id: 11 }), verify({ id: 12 })] });

    expect(resp.status).toBe(409);
    expect((await resp.json()).code).toBe('CONFLICT');
  });
});

// ---------------------------------------------------------------------------
// 3. FD5-1 — THE SUBMITTED SET *IS* THE CURRENT RECEIVED MEMBERSHIP
//
// Round 6 proved every line the client sent. It never proved that those lines
// were ALL of them, and a freight split is a statement about the whole receipt:
//
//   freeze a bill with A alone (1 x 100c, 100c freight -> A = 200c); line C
//   links to the shipment before Accept; the payload still carries only A; the
//   server iterates only what it was given, so A commits at 200c while the
//   current basis says 150c/150c. Nothing drifted. Nothing was mis-sent. The
//   request simply described a shipment that no longer exists, and every check
//   in it passed.
//
// The same hole answers to any stale client that omits a line that IS a current
// member. So the settle route's FD2-1 proof comes here: with the per-line claims
// held, lock the header (no status gate — bills are legal on CLOSED shipments
// per the stranded-line amendment) and take ONE ordered locking read of the
// current RECEIVED ids. The submitted ids must EQUAL them, element-wise.
// ---------------------------------------------------------------------------

describe('POST /api/inbound-shipments/[id]/costs — the membership proof (FD5-1)', () => {
  describe('the two locking reads', () => {
    it('locks the header with NO status gate, by bound id', async () => {
      lineClaims();

      const resp = await post({ lines: [write({ id: 11 })] });

      expect(resp.status).toBe(200);
      expect(rawHeaderReads()).toHaveLength(1);
      const statement = rawHeaderReads()[0];
      expect(statement.sql).toMatch(/FROM\s+inbound_shipments/i);
      expect(statement.sql).toMatch(/FOR UPDATE/i);
      expect(statement.values).toEqual([SHIPMENT_ID]);
      // THE STRANDED-LINE AMENDMENT, structurally: closing a receipt ends
      // RECEIVING, not stocking, and a stranded line's graduation still reads
      // this cost. A status in this WHERE would make a CLOSED shipment's bill
      // unwritable — which is the amendment, reversed.
      expect(statement.sql).not.toMatch(/status/i);
    });

    it('reads the CURRENT RECEIVED ids of this shipment, ordered, FOR UPDATE', async () => {
      lineClaims();

      await post({ lines: [write({ id: 11 })] });

      expect(rawMembershipReads()).toHaveLength(1);
      const statement = rawMembershipReads()[0];
      expect(statement.sql).toMatch(/FROM\s+staging_items/i);
      expect(statement.sql).toMatch(/ORDER BY id/i);
      expect(statement.sql).toMatch(/FOR UPDATE/i);
      // Both halves BOUND, never interpolated — including the status, which is
      // the enum value the column actually stores.
      expect(statement.values).toEqual([SHIPMENT_ID, 'RECEIVED']);
    });

    it('takes them in the house order: the LINES, then the header, then the membership', async () => {
      lineClaims();

      await post({ lines: [write({ id: 11 }), write({ id: 12, ifUnitCostCents: 200 })] });

      // item -> header, the same order the count endpoint, graduation and the
      // settle paths take — so this route cannot be half of an ABBA.
      const lastClaim = Math.max(...tx.stagingItem.updateMany.mock.invocationCallOrder);
      expect(rawOrder(/inbound_shipments/i)).toBeGreaterThan(lastClaim);
      // ...and the membership read runs with that header HELD.
      expect(rawOrder(/staging_items/i)).toBeGreaterThan(rawOrder(/inbound_shipments/i));
    });

    it('a per-line refusal never reaches either of them', async () => {
      lineClaims({ drifted: [11] });

      const resp = await post({ lines: [write({ id: 11 })] });

      expect(resp.status).toBe(409);
      expect((await resp.json()).code).toBe('BASIS_DRIFT');
      // The claimed-line diagnosis still NAMES its line; the membership proof is
      // the check that comes after, not the one that replaces it.
      expect(rawStatements()).toHaveLength(0);
    });
  });

  describe('the proof itself', () => {
    it('PIN 1 — THE FD5-1 SCENARIO: a line that JOINED after the freeze refuses the bill', async () => {
      lineClaims();
      // The bill was frozen on A alone and is arithmetically complete for it:
      // 100c of freight, all of it onto A. C linked while the operator typed.
      membershipIs([11, 13]);

      const resp = await post({
        lines: [write({ id: 11, qty: 1, ifUnitCostCents: 100, unitCostCents: 200 })],
      });

      expect(resp.status).toBe(409);
      const json = await resp.json();
      expect(json.code).toBe('BASIS_DRIFT');
      expect(json.error).toMatch(/joined|left/i);
      // A's write really ran — every precondition on it passed — and the throw
      // is what unwinds it. 200c never lands when the truth is 150c/150c.
      expect(costWrites().map((args: any) => args.where.id)).toEqual([11]);
      expect(txRejected).toBe(true);
      expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
    });

    it('PIN 2: a STALE client omitting a current RECEIVED line is refused on the same terms', async () => {
      // Same defect wearing different clothes: nobody has to link anything if
      // the client was already holding a membership one line out of date.
      lineClaims();
      membershipIs([11, 12]);

      const resp = await post({ lines: [write({ id: 11 })] });

      expect(resp.status).toBe(409);
      expect((await resp.json()).code).toBe('BASIS_DRIFT');
      // The audit ran too, and rolls back with the write it belongs to (D4).
      expect(txRejected).toBe(true);
      expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
    });

    it('compares ELEMENT-WISE, not by size: one line out and one in has the same count', async () => {
      lineClaims();
      membershipIs([11, 13]);

      const resp = await post({
        lines: [write({ id: 11 }), write({ id: 12, ifUnitCostCents: 200 })],
      });

      expect(resp.status).toBe(409);
      expect((await resp.json()).code).toBe('BASIS_DRIFT');
    });

    it('says what happened in the vocabulary of the operator, not of the schema', async () => {
      lineClaims();
      membershipIs([11, 13]);

      const resp = await post({ lines: [write({ id: 11 })] });

      const json = await resp.json();
      expect(json.error).toMatch(/joined|left/i);
      expect(json.error).toMatch(/bill/i);
    });

    it('passes a bill whose lines ARE the whole current membership', async () => {
      lineClaims();
      membershipIs([11, 12]);

      const resp = await post({
        lines: [write({ id: 12, ifUnitCostCents: 200 }), write({ id: 11 })],
      });

      expect(resp.status).toBe(200);
      expect(txRejected).toBe(false);
    });

    it('counts VERIFY-ONLY lines as membership — they are in the bill, just not written', async () => {
      lineClaims();
      membershipIs([11, 12]);

      const resp = await post({ lines: [write({ id: 11 }), verify({ id: 12 })] });

      expect(resp.status).toBe(200);
    });
  });

  describe('the CLOSED shipment keeps its bill (the stranded-line amendment)', () => {
    it('PIN 3: a bill against a CLOSED shipment still writes', async () => {
      lineClaims();
      membershipIs([11]);
      primeDetailRead();
      db.inboundShipment.findUnique.mockResolvedValue(shipmentRow({ status: 'CLOSED' }));

      const resp = await post({ lines: [write({ id: 11 })] });

      expect(resp.status).toBe(200);
      expect(txRejected).toBe(false);
      expect(costWrites()).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. FD3-1 — a refusal on ANY line rolls back EVERY line
// ---------------------------------------------------------------------------

describe('POST /api/inbound-shipments/[id]/costs — all or nothing (FD3-1)', () => {
  it('THE FD3-1 SCENARIO: line A lands, line B drifts, and A rolls back with it', async () => {
    // Line 12's cost moved under the bill; line 11's write already ran.
    lineClaims({ drifted: [12] });

    const resp = await post({
      lines: [write({ id: 11 }), write({ id: 12, unitCostCents: 240, ifUnitCostCents: 200 })],
    });

    expect(resp.status).toBe(409);
    const json = await resp.json();
    expect(json.code).toBe('BASIS_DRIFT');
    // THE ROLLBACK: the refusal is a THROW out of the transaction callback, so
    // line 11's write — which really did run — never commits. A returned refusal
    // would have COMMITTED it, which is the whole of FD3-1.
    expect(txRejected).toBe(true);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // Line 11's write happened INSIDE that transaction and nowhere else; line
    // 12's was attempted and matched nothing, which is the refusal.
    expect(costWrites().map((args: any) => args.where.id)).toEqual([11, 12]);
    expect(basisClaims().map((args: any) => args.where.id)).toEqual([11, 12]);
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
  });

  it('names the line whose basis drifted, and what can have moved', async () => {
    lineClaims({ drifted: [12] });

    const resp = await post({
      lines: [write({ id: 11 }), write({ id: 12, unitCostCents: 240, ifUnitCostCents: 200 })],
    });

    const json = await resp.json();
    expect(json.error).toMatch(/12/);
    expect(json.error).toMatch(/cost/i);
    expect(json.error).toMatch(/quantity/i);
  });

  it('a line that LEFT the shipment mid-bill refuses as a state CONFLICT', async () => {
    // The no-op re-claim pins shipmentId too, so an unlinked line misses BOTH
    // claims: it is not priced while it sits outside the receipt.
    lineClaims({ departed: [12] });

    const resp = await post({
      lines: [write({ id: 11 }), write({ id: 12, unitCostCents: 240, ifUnitCostCents: 200 })],
    });

    expect(resp.status).toBe(409);
    const json = await resp.json();
    expect(json.code).toBe('CONFLICT');
    expect(json.error).toMatch(/12/);
    expect(txRejected).toBe(true);
  });

  it('a GRADUATED line is a state CONFLICT, never BASIS_DRIFT', async () => {
    lineClaims({ departed: [11] });

    const resp = await post({ lines: [write({ id: 11 })] });

    expect(resp.status).toBe(409);
    expect((await resp.json()).code).toBe('CONFLICT');
  });

  it('the disambiguating re-claim writes NOTHING new and pins the shipment', async () => {
    lineClaims({ drifted: [11] });

    await post({ lines: [write({ id: 11 })] });

    const reclaim = reclaims()[0];
    expect(reclaim.where).toEqual({ id: 11, shipmentId: SHIPMENT_ID, status: 'RECEIVED' });
    expect(reclaim.data).toEqual({ status: 'RECEIVED' });
  });

  it('a refusal on the FIRST line never reaches the second (nothing is written after it)', async () => {
    lineClaims({ drifted: [11] });

    await post({
      lines: [write({ id: 11 }), write({ id: 12, unitCostCents: 240, ifUnitCostCents: 200 })],
    });

    expect(basisClaims().map((args: any) => args.where.id)).toEqual([11]);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('a bill aimed at ANOTHER shipment writes nothing (the WHERE pins the route id)', async () => {
    lineClaims();

    await post({ lines: [write({ id: 11 })] }, OTHER_SHIPMENT);

    expect(costWrites()[0].where.shipmentId).toBe(OTHER_SHIPMENT);
  });
});

// ---------------------------------------------------------------------------
// 5. The request contract
// ---------------------------------------------------------------------------

describe('POST /api/inbound-shipments/[id]/costs — the request', () => {
  it('400s an EMPTY bill — a request that writes nothing is a client bug', async () => {
    const resp = await post({ lines: [] });

    expect(resp.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('PIN 6: 400s a bill of VERIFY-ONLY lines — a bill that writes nothing is not a bill', async () => {
    // The panel's own gate (QA-12) already refuses to send this; the server
    // keeps the promise on its own terms rather than spending a transaction's
    // row locks verifying a basis nobody is going to use.
    const resp = await post({ lines: [verify({ id: 11 }), verify({ id: 12 })] });

    expect(resp.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('400s a DUPLICATE line id — the same line twice has no single answer', async () => {
    const resp = await post({
      lines: [write({ id: 11 }), write({ id: 11, unitCostCents: 700, ifUnitCostCents: 600 })],
    });

    expect(resp.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('400s a line missing its precondition or its frozen quantity', async () => {
    const noPrecondition = { ...write() } as Record<string, unknown>;
    delete noPrecondition.ifUnitCostCents;
    expect((await post({ lines: [noPrecondition] })).status).toBe(400);

    const noQty = { ...write() } as Record<string, unknown>;
    delete noQty.qty;
    expect((await post({ lines: [noQty] })).status).toBe(400);

    const noSource = { ...write() } as Record<string, unknown>;
    delete noSource.qtySource;
    expect((await post({ lines: [noSource] })).status).toBe(400);

    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('400s an unknown qtySource — the WHERE is built from that word', async () => {
    const resp = await post({ lines: [write({ qtySource: 'guessed' })] });

    expect(resp.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('400s a fractional or negative cost (cents are whole, and never negative)', async () => {
    expect((await post({ lines: [write({ unitCostCents: 6.5 })] })).status).toBe(400);
    expect((await post({ lines: [write({ unitCostCents: -1 })] })).status).toBe(400);
    expect((await post({ lines: [write({ ifUnitCostCents: 1.5 })] })).status).toBe(400);
  });

  it('PIN 5: 400s a quantity past the cap — a pathological value misses at the schema', async () => {
    // Not a business rule: an unbounded integer reaches MySQL as an out-of-range
    // INT and errors at the DRIVER, which is a 500 wearing a 400's clothes. The
    // cap matches the cents cap's magnitude.
    const resp = await post({ lines: [write({ qty: 100_000_001 })] });

    expect(resp.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('400s a NULL cost — un-pricing a line is the manual save\'s job, not a bill\'s', async () => {
    const resp = await post({ lines: [write({ unitCostCents: null })] });

    expect(resp.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. The guards every mutating receiving route carries
// ---------------------------------------------------------------------------

describe('POST /api/inbound-shipments/[id]/costs — guards', () => {
  it('403s an invalid CSRF token (no write, no audit)', async () => {
    mockValidateCSRF.mockResolvedValue(false);

    const resp = await post({ lines: [write({ id: 11 })] });

    expect(resp.status).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('refuses an unapproved caller before anything else happens', async () => {
    const { AppError } = jest.requireActual('@/lib/error-handling');
    (requireApproved as jest.Mock).mockRejectedValue(
      new AppError('Account pending approval', 'FORBIDDEN', 403),
    );

    const resp = await post({ lines: [write({ id: 11 })] });

    expect(resp.status).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('rate-limits per user, under its own key', async () => {
    lineClaims();

    await post({ lines: [write({ id: 11 })] });

    expect(mockEnforceRateLimit).toHaveBeenCalledWith(expect.anything(), 'inbound-shipment-costs:POST', {
      identifier: APPROVED_USER.id,
    });
  });
});

// ---------------------------------------------------------------------------
// 7. D9 — a new mutating route joins the change-tracking gate, unexempted
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
