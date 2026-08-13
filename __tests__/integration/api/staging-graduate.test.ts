// @jest-environment node
/**
 * W1-3a — `POST /api/staging-items/[id]/graduate` (contract pack REV-3 T2/T3).
 *
 * THE DEFECT THIS KILLS: the dialog pre-filled "counted" from EXPECTED and the
 * server booked whatever the request body said. Count 46, confirm, book 50 —
 * silently, with an audit line that agreed with the lie.
 *
 * The route half of the fix:
 *   - a body carrying `countedQuantity` is REFUSED at 400 (the PATCH precedent:
 *     a caller that believes it counted something is worse than one that errored),
 *     and the lib is never reached, so the request cannot alter what is booked;
 *   - the override pair is both-or-neither (400 on a half);
 *   - an override emits a GRADUATE_OVERRIDE audit line NAMING BOTH quantities,
 *     on the helper's transaction, under the graduation's batchId;
 *   - the response carries { countedQuantity, bookedQuantity } — W1-3b and W1-4b
 *     consume this shape (seam S2).
 *
 * The lib is mocked here on purpose; what it BOOKS is pinned in
 * __tests__/unit/lib/staging/graduate.test.ts.
 */

import { NextRequest } from 'next/server';

jest.mock('@/lib/api-utils', () => {
  const actual = jest.requireActual('@/lib/api-utils');
  return { __esModule: true, ...actual, requireApproved: jest.fn() };
});

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: { $transaction: jest.fn(async (fn: any) => fn({})) },
}));

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
  newBatchId: jest.fn(() => 'GRAD-BATCH'),
}));

jest.mock('@/lib/staging/graduate', () => ({ graduateStagingItem: jest.fn() }));

import { POST as graduatePOST } from '@/app/api/staging-items/[id]/graduate/route';
import { requireApproved } from '@/lib/api-utils';
import { graduateStagingItem } from '@/lib/staging/graduate';
import { recordChange } from '@/lib/change-tracking';
import { validateCSRFToken } from '@/lib/csrf';
import { AppError } from '@/lib/error-handling';

const mockGraduate = graduateStagingItem as jest.Mock;
const mockRecordChange = recordChange as jest.Mock;
const mockValidateCSRF = validateCSRFToken as jest.Mock;

const APPROVED_USER = { id: 7, isAdmin: false, isApproved: true };
const GRAD_TX: any = { __gradTx: true };

function mkReq(body: unknown, id = '5') {
  return new NextRequest(`http://t/api/staging-items/${id}/graduate`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
  });
}

/** Drive the mocked helper: run its onRecord against GRAD_TX, return `result`. */
function driveHelper(ctx: Record<string, unknown>, result?: Record<string, unknown>) {
  mockGraduate.mockImplementation(async (_id: number, _body: any, _actor: any, opts: any) => {
    if (opts?.onRecord) await opts.onRecord(GRAD_TX, ctx);
    return result ?? ctx;
  });
}

const baseCtx = {
  productId: 100,
  approvalStatus: 'APPROVED',
  locationId: 1,
  countedQuantity: 46,
  bookedQuantity: 46,
  override: null,
  created: false,
  receiptCost: { unitCostCents: null, source: 'product' },
};

const actionTypes = () => mockRecordChange.mock.calls.map((c) => c[1].actionType);
const eventOf = (type: string) =>
  mockRecordChange.mock.calls.map((c) => c[1]).find((e) => e.actionType === type);

beforeEach(() => {
  jest.clearAllMocks();
  mockValidateCSRF.mockResolvedValue(true);
  (requireApproved as jest.Mock).mockResolvedValue({ user: APPROVED_USER });
  driveHelper(baseCtx);
});

// ---------------------------------------------------------------------------
// THE REGRESSION PIN.
// ---------------------------------------------------------------------------

describe('count-46-book-50 regression', () => {
  it('a body carrying countedQuantity is refused at 400 and the lib is never called', async () => {
    const res = await graduatePOST(
      mkReq({ mode: 'existing', productId: 100, locationId: 1, countedQuantity: 50 }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.error).toMatch(/count/i);
    expect(mockGraduate).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('refuses it on the mode=new branch too', async () => {
    const res = await graduatePOST(
      mkReq({
        mode: 'new',
        productFields: { baseName: 'X', variant: '1', locationId: 1 },
        locationId: 1,
        countedQuantity: 50,
      }),
      { params: { id: '5' } },
    );
    expect(res.status).toBe(400);
    expect(mockGraduate).not.toHaveBeenCalled();
  });

  it('the request CANNOT alter what is booked: the helper receives no quantity at all', async () => {
    const res = await graduatePOST(
      mkReq({ mode: 'existing', productId: 100, locationId: 1 }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(200);
    const [, bodyArg] = mockGraduate.mock.calls[0];
    expect(bodyArg).not.toHaveProperty('countedQuantity');
    expect(bodyArg).toEqual({ mode: 'existing', productId: 100, locationId: 1 });
    // …and the booked number in the response came from the helper's row read.
    expect((await res.json()).bookedQuantity).toBe(46);
  });
});

// ---------------------------------------------------------------------------
// Response shape (seam S2 -> W1-3b / W1-4b).
// ---------------------------------------------------------------------------

describe('response shape', () => {
  it('returns countedQuantity + bookedQuantity alongside the existing fields', async () => {
    const res = await graduatePOST(
      mkReq({ mode: 'existing', productId: 100, locationId: 1 }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      productId: 100,
      approvalStatus: 'APPROVED',
      locationId: 1,
      countedQuantity: 46,
      bookedQuantity: 46,
    });
  });

  it('propagates the helper 422 (uncounted item) verbatim', async () => {
    mockGraduate.mockRejectedValue(
      new AppError('Count this item before graduating it', 'VALIDATION_ERROR', 422),
    );

    const res = await graduatePOST(
      mkReq({ mode: 'existing', productId: 100, locationId: 1 }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.error).toMatch(/count this item before graduating/i);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('propagates the CANCELLED-shipment 409 verbatim', async () => {
    mockGraduate.mockRejectedValue(
      new AppError('Inbound shipment S1 is cancelled and its lines cannot be graduated', 'CONFLICT', 409),
    );

    const res = await graduatePOST(
      mkReq({ mode: 'existing', productId: 100, locationId: 1 }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/cannot be graduated/i);
  });
});

// ---------------------------------------------------------------------------
// The override pair.
// ---------------------------------------------------------------------------

describe('the override pair (both-or-neither)', () => {
  it('400s a quantity without a reason, without calling the lib', async () => {
    const res = await graduatePOST(
      mkReq({ mode: 'existing', productId: 100, locationId: 1, overrideQuantity: 40 }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
    expect(mockGraduate).not.toHaveBeenCalled();
  });

  it('400s a reason without a quantity', async () => {
    const res = await graduatePOST(
      mkReq({ mode: 'existing', productId: 100, locationId: 1, overrideReason: 'damaged' }),
      { params: { id: '5' } },
    );
    expect(res.status).toBe(400);
    expect(mockGraduate).not.toHaveBeenCalled();
  });

  it('400s an empty-string reason (Zod min(1)) — an unexplained override is not an override', async () => {
    const res = await graduatePOST(
      mkReq({ mode: 'existing', productId: 100, locationId: 1, overrideQuantity: 40, overrideReason: '' }),
      { params: { id: '5' } },
    );
    expect(res.status).toBe(400);
    expect(mockGraduate).not.toHaveBeenCalled();
  });

  it('passes the pair through to the helper', async () => {
    await graduatePOST(
      mkReq({
        mode: 'existing',
        productId: 100,
        locationId: 1,
        overrideQuantity: 40,
        overrideReason: 'six vials broken in transit',
      }),
      { params: { id: '5' } },
    );

    expect(mockGraduate.mock.calls[0][1]).toMatchObject({
      overrideQuantity: 40,
      overrideReason: 'six vials broken in transit',
    });
  });
});

// ---------------------------------------------------------------------------
// The audit fan-out.
// ---------------------------------------------------------------------------

describe('audit', () => {
  it('no override -> STAGING_GRADUATE only, and it carries BOTH quantities', async () => {
    await graduatePOST(mkReq({ mode: 'existing', productId: 100, locationId: 1 }), {
      params: { id: '5' },
    });

    expect(actionTypes()).toEqual(['STAGING_GRADUATE']);
    expect(eventOf('STAGING_GRADUATE').details).toMatchObject({
      countedQuantity: 46,
      bookedQuantity: 46,
    });
  });

  it('override -> a GRADUATE_OVERRIDE line NAMING BOTH quantities, same tx + batchId', async () => {
    driveHelper({
      ...baseCtx,
      bookedQuantity: 40,
      override: { quantity: 40, reason: 'six vials broken in transit' },
    });

    const res = await graduatePOST(
      mkReq({
        mode: 'existing',
        productId: 100,
        locationId: 1,
        overrideQuantity: 40,
        overrideReason: 'six vials broken in transit',
      }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(200);
    expect(actionTypes()).toContain('GRADUATE_OVERRIDE');

    const ev = eventOf('GRADUATE_OVERRIDE');
    expect(ev).toMatchObject({ entityType: 'STAGING', entityId: 5, batchId: 'GRAD-BATCH' });
    expect(ev.details).toMatchObject({
      countedQuantity: 46,
      bookedQuantity: 40,
      overrideReason: 'six vials broken in transit',
    });
    // Both numbers are readable off the human-facing line, not only the details.
    expect(ev.action).toMatch(/46/);
    expect(ev.action).toMatch(/40/);

    // Every event landed on the helper's transaction under the one batchId.
    for (const [txArg, event] of mockRecordChange.mock.calls) {
      expect(txArg).toBe(GRAD_TX);
      expect(event.batchId).toBe('GRAD-BATCH');
    }
  });

  it('new product + override -> PRODUCT_CREATE, STAGING_GRADUATE and GRADUATE_OVERRIDE', async () => {
    driveHelper({
      ...baseCtx,
      created: true,
      approvalStatus: 'PENDING_REVIEW',
      bookedQuantity: 40,
      override: { quantity: 40, reason: 'shorted' },
    });

    await graduatePOST(
      mkReq({
        mode: 'new',
        productFields: { baseName: 'X', variant: '1', locationId: 1 },
        locationId: 1,
        overrideQuantity: 40,
        overrideReason: 'shorted',
      }),
      { params: { id: '5' } },
    );

    expect(actionTypes().sort()).toEqual(
      ['GRADUATE_OVERRIDE', 'PRODUCT_CREATE', 'STAGING_GRADUATE'].sort(),
    );
  });
});

describe('guards (unchanged)', () => {
  it('403s an invalid CSRF token without calling the lib', async () => {
    mockValidateCSRF.mockResolvedValue(false);
    const res = await graduatePOST(
      mkReq({ mode: 'existing', productId: 100, locationId: 1 }),
      { params: { id: '5' } },
    );
    expect(res.status).toBe(403);
    expect(mockGraduate).not.toHaveBeenCalled();
  });

  it('400s a non-numeric id', async () => {
    const res = await graduatePOST(
      mkReq({ mode: 'existing', productId: 100, locationId: 1 }, 'abc'),
      { params: { id: 'abc' } },
    );
    expect(res.status).toBe(400);
    expect(mockGraduate).not.toHaveBeenCalled();
  });
});
