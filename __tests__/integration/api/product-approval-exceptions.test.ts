// @jest-environment node
/**
 * W1-3b — RESOLUTION of `pending-with-stock` (contract pack REV-3 T1 LIFECYCLE).
 *
 * The register row raised at graduation says "units are on hand for a product
 * nobody has approved". Exactly two acts can make that statement false, and the
 * pack names both: the admin APPROVES the product (it is real now) or DECLINES
 * it (declineProduct reverses the stock, so there are no units left to worry
 * about). Both resolutions are written INSIDE the transaction that settles the
 * product, so the register can never disagree with the catalog.
 *
 * `resolveException` is idempotent and a no-op for a key nobody raised, which is
 * what lets both routes fire unconditionally — no route has to ask first, and
 * approving a product that was created by an admin (and therefore never raised a
 * row) writes nothing.
 *
 * The writer is real here; the delegate is the mocked tx. What the writer itself
 * does with lifecycle edge cases is pinned in __tests__/unit/lib/exceptions/.
 */

import { NextRequest } from 'next/server';

jest.mock('@/lib/api-utils', () => {
  const actual = jest.requireActual('@/lib/api-utils');
  return { __esModule: true, ...actual, requireAdmin: jest.fn() };
});

jest.mock('@/lib/prisma', () => {
  const tx: any = {
    product: { update: jest.fn() },
    inventoryException: {
      findUnique: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
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
    default: { ...tx, $transaction: jest.fn(async (fn: any) => fn(tx)) },
  };
});

jest.mock('@/lib/csrf', () => ({ validateCSRFToken: jest.fn(async () => true) }));

jest.mock('@/lib/rateLimit', () => ({
  __esModule: true,
  RateLimitError: jest.requireActual('@/lib/rateLimit').RateLimitError,
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((resp: any) => resp),
}));

jest.mock('@/lib/change-tracking', () => ({
  __esModule: true,
  recordChange: jest.fn(async () => undefined),
  newBatchId: jest.fn(() => 'DECLINE-BATCH'),
}));

jest.mock('@/lib/products/decline', () => ({ declineProduct: jest.fn() }));

import { POST as approvePOST } from '@/app/api/admin/products/[id]/approve/route';
import { POST as declinePOST } from '@/app/api/admin/products/[id]/decline/route';
import { requireAdmin } from '@/lib/api-utils';
import { declineProduct } from '@/lib/products/decline';
import { validateCSRFToken } from '@/lib/csrf';
import prisma from '@/lib/prisma';
import { AppError } from '@/lib/error-handling';

const db: any = prisma as any;
const mockDecline = declineProduct as jest.Mock;
const mockValidateCSRF = validateCSRFToken as jest.Mock;

const ADMIN = { id: 3, isAdmin: true, isApproved: true };
const KEY = 'pending-with-stock:101';

/** An open register row as the DB would hand it back. */
function openRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    key: KEY,
    kind: 'pending-with-stock',
    subject: { productId: 101, stagingItemId: 5, units: 46 },
    firstSeenAt: new Date('2026-08-01T00:00:00Z'),
    lastSeenAt: new Date('2026-08-01T00:00:00Z'),
    resolvedAt: null,
    resolvedBy: null,
    note: null,
    ...overrides,
  };
}

/** What the writer's LOCKING read finds for this key. */
function setExistingRow(row: Record<string, unknown> | null) {
  db.inventoryException.findUnique.mockResolvedValue(row);
}

function mkReq(path: string) {
  return new NextRequest(`http://t/api/admin/products/101/${path}`, {
    method: 'POST',
    headers: { 'x-csrf-token': 'x' },
  });
}

/** The decline tx the route's `record` callback writes through. */
let declineTx: any;

beforeEach(() => {
  jest.clearAllMocks();
  mockValidateCSRF.mockResolvedValue(true);
  (requireAdmin as jest.Mock).mockResolvedValue({ user: ADMIN });
  db.$transaction = jest.fn(async (fn: any) => fn(db));
  db.product.update.mockResolvedValue({ id: 101, approvalStatus: 'APPROVED' });
  db.inventoryException.findUnique.mockResolvedValue(null);
  db.inventoryException.update.mockImplementation(async ({ data }: any) => ({ ...openRow(), ...data }));

  declineTx = db;
  mockDecline.mockImplementation(async (_id: number, _admin: any, opts: any) => {
    const result = { reversed: true, alreadyDeclined: false };
    if (opts?.record) await opts.record(declineTx, result);
    return result;
  });
});

describe('POST /api/admin/products/[id]/approve — resolves pending-with-stock', () => {
  it('resolves the product key, naming the admin who adjudicated it', async () => {
    db.inventoryException.findUnique.mockResolvedValue(openRow());

    const res = await approvePOST(mkReq('approve'), { params: { id: '101' } });

    expect(res.status).toBe(200);
    // PK-11: the row is read UNDER ITS OWN LOCK, so the approval and a
    // concurrent booking's raise serialize on the register row itself.
    const read = db.$queryRaw.mock.calls[0][0];
    expect(String(read.sql)).toMatch(/FROM inventory_exceptions WHERE `key` = \? FOR UPDATE$/);
    expect(read.values).toEqual([KEY]);
    const call = db.inventoryException.update.mock.calls[0][0];
    expect(call.where).toEqual({ key: KEY });
    expect(call.data.resolvedAt).toBeInstanceOf(Date);
    expect(call.data.resolvedBy).toBe(3);
  });

  it('resolves inside the SAME transaction as the approval', async () => {
    db.inventoryException.findUnique.mockResolvedValue(openRow());

    await approvePOST(mkReq('approve'), { params: { id: '101' } });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // Both writes went through the tx client the callback was handed.
    expect(db.product.update).toHaveBeenCalled();
    expect(db.inventoryException.update).toHaveBeenCalled();
  });

  it('a product that never raised a row approves cleanly (silent no-op)', async () => {
    db.inventoryException.findUnique.mockResolvedValue(null);

    const res = await approvePOST(mkReq('approve'), { params: { id: '101' } });

    expect(res.status).toBe(200);
    expect(db.inventoryException.update).not.toHaveBeenCalled();
  });

  it('an already-resolved row is left untouched (the first resolution is the truth)', async () => {
    db.inventoryException.findUnique.mockResolvedValue(
      openRow({ resolvedAt: new Date('2026-08-02T00:00:00Z'), resolvedBy: 9 }),
    );

    await approvePOST(mkReq('approve'), { params: { id: '101' } });

    expect(db.inventoryException.update).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/products/[id]/approve — the deadlock retry (pack C2b.3, OCp2-4)', () => {
  // The approval's resolve now takes a LOCKING read on the register row, so this
  // transaction can genuinely deadlock against a booking that holds that row and
  // is waiting on the product this approval holds. Decline has always retried
  // (declineProduct's own wrapper); approve had nothing, so the loser's 500 was
  // the user's answer. Same envelope, same rule: the stamp is minted OUTSIDE.
  it('is RE-RUN after a P2034 rollback and succeeds on the second attempt', async () => {
    setExistingRow(openRow());
    let attempts = 0;
    db.$transaction = jest.fn(async (fn: any) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('write conflict'), { code: 'P2034' });
      return fn(db);
    });

    const res = await approvePOST(mkReq('approve'), { params: { id: '101' } });

    expect(res.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it('keeps the SAME reviewedAt across the retry — the instant of the review, not of the retry', async () => {
    setExistingRow(openRow());
    let attempts = 0;
    db.$transaction = jest.fn(async (fn: any) => {
      attempts += 1;
      if (attempts === 1) {
        // The first attempt runs far enough to stamp, then rolls back.
        await fn(db).catch(() => undefined);
        throw Object.assign(new Error('deadlock'), { code: 'P2034' });
      }
      return fn(db);
    });

    await approvePOST(mkReq('approve'), { params: { id: '101' } });

    const stamps = db.product.update.mock.calls.map((c: any) => c[0].data.reviewedAt);
    expect(stamps).toHaveLength(2);
    expect(stamps[0]).toBe(stamps[1]);
  });

  it('does NOT retry an ordinary failure — it is an ANSWER, once', async () => {
    setExistingRow(openRow());
    const boom = new AppError('nope', 'CONFLICT', 409);
    db.$transaction = jest.fn(async () => {
      throw boom;
    });

    const res = await approvePOST(mkReq('approve'), { params: { id: '101' } });

    expect(res.status).toBe(409);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/admin/products/[id]/decline — resolves pending-with-stock', () => {
  it('resolves the product key inside declineProduct\'s transaction', async () => {
    db.inventoryException.findUnique.mockResolvedValue(openRow());

    const res = await declinePOST(mkReq('decline'), { params: { id: '101' } });

    expect(res.status).toBe(200);
    const call = db.inventoryException.update.mock.calls[0][0];
    expect(call.where).toEqual({ key: KEY });
    expect(call.data.resolvedAt).toBeInstanceOf(Date);
    expect(call.data.resolvedBy).toBe(3);
  });

  it('the resolution rides the tx the reversal was written through', async () => {
    declineTx = {
      inventoryException: {
        findUnique: jest.fn(async () => openRow()),
        update: jest.fn(async ({ data }: any) => ({ ...openRow(), ...data })),
      },
      // PK-11: this stand-in tx answers the writer's LOCKING read.
      $queryRaw: jest.fn(async () => [openRow()]),
    };

    await declinePOST(mkReq('decline'), { params: { id: '101' } });

    // The route wrote through the callback's tx, NOT through a fresh client.
    expect(declineTx.inventoryException.update).toHaveBeenCalledTimes(1);
    expect(db.inventoryException.update).not.toHaveBeenCalled();
  });

  it('an already-declined (no-op) decline still resolves — resolution is idempotent', async () => {
    db.inventoryException.findUnique.mockResolvedValue(openRow());
    mockDecline.mockImplementation(async (_id: number, _admin: any, opts: any) => {
      const result = { reversed: false, alreadyDeclined: true };
      if (opts?.record) await opts.record(declineTx, result);
      return result;
    });

    const res = await declinePOST(mkReq('decline'), { params: { id: '101' } });

    expect(res.status).toBe(200);
    expect(db.inventoryException.update).toHaveBeenCalledTimes(1);
  });

  it('a product that never raised a row declines cleanly', async () => {
    db.inventoryException.findUnique.mockResolvedValue(null);

    const res = await declinePOST(mkReq('decline'), { params: { id: '101' } });

    expect(res.status).toBe(200);
    expect(db.inventoryException.update).not.toHaveBeenCalled();
  });
});
