// @jest-environment node
/**
 * FD6-1 (W1-C fix round 8) — THE COUNT AND THE STAGING PATCH RIDE THE HOUSE
 * DEADLOCK RETRY TOO.
 *
 * Fix round 7 gave the freight bill (`POST /api/inbound-shipments/[id]/costs`) a
 * locking membership read: it holds this receipt's header and then asks for
 * lines it does NOT hold. Every other receiving writer is item-first — it holds
 * a LINE and then asks for that line's header. That is a genuine cycle, and
 * InnoDB breaks it by rolling back whichever transaction did the least work:
 * never the bill, which is claiming every line of a receipt. So the bill
 * returned its clean BASIS_DRIFT while the innocent count that collided with it
 * died with an unhandled 500 — a race it did not cause, reported as a crash.
 *
 * The fix is not a new lock order (there is nothing left to reorder — both sides
 * are already item-first at transaction scope). It is the house retry, on ALL of
 * the participants. What this file pins is that BOTH remaining writers now
 * survive a deadlock and that neither one retries anything else:
 *
 *   - a P2034 victim is re-run and succeeds on the second attempt (the CODE
 *     branch of lib/inventory's `withDeadlockRetry`);
 *   - the raw MySQL 1213 text is re-run too (its MESSAGE branch), because a
 *     deadlock does not always arrive wearing a Prisma code;
 *   - an ordinary refusal — the routes' own raced-claim 409 — is answered once
 *     and NOT retried. A 409 is an answer, not a race.
 *
 * `withDeadlockRetry` is deliberately NOT mocked here: the pin is that the real
 * helper recognises the real error shapes these routes will actually see.
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
  const tx: any = {
    stagingItem: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    inboundShipment: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    // The count route's exceptions register: stubbed so the route LOADS and runs.
    // What it writes is owned by staging-count-exceptions.test.ts.
    inventoryException: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    // Receiving/Labeling overhaul (pack C2b.3 / PK-11): the writer's read is now a
    // LOCKING `SELECT ... FOR UPDATE` rather than a `findUnique`. The stub answers
    // from the same `findUnique` mock these cases already configure, so the
    // register's row shape stays set up in exactly one place.
    $queryRaw: jest.fn(async () => {
      const row = await tx.inventoryException.findUnique({});
      return row ? [row] : [];
    }),
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

import { POST as countPOST } from '@/app/api/staging-items/[id]/count/route';
import { PATCH as stagingPATCH } from '@/app/api/staging-items/[id]/route';
import { requireApproved } from '@/lib/api-utils';
import { validateCSRFToken } from '@/lib/csrf';
import prisma from '@/lib/prisma';

const db: any = prisma as any;
const mockValidateCSRF = validateCSRFToken as jest.Mock;

const APPROVED_USER = { id: 7, isAdmin: false, isApproved: true };

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

/**
 * A deadlock wearing a PRISMA CODE and nothing else. The message deliberately
 * omits the word "deadlock" so this fixture can only be matched by
 * `DEADLOCK_CODES`, never by the message regex — the code branch, pinned alone.
 */
const prismaVictim = () =>
  Object.assign(new Error('Transaction failed due to a write conflict'), {
    code: 'P2034',
  });

/**
 * ...and a deadlock wearing only the MESSAGE: MySQL's own 1213 text, with no
 * code at all. Same helper, the other branch.
 */
const mysqlVictim = () =>
  new Error('Deadlock found when trying to get lock; try restarting transaction');

/**
 * A transaction that is chosen as the victim ONCE and then gets through.
 *
 * The first attempt RUNS the route's callback and then throws it all away —
 * which is what being an InnoDB victim is: the work happened and the rollback
 * unhappened it. Every attempt after runs the callback for real. So a passing
 * test here says something stronger than "the error was swallowed": the route
 * body executed TWICE, and the second execution is the one that answered.
 */
function victimOnce(error: unknown) {
  let attempts = 0;
  (db.$transaction as jest.Mock) = jest.fn(async (fn: any) => {
    attempts += 1;
    if (attempts === 1) {
      await fn(db);
      throw error;
    }
    return fn(db);
  });
}

function countReq(body: unknown, id = '5') {
  return new NextRequest(`http://t/api/staging-items/${id}/count`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
  });
}

function patchReq(body: unknown, id = '5') {
  return new NextRequest(`http://t/api/staging-items/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
  });
}

const count = (body: unknown) => countPOST(countReq(body), { params: { id: '5' } });
const patch = (body: unknown) => stagingPATCH(patchReq(body), { params: { id: '5' } });

beforeEach(() => {
  jest.clearAllMocks();
  mockValidateCSRF.mockResolvedValue(true);
  (requireApproved as jest.Mock).mockResolvedValue({ user: APPROVED_USER });
  (db.$transaction as jest.Mock) = jest.fn(async (fn: any) => fn(db));

  // The happy path for both routes: the line is RECEIVED, unlinked (no shipment
  // work to order), and every claim wins.
  db.stagingItem.findUnique.mockResolvedValue(itemRow());
  db.stagingItem.updateMany.mockResolvedValue({ count: 1 });
  db.stagingItem.update.mockResolvedValue(itemRow({ description: 'Relabelled' }));
  // A matching count resolves rather than raises; absent key = no-op.
  db.inventoryException.findUnique.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// POST /api/staging-items/[id]/count
// ---------------------------------------------------------------------------

describe('POST /api/staging-items/[id]/count — the deadlock retry (FD6-1)', () => {
  it('is RE-RUN after a P2034 rollback and succeeds on the second attempt', async () => {
    victimOnce(prismaVictim());

    const resp = await count({ countedQuantity: 10 });

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    // The retry is a WHOLE re-run: the before-image is read again and the claim
    // is re-issued from a fresh snapshot, never resumed mid-transaction.
    expect(db.stagingItem.findUnique).toHaveBeenCalledTimes(2);
    expect(db.stagingItem.updateMany).toHaveBeenCalledTimes(2);
    await expect(resp.json()).resolves.toMatchObject({
      id: 5,
      countedQuantity: 10,
      countedBy: 7,
    });
  });

  it('keeps the SAME countedAt across the retry — the instant of the count, not of the retry', async () => {
    victimOnce(prismaVictim());

    const resp = await count({ countedQuantity: 10 });
    const json = await resp.json();

    const stamps = db.stagingItem.updateMany.mock.calls.map(
      (c: any[]) => c[0].data.countedAt,
    );
    expect(stamps).toHaveLength(2);
    expect(stamps[1]).toEqual(stamps[0]);
    // ...and it is that same instant that the client is told about.
    expect(json.countedAt).toBe(stamps[0].toISOString());
  });

  it('is re-run for the raw MySQL 1213 shape too (no Prisma code at all)', async () => {
    victimOnce(mysqlVictim());

    const resp = await count({ countedQuantity: 10 });

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry an ordinary refusal — a raced claim is an ANSWER (409, once)', async () => {
    db.stagingItem.updateMany.mockResolvedValue({ count: 0 });

    const resp = await count({ countedQuantity: 10 });

    expect(resp.status).toBe(409);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/staging-items/[id]
// ---------------------------------------------------------------------------

describe('PATCH /api/staging-items/[id] — the deadlock retry (FD6-1)', () => {
  it('is RE-RUN after a P2034 rollback and succeeds on the second attempt', async () => {
    victimOnce(prismaVictim());

    const resp = await patch({ description: 'Relabelled' });

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    // `existing` is the transaction's FIRST read, so the re-run re-derives the
    // freeze verdict and the link classification from current rows — nothing
    // this route decides was read above the callback.
    expect(db.stagingItem.findUnique).toHaveBeenCalledTimes(2);
    await expect(resp.json()).resolves.toMatchObject({ description: 'Relabelled' });
  });

  it('is re-run for the raw MySQL 1213 shape too (no Prisma code at all)', async () => {
    victimOnce(mysqlVictim());

    const resp = await patch({ description: 'Relabelled' });

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry an ordinary refusal — the freeze 409 is an ANSWER (once)', async () => {
    db.stagingItem.findUnique.mockResolvedValue(itemRow({ status: 'GRADUATED' }));

    const resp = await patch({ expectedQuantity: 4 });

    expect(resp.status).toBe(409);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
});
