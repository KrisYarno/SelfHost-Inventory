// @jest-environment node
/**
 * Change-tracking CHARACTERIZATION — scratchpad group (Phase A Task 10).
 *
 * Proves the shared-recipe invariants for every migrated call site in this group:
 *   1. SAME-TX: each recordChange runs on the IDENTICAL tx object as its mutation
 *      (asserted by reference, not shape).
 *   2. 409 RECORDS NOTHING: the scratchpad version-CAS 409s (OptimisticLockError
 *      from PATCH/DELETE) leave NO recordChange behind.
 *
 * The staging half of this suite — create / discard and the graduation fan-out,
 * plus the real graduate helper's own co-transaction proof — went with the flow
 * it characterized (Receiving/Labeling overhaul, M6). Its successor invariants
 * live on the supply-order routes' own suites, where the same batchId grouping is
 * asserted on verify / stock-in / discard-remaining.
 *
 * recordChange itself is mocked here (its payload assembly/redaction is unit-tested
 * in __tests__/unit/lib/change-tracking.test.ts). This file asserts the ROUTE
 * WIRING: which events fire, on which tx, under which batchId. The REAL apiHandler
 * is preserved so AppError/OptimisticLockError -> status map centrally, exactly as
 * production does.
 */

import { NextRequest } from 'next/server';

// --- Real apiHandler (central status mapping); stub the auth guards.
jest.mock('@/lib/api-utils', () => {
  const actual = jest.requireActual('@/lib/api-utils');
  return { __esModule: true, ...actual, requireApproved: jest.fn(), requireAdmin: jest.fn() };
});

jest.mock('@/lib/csrf', () => ({ validateCSRFToken: jest.fn(async () => true) }));

jest.mock('@/lib/rateLimit', () => ({
  __esModule: true,
  RateLimitError: jest.requireActual('@/lib/rateLimit').RateLimitError,
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((r: any) => r),
}));

// --- prisma: a $transaction that hands every route the same TX sentinel, so
// "the audit landed on the mutation's transaction" is an identity assertion.
jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: { $transaction: jest.fn() },
}));

// --- recordChange spy: assert the wiring, not the payload internals.
jest.mock('@/lib/change-tracking', () => ({
  __esModule: true,
  recordChange: jest.fn(async () => undefined),
  newBatchId: jest.fn(() => 'BATCH-UUID'),
}));

// --- scratchpad mutations mocked for route-wiring tests.
jest.mock('@/lib/scratchpad/mutations', () => ({
  createScratchpadRow: jest.fn(),
  updateScratchpadRow: jest.fn(),
  deleteScratchpadRow: jest.fn(),
}));
jest.mock('@/lib/scratchpad/queries', () => ({
  getScratchpadBoard: jest.fn(),
  getLabelSuggestions: jest.fn(),
}));

import prisma from '@/lib/prisma';
import { requireApproved } from '@/lib/api-utils';
import { recordChange, newBatchId } from '@/lib/change-tracking';
import {
  createScratchpadRow,
  updateScratchpadRow,
  deleteScratchpadRow,
} from '@/lib/scratchpad/mutations';
import { OptimisticLockError } from '@/lib/inventory';

import { POST as scratchpadCreatePOST } from '@/app/api/scratchpad/route';
import { PATCH as scratchpadPATCH, DELETE as scratchpadDELETE } from '@/app/api/scratchpad/[id]/route';

const mockPrisma = prisma as any;
const mockRecordChange = recordChange as jest.Mock;

// A stable tx sentinel the mutation AND recordChange must both receive — "same
// tx" is asserted by identity against this object.
const TX: any = {};

const APPROVED_USER = { id: 7, isAdmin: false, isApproved: true };

function mkReq(url: string, method: string, body?: any) {
  return new NextRequest(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({ user: APPROVED_USER });
  (newBatchId as jest.Mock).mockReturnValue('BATCH-UUID');
  // Default: $transaction hands the SAME TX sentinel to the callback.
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(TX));
});

// ---------------------------------------------------------------------------
// ROUTE wiring (mocked mutations + mocked recordChange)
// ---------------------------------------------------------------------------

describe('scratchpad POST /api/scratchpad (create)', () => {
  it('records SCRATCHPAD_CREATE on the same tx the mutation received', async () => {
    (createScratchpadRow as jest.Mock).mockResolvedValue({ id: 42, label: 'Awake', productId: 1 });

    const res = await scratchpadCreatePOST(
      mkReq('http://t/api/scratchpad', 'POST', { productId: 1, label: 'Awake' }),
    );

    expect(res.status).toBe(201);
    // mutation received TX as its tx arg…
    const mutationTx = (createScratchpadRow as jest.Mock).mock.calls[0][2];
    expect(mutationTx).toBe(TX);
    // …and recordChange landed on the very same TX.
    const [txArg, event] = mockRecordChange.mock.calls[0];
    expect(txArg).toBe(TX);
    expect(event).toMatchObject({ actionType: 'SCRATCHPAD_CREATE', entityType: 'SCRATCHPAD', entityId: 42 });
  });
});

describe('scratchpad PATCH /api/scratchpad/[id] — version CAS', () => {
  it('records SCRATCHPAD_UPDATE on the same tx on success', async () => {
    (updateScratchpadRow as jest.Mock).mockResolvedValue({ id: 5, version: 3 });

    const res = await scratchpadPATCH(
      mkReq('http://t/api/scratchpad/5', 'PATCH', { expectedVersion: 2, value: '42' }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(200);
    const mutationTx = (updateScratchpadRow as jest.Mock).mock.calls[0][4];
    expect(mutationTx).toBe(TX);
    const [txArg, event] = mockRecordChange.mock.calls[0];
    expect(txArg).toBe(TX);
    expect(event).toMatchObject({ actionType: 'SCRATCHPAD_UPDATE', entityType: 'SCRATCHPAD', entityId: 5 });
  });

  it('records NOTHING on a stale-version 409 (OptimisticLockError)', async () => {
    (updateScratchpadRow as jest.Mock).mockRejectedValue(
      new OptimisticLockError('Row was modified by someone else', 7, 2),
    );

    const res = await scratchpadPATCH(
      mkReq('http://t/api/scratchpad/5', 'PATCH', { expectedVersion: 2, value: '42' }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(409);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('records NOTHING on a racey delete (mutation returns null) and maps to 200 { deleted: true }', async () => {
    (updateScratchpadRow as jest.Mock).mockResolvedValue(null);

    const res = await scratchpadPATCH(
      mkReq('http://t/api/scratchpad/5', 'PATCH', { expectedVersion: 2, value: '42' }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(true);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });
});

describe('scratchpad DELETE /api/scratchpad/[id] — version CAS', () => {
  it('records SCRATCHPAD_DELETE on the same tx on success', async () => {
    (deleteScratchpadRow as jest.Mock).mockResolvedValue({ deleted: true });

    const res = await scratchpadDELETE(
      mkReq('http://t/api/scratchpad/5', 'DELETE', { expectedVersion: 1 }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(200);
    const mutationTx = (deleteScratchpadRow as jest.Mock).mock.calls[0][2];
    expect(mutationTx).toBe(TX);
    const [txArg, event] = mockRecordChange.mock.calls[0];
    expect(txArg).toBe(TX);
    expect(event).toMatchObject({ actionType: 'SCRATCHPAD_DELETE', entityType: 'SCRATCHPAD', entityId: 5 });
  });

  it('records NOTHING on a stale-version 409 (OptimisticLockError)', async () => {
    (deleteScratchpadRow as jest.Mock).mockRejectedValue(
      new OptimisticLockError('Row was modified by someone else', 4, 1),
    );

    const res = await scratchpadDELETE(
      mkReq('http://t/api/scratchpad/5', 'DELETE', { expectedVersion: 1 }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(409);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });
});
