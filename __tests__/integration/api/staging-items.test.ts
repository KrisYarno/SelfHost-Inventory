// @jest-environment node
import { NextRequest } from 'next/server';

// Keep the REAL apiHandler (so ZodError -> 400 and AppError -> its status get
// mapped centrally, the way these routes depend on), but stub the auth guards.
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
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
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
  // Preserve the real RateLimitError class — the real apiHandler does
  // `error instanceof RateLimitError`, which throws if the export is undefined.
  RateLimitError: jest.requireActual('@/lib/rateLimit').RateLimitError,
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((resp: any) => resp),
}));

// change-tracking recordChange is stubbed (it touches next/headers + tx.auditLog);
// these route tests focus on the HTTP layer (auth, CSRF, validation, status mapping).
jest.mock('@/lib/change-tracking', () => ({
  __esModule: true,
  recordChange: jest.fn(async () => undefined),
  newBatchId: jest.fn(() => 'test-batch-id'),
}));

// The graduation transaction is unit-tested separately; here we mock it so the
// route tests focus on the HTTP layer (auth, CSRF, validation, status mapping).
jest.mock('@/lib/staging/graduate', () => ({
  graduateStagingItem: jest.fn(),
}));

import { GET as listGET, POST as createPOST } from '@/app/api/staging-items/route';
import { PATCH } from '@/app/api/staging-items/[id]/route';
import { POST as graduatePOST } from '@/app/api/staging-items/[id]/graduate/route';
import { POST as discardPOST } from '@/app/api/staging-items/[id]/discard/route';
import { requireApproved } from '@/lib/api-utils';
import { graduateStagingItem } from '@/lib/staging/graduate';
import { AppError } from '@/lib/error-handling';
import { validateCSRFToken } from '@/lib/csrf';
import { applyRateLimitHeaders } from '@/lib/rateLimit';
import prisma from '@/lib/prisma';

const db: any = prisma as any;
const mockValidateCSRF = validateCSRFToken as jest.Mock;
const mockApplyRateLimitHeaders = applyRateLimitHeaders as jest.Mock;

const APPROVED_USER = { id: 7, isAdmin: false, isApproved: true };

function setApprovedUser(user: any = APPROVED_USER) {
  (requireApproved as jest.Mock).mockResolvedValue({ user });
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
  mockApplyRateLimitHeaders.mockImplementation((r: any) => r);
  (db.$transaction as jest.Mock) = jest.fn(async (fn: any) => fn(db));
});

describe('POST /api/staging-items (create)', () => {
  it('creates a RECEIVED staging item for the current user (201)', async () => {
    setApprovedUser();
    db.stagingItem.create.mockResolvedValue({
      id: 42,
      description: 'Box of vials',
      locationId: 1,
      status: 'RECEIVED',
      receivedBy: APPROVED_USER.id,
    });

    const resp = await createPOST(
      mkReq('http://t/api/staging-items', 'POST', {
        description: 'Box of vials',
        locationId: 1,
      })
    );

    expect(resp.status).toBe(201);
    const body = await resp.json();
    expect(body.id).toBe(42);
    expect(body.status).toBe('RECEIVED');

    const createArgs = db.stagingItem.create.mock.calls[0][0];
    expect(createArgs.data.receivedBy).toBe(APPROVED_USER.id);
    expect(createArgs.data.status).toBe('RECEIVED');
    expect(createArgs.data.locationId).toBe(1);
  });

  it('returns 403 when CSRF token is invalid (no DB write)', async () => {
    setApprovedUser();
    mockValidateCSRF.mockResolvedValue(false);

    const resp = await createPOST(
      mkReq('http://t/api/staging-items', 'POST', {
        description: 'Box of vials',
        locationId: 1,
      })
    );

    expect(resp.status).toBe(403);
    const body = await resp.json();
    expect(body.error).toMatch(/CSRF/i);
    expect(db.stagingItem.create).not.toHaveBeenCalled();
  });

  it('returns 400 (Zod) when description is missing', async () => {
    setApprovedUser();
    const resp = await createPOST(
      mkReq('http://t/api/staging-items', 'POST', { locationId: 1 })
    );
    expect(resp.status).toBe(400);
    expect(db.stagingItem.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/staging-items (list)', () => {
  it('defaults to RECEIVED when no status is given', async () => {
    setApprovedUser();
    db.stagingItem.findMany.mockResolvedValue([{ id: 1, status: 'RECEIVED' }]);

    const resp = await listGET(mkReq('http://t/api/staging-items', 'GET'));

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.items).toHaveLength(1);
    expect(db.stagingItem.findMany.mock.calls[0][0].where.status).toBe('RECEIVED');
  });

  it('filters by the requested status', async () => {
    setApprovedUser();
    db.stagingItem.findMany.mockResolvedValue([{ id: 2, status: 'GRADUATED' }]);

    const resp = await listGET(
      mkReq('http://t/api/staging-items?status=GRADUATED', 'GET')
    );

    expect(resp.status).toBe(200);
    expect(db.stagingItem.findMany.mock.calls[0][0].where.status).toBe('GRADUATED');
  });

  it('falls back to RECEIVED for an unknown status value', async () => {
    setApprovedUser();
    db.stagingItem.findMany.mockResolvedValue([]);

    await listGET(mkReq('http://t/api/staging-items?status=BOGUS', 'GET'));

    expect(db.stagingItem.findMany.mock.calls[0][0].where.status).toBe('RECEIVED');
  });
});

describe('PATCH /api/staging-items/[id]', () => {
  // W1-2b (pack REV-3 T2): countedQuantity left this surface, so the
  // partial-update pin now rides expectedQuantity — same property (only the
  // provided keys are written), a field that is still PATCHable while RECEIVED.
  it('updates only the provided fields (200)', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue({ id: 5, status: 'RECEIVED', shipmentId: null });
    // W1S-1: a state-bearing field is written by a CONDITIONAL claim, so the
    // partial-update property is asserted on that claim rather than on `update`.
    db.stagingItem.updateMany.mockResolvedValue({ count: 1 });

    const resp = await PATCH(
      mkReq('http://t/api/staging-items/5', 'PATCH', { expectedQuantity: 12 }),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(200);
    const writeArgs = db.stagingItem.updateMany.mock.calls[0][0];
    expect(writeArgs.where).toEqual({ id: 5, status: 'RECEIVED' });
    expect(writeArgs.data).toEqual({ expectedQuantity: 12 });
    // description was not in the body -> must not be written
    expect(writeArgs.data.description).toBeUndefined();
  });

  it('returns 404 when the item does not exist', async () => {
    setApprovedUser();
    db.stagingItem.findUnique.mockResolvedValue(null);

    const resp = await PATCH(
      mkReq('http://t/api/staging-items/999', 'PATCH', { expectedQuantity: 1 }),
      { params: { id: '999' } }
    );

    expect(resp.status).toBe(404);
    expect(db.stagingItem.update).not.toHaveBeenCalled();
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
  });

  it('returns 403 when CSRF token is invalid', async () => {
    setApprovedUser();
    mockValidateCSRF.mockResolvedValue(false);

    const resp = await PATCH(
      mkReq('http://t/api/staging-items/5', 'PATCH', { expectedQuantity: 12 }),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(403);
    expect(db.stagingItem.findUnique).not.toHaveBeenCalled();
  });
});

describe('POST /api/staging-items/[id]/graduate', () => {
  it('graduates a RECEIVED item (200) and returns the result', async () => {
    setApprovedUser();
    (graduateStagingItem as jest.Mock).mockResolvedValue({
      productId: 100,
      approvalStatus: 'PENDING_REVIEW',
      locationId: 1,
      countedQuantity: 5,
      bookedQuantity: 5,
    });

    const resp = await graduatePOST(
      mkReq('http://t/api/staging-items/5/graduate', 'POST', {
        mode: 'existing',
        productId: 100,
        locationId: 1,
      }),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.productId).toBe(100);
    expect(body.approvalStatus).toBe('PENDING_REVIEW');
    // actor threads through with isAdmin from the session
    const [stagingId, , actor] = (graduateStagingItem as jest.Mock).mock.calls[0];
    expect(stagingId).toBe(5);
    expect(actor).toEqual({ id: APPROVED_USER.id, isAdmin: false });
  });

  it('propagates a 409 when the item was already graduated/discarded', async () => {
    setApprovedUser();
    (graduateStagingItem as jest.Mock).mockRejectedValue(
      new AppError('Item already graduated or discarded', 'CONFLICT', 409)
    );

    const resp = await graduatePOST(
      mkReq('http://t/api/staging-items/5/graduate', 'POST', {
        mode: 'existing',
        productId: 100,
        locationId: 1,
      }),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.error).toMatch(/already graduated/i);
  });

  // W1-3a (pack REV-3 T2): countedQuantity left this request entirely. The old
  // "< 1 -> 400" Zod pin is superseded by the regression pin — ANY countedQuantity
  // is refused, and the zero-count rule now lives on the ROW (422 from the lib).
  it('returns 400 when the body still carries countedQuantity, without calling the lib', async () => {
    setApprovedUser();

    const resp = await graduatePOST(
      mkReq('http://t/api/staging-items/5/graduate', 'POST', {
        mode: 'existing',
        productId: 100,
        countedQuantity: 50,
        locationId: 1,
      }),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(400);
    expect(graduateStagingItem).not.toHaveBeenCalled();
  });

  it('returns 403 when CSRF token is invalid (lib not called)', async () => {
    setApprovedUser();
    mockValidateCSRF.mockResolvedValue(false);

    const resp = await graduatePOST(
      mkReq('http://t/api/staging-items/5/graduate', 'POST', {
        mode: 'existing',
        productId: 100,
        locationId: 1,
      }),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(403);
    expect(graduateStagingItem).not.toHaveBeenCalled();
  });
});

describe('POST /api/staging-items/[id]/discard', () => {
  it('discards a RECEIVED item (200)', async () => {
    setApprovedUser();
    db.stagingItem.updateMany.mockResolvedValue({ count: 1 });

    const resp = await discardPOST(
      mkReq('http://t/api/staging-items/5/discard', 'POST'),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe('DISCARDED');
    const args = db.stagingItem.updateMany.mock.calls[0][0];
    expect(args.where).toEqual({ id: 5, status: 'RECEIVED' });
    expect(args.data).toEqual({ status: 'DISCARDED' });
  });

  it('returns 409 when the item is not RECEIVED (count 0)', async () => {
    setApprovedUser();
    db.stagingItem.updateMany.mockResolvedValue({ count: 0 });

    const resp = await discardPOST(
      mkReq('http://t/api/staging-items/5/discard', 'POST'),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.error).toMatch(/not found|discardable/i);
  });

  it('returns 403 when CSRF token is invalid (no write)', async () => {
    setApprovedUser();
    mockValidateCSRF.mockResolvedValue(false);

    const resp = await discardPOST(
      mkReq('http://t/api/staging-items/5/discard', 'POST'),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(403);
    expect(db.stagingItem.updateMany).not.toHaveBeenCalled();
  });
});
