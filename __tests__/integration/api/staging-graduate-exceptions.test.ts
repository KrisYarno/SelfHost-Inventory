// @jest-environment node
/**
 * W1-3b — the GRADUATE route's exception seam (contract pack REV-3 T1 + T3).
 *
 * Two register rows are born at graduation, and both are written from INSIDE the
 * graduation transaction (the `onRecord` hook is handed that tx), so a rolled-back
 * graduation can never strand one:
 *
 *   cost-differs:<stagingItemId>   a NON-ADMIN received goods at a cost that
 *                                  disagrees with the product's standing cost.
 *                                  They may not edit the price, so the
 *                                  disagreement becomes a ROW instead of a
 *                                  prompt — never silent, never blocking.
 *   pending-with-stock:<productId> a NON-ADMIN minted a new product, so real
 *                                  units are now on hand against something
 *                                  nobody has approved yet.
 *
 * An ADMIN sees neither row: the differ becomes a costPrompt on the RESPONSE
 * (which the dialog settles through the real product PUT), and an admin's new
 * product is APPROVED on creation.
 *
 * The exceptions writer is deliberately NOT mocked — "a row appears" is the
 * contract, not "a function was called". The graduation LIB is mocked: what it
 * decides is pinned in __tests__/unit/lib/staging/graduate.test.ts.
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
import { validateCSRFToken } from '@/lib/csrf';

const mockGraduate = graduateStagingItem as jest.Mock;
const mockValidateCSRF = validateCSRFToken as jest.Mock;

const APPROVED_USER = { id: 7, isAdmin: false, isApproved: true };
const ADMIN_USER = { id: 3, isAdmin: true, isApproved: true };

/** The graduation transaction the route's onRecord writes through. */
let gradTx: any;

function mkTx() {
  return {
    inventoryException: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => ({ id: 1, ...data })),
      update: jest.fn(async ({ data }: any) => ({ id: 1, ...data })),
    },
  };
}

function mkReq(body: unknown, id = '5') {
  return new NextRequest(`http://t/api/staging-items/${id}/graduate`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
  });
}

const EXISTING_BODY = { mode: 'existing', productId: 100, locationId: 1 };
const NEW_BODY = {
  mode: 'new',
  locationId: 1,
  productFields: { baseName: 'Test Peptide', variant: '10mg', locationId: 1 },
};

const baseCtx = {
  productId: 100,
  approvalStatus: 'APPROVED',
  locationId: 1,
  countedQuantity: 46,
  bookedQuantity: 46,
  override: null,
  created: false,
  receiptCost: { unitCostCents: 1234, source: 'line' },
  costPrompt: null,
  costDiffers: null,
};

/** Drive the mocked helper: run its onRecord against gradTx, return `result`. */
function driveHelper(ctx: Record<string, unknown>, result?: Record<string, unknown>) {
  mockGraduate.mockImplementation(async (_id: number, _body: any, _actor: any, opts: any) => {
    if (opts?.onRecord) await opts.onRecord(gradTx, ctx);
    return result ?? ctx;
  });
}

/** Every exception row the route wrote, as { key, kind, subject }. */
function writtenExceptions() {
  return gradTx.inventoryException.create.mock.calls.map((c: any) => c[0].data);
}

beforeEach(() => {
  jest.clearAllMocks();
  gradTx = mkTx();
  mockValidateCSRF.mockResolvedValue(true);
  (requireApproved as jest.Mock).mockResolvedValue({ user: APPROVED_USER });
  driveHelper(baseCtx);
});

// ---------------------------------------------------------------------------
// cost-differs (T3)
// ---------------------------------------------------------------------------

describe('graduate -> cost-differs', () => {
  it('a NON-ADMIN differ writes the row, keyed by STAGING LINE, with both numbers', async () => {
    driveHelper({
      ...baseCtx,
      costDiffers: {
        productId: 100,
        stagingItemId: 5,
        currentCents: 100,
        receiptCents: 1234,
      },
    });

    const res = await graduatePOST(mkReq(EXISTING_BODY), { params: { id: '5' } });

    expect(res.status).toBe(200);
    const rows = writtenExceptions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'cost-differs:5',
      kind: 'cost-differs',
      subject: {
        productId: 100,
        stagingItemId: 5,
        currentCents: 100,
        receiptCents: 1234,
      },
    });
  });

  it('writes through the GRADUATION tx (a rolled-back graduation cannot strand it)', async () => {
    driveHelper({
      ...baseCtx,
      costDiffers: { productId: 100, stagingItemId: 5, currentCents: 100, receiptCents: 1234 },
    });

    await graduatePOST(mkReq(EXISTING_BODY), { params: { id: '5' } });

    // The delegate that was written is the one handed to onRecord, not a fresh
    // prisma client — that identity IS the atomicity guarantee.
    expect(gradTx.inventoryException.create).toHaveBeenCalledTimes(1);
  });

  it('QA-7: an ADMIN differ writes the row AND returns the prompt (both, not either)', async () => {
    (requireApproved as jest.Mock).mockResolvedValue({ user: ADMIN_USER });
    const prompt = { productId: 100, currentCents: 100, receiptCents: 1234 };
    driveHelper(
      {
        ...baseCtx,
        costDiffers: { productId: 100, stagingItemId: 5, currentCents: 100, receiptCents: 1234 },
        costPrompt: prompt,
      },
      { ...baseCtx, costPrompt: prompt },
    );

    const res = await graduatePOST(mkReq(EXISTING_BODY), { params: { id: '5' } });
    const json = await res.json();

    // The prompt is a dialog that dies on reopen; the row is what W3 reads.
    expect(json.costPrompt).toEqual(prompt);
    const rows = writtenExceptions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'cost-differs:5', kind: 'cost-differs' });
  });

  it('agreement (or no receipt cost) writes nothing and prompts nothing', async () => {
    const res = await graduatePOST(mkReq(EXISTING_BODY), { params: { id: '5' } });
    const json = await res.json();

    expect(writtenExceptions()).toHaveLength(0);
    expect(json.costPrompt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pending-with-stock (T1)
// ---------------------------------------------------------------------------

describe('graduate -> pending-with-stock', () => {
  it('a NON-ADMIN mode:new graduation (PENDING_REVIEW) registers the product', async () => {
    driveHelper({
      ...baseCtx,
      productId: 101,
      approvalStatus: 'PENDING_REVIEW',
      created: true,
      bookedQuantity: 46,
    });

    const res = await graduatePOST(mkReq(NEW_BODY), { params: { id: '5' } });

    expect(res.status).toBe(200);
    const rows = writtenExceptions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'pending-with-stock:101',
      kind: 'pending-with-stock',
      subject: { productId: 101, stagingItemId: 5, units: 46 },
    });
  });

  it('units are what the LEDGER booked, not what the dock counted (an override moves it)', async () => {
    driveHelper({
      ...baseCtx,
      productId: 101,
      approvalStatus: 'PENDING_REVIEW',
      created: true,
      countedQuantity: 46,
      bookedQuantity: 40,
      override: { quantity: 40, reason: 'six broken in transit' },
    });

    await graduatePOST(mkReq({ ...NEW_BODY, overrideQuantity: 40, overrideReason: 'six broken in transit' }), {
      params: { id: '5' },
    });

    expect(writtenExceptions()[0].subject.units).toBe(40);
  });

  it('an ADMIN mode:new graduation (APPROVED) registers nothing', async () => {
    (requireApproved as jest.Mock).mockResolvedValue({ user: ADMIN_USER });
    driveHelper({ ...baseCtx, productId: 101, approvalStatus: 'APPROVED', created: true });

    await graduatePOST(mkReq(NEW_BODY), { params: { id: '5' } });

    expect(writtenExceptions()).toHaveLength(0);
  });

  it('restocking an EXISTING pending product registers nothing (the pack scopes this to mode:new)', async () => {
    driveHelper({ ...baseCtx, approvalStatus: 'PENDING_REVIEW', created: false });

    await graduatePOST(mkReq(EXISTING_BODY), { params: { id: '5' } });

    expect(writtenExceptions()).toHaveLength(0);
  });

  it('both rows can be raised by one graduation (a non-admin new product with a costed line)', async () => {
    driveHelper({
      ...baseCtx,
      productId: 101,
      approvalStatus: 'PENDING_REVIEW',
      created: true,
      costDiffers: { productId: 101, stagingItemId: 5, currentCents: null, receiptCents: 1234 },
    });

    await graduatePOST(mkReq(NEW_BODY), { params: { id: '5' } });

    expect(writtenExceptions().map((r: any) => r.key).sort()).toEqual([
      'cost-differs:5',
      'pending-with-stock:101',
    ]);
  });
});
