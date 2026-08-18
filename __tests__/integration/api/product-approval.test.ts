// @jest-environment node
import { NextRequest } from 'next/server';

// Keep the REAL apiHandler (so AppError -> its status gets mapped centrally), but
// stub the auth guards.
jest.mock('@/lib/api-utils', () => {
  const actual = jest.requireActual('@/lib/api-utils');
  return {
    __esModule: true,
    ...actual,
    requireAdmin: jest.fn(),
  };
});

jest.mock('@/lib/prisma', () => {
  const tx: any = {
    product: {
      update: jest.fn(),
    },
    // W1-3b: approve/decline resolve `pending-with-stock` on this same tx. The
    // delegate is stubbed so the routes RUN; what they resolve is owned by
    // __tests__/integration/api/product-approval-exceptions.test.ts.
    inventoryException: {
      findUnique: jest.fn(async () => null),
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

// Routes record through @/lib/change-tracking now (recordChange in a tx) instead
// of the legacy auditService.log.
jest.mock('@/lib/change-tracking', () => ({
  __esModule: true,
  recordChange: jest.fn(async () => undefined),
  newBatchId: jest.fn(() => 'test-batch-id'),
}));

// The decline reversal is unit-tested separately; here we mock it so the route
// test focuses on the HTTP layer (auth, CSRF, lib invocation, status mapping).
jest.mock('@/lib/products/decline', () => ({
  declineProduct: jest.fn(),
}));

import { POST as approvePOST } from '@/app/api/admin/products/[id]/approve/route';
import { POST as declinePOST } from '@/app/api/admin/products/[id]/decline/route';
import { requireAdmin } from '@/lib/api-utils';
import { declineProduct } from '@/lib/products/decline';
import { validateCSRFToken } from '@/lib/csrf';
import { recordChange } from '@/lib/change-tracking';
import prisma from '@/lib/prisma';

const db: any = prisma as any;
const mockValidateCSRF = validateCSRFToken as jest.Mock;
const mockRecordChange = recordChange as jest.Mock;

const ADMIN_USER = { id: 9, isAdmin: true, isApproved: true };

function setAdmin(user: any = ADMIN_USER) {
  (requireAdmin as jest.Mock).mockResolvedValue({ user });
}

function mkReq(url: string, method: string, body?: any) {
  return new NextRequest(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockValidateCSRF.mockResolvedValue(true);
});

describe('POST /api/admin/products/[id]/approve', () => {
  it('flips approvalStatus to APPROVED and records the reviewer (200)', async () => {
    setAdmin();
    db.product.update.mockResolvedValue({ id: 5, approvalStatus: 'APPROVED' });

    const resp = await approvePOST(
      mkReq('http://t/api/admin/products/5/approve', 'POST'),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toEqual({ id: 5, approvalStatus: 'APPROVED' });

    const updateArgs = db.product.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 5 });
    expect(updateArgs.data.approvalStatus).toBe('APPROVED');
    expect(updateArgs.data.reviewedBy).toBe(ADMIN_USER.id);
    expect(updateArgs.data.reviewedAt).toBeInstanceOf(Date);

    expect(mockRecordChange).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actionType: 'PRODUCT_APPROVE',
        entityId: 5,
        actor: { userId: ADMIN_USER.id },
      })
    );
  });

  it('returns 403 for a non-admin (requireAdmin throws)', async () => {
    const { AppError } = jest.requireActual('@/lib/error-handling');
    (requireAdmin as jest.Mock).mockRejectedValue(
      new AppError('Admin access required', 'FORBIDDEN', 403)
    );

    const resp = await approvePOST(
      mkReq('http://t/api/admin/products/5/approve', 'POST'),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(403);
    expect(db.product.update).not.toHaveBeenCalled();
  });

  it('returns 403 when CSRF token is invalid (no DB write)', async () => {
    setAdmin();
    mockValidateCSRF.mockResolvedValue(false);

    const resp = await approvePOST(
      mkReq('http://t/api/admin/products/5/approve', 'POST'),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(403);
    const body = await resp.json();
    expect(body.error).toMatch(/CSRF/i);
    expect(db.product.update).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/products/[id]/decline', () => {
  it('calls declineProduct with the id + admin and returns its result (200)', async () => {
    setAdmin();
    (declineProduct as jest.Mock).mockResolvedValue({ reversed: true, alreadyDeclined: false });

    const resp = await declinePOST(
      mkReq('http://t/api/admin/products/7/decline', 'POST'),
      { params: { id: '7' } }
    );

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toEqual({ reversed: true, alreadyDeclined: false });

    // Phase C seam fix: the route hands declineProduct an in-tx record callback +
    // a shared batchId instead of recording in a separate tx of its own.
    expect(declineProduct as jest.Mock).toHaveBeenCalledTimes(1);
    const [pid, admin, opts] = (declineProduct as jest.Mock).mock.calls[0];
    expect(pid).toBe(7);
    expect(admin).toEqual({ id: ADMIN_USER.id });
    expect(typeof opts.record).toBe('function');
    expect(opts.batchId).toBe('test-batch-id');

    // declineProduct is mocked, so the callback has not fired yet.
    expect(mockRecordChange).not.toHaveBeenCalled();
    // Driving the callback (as declineProduct's tx would) records PRODUCT_DECLINE
    // with the DeclineResult ctx + the shared batchId. W1-3b: the same callback
    // also resolves `pending-with-stock`, so the stand-in tx carries that
    // delegate — the resolution itself is pinned in
    // __tests__/integration/api/product-approval-exceptions.test.ts.
    const declineTx: any = {
      inventoryException: { findUnique: jest.fn(async () => null), update: jest.fn() },
    };
    // PK-11: the writer reads FOR UPDATE now; the stand-in answers from the same
    // stub (an absent key, so the resolution is the documented no-op).
    declineTx.$queryRaw = jest.fn(async () => []);
    await opts.record(declineTx, { reversed: true, alreadyDeclined: false });
    expect(mockRecordChange).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actionType: 'PRODUCT_DECLINE',
        entityId: 7,
        actor: { userId: ADMIN_USER.id },
        batchId: 'test-batch-id',
        details: { reversed: true, alreadyDeclined: false },
      })
    );
  });

  it('returns the idempotent lib result when already declined (200)', async () => {
    setAdmin();
    (declineProduct as jest.Mock).mockResolvedValue({ reversed: false, alreadyDeclined: true });

    const resp = await declinePOST(
      mkReq('http://t/api/admin/products/7/decline', 'POST'),
      { params: { id: '7' } }
    );

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toEqual({ reversed: false, alreadyDeclined: true });
    const [pid, admin, opts] = (declineProduct as jest.Mock).mock.calls[0];
    expect(pid).toBe(7);
    expect(admin).toEqual({ id: ADMIN_USER.id });
    expect(typeof opts.record).toBe('function');
  });

  it('returns 403 for a non-admin (requireAdmin throws, lib not called)', async () => {
    const { AppError } = jest.requireActual('@/lib/error-handling');
    (requireAdmin as jest.Mock).mockRejectedValue(
      new AppError('Admin access required', 'FORBIDDEN', 403)
    );

    const resp = await declinePOST(
      mkReq('http://t/api/admin/products/7/decline', 'POST'),
      { params: { id: '7' } }
    );

    expect(resp.status).toBe(403);
    expect(declineProduct).not.toHaveBeenCalled();
  });

  it('returns 403 when CSRF token is invalid (lib not called)', async () => {
    setAdmin();
    mockValidateCSRF.mockResolvedValue(false);

    const resp = await declinePOST(
      mkReq('http://t/api/admin/products/7/decline', 'POST'),
      { params: { id: '7' } }
    );

    expect(resp.status).toBe(403);
    const body = await resp.json();
    expect(body.error).toMatch(/CSRF/i);
    expect(declineProduct).not.toHaveBeenCalled();
  });
});
