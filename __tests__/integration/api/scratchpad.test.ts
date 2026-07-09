// @jest-environment node
import { NextRequest } from 'next/server';

// Keep the REAL apiHandler (so ZodError -> 400, AppError -> its status, and
// OptimisticLockError -> 409 get mapped centrally), but stub the auth guards.
jest.mock('@/lib/api-utils', () => {
  const actual = jest.requireActual('@/lib/api-utils');
  return {
    __esModule: true,
    ...actual,
    requireApproved: jest.fn(),
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

// The routes now wrap their mutation + recordChange in one prisma.$transaction;
// the mutations are mocked below, so tx only needs to be a stable sentinel the
// recordChange spy can be asserted against.
jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: { $transaction: jest.fn(async (fn: any) => fn({})) },
}));

// change-tracking recordChange is stubbed (it touches next/headers + tx.auditLog);
// these route tests focus on the HTTP layer + whether a row was recorded (or not).
jest.mock('@/lib/change-tracking', () => ({
  __esModule: true,
  recordChange: jest.fn(async () => undefined),
  newBatchId: jest.fn(() => 'test-batch-id'),
}));

// The mutations + queries are unit-tested separately; mock them here so the
// route tests focus on the HTTP layer (auth, CSRF, validation, status mapping).
jest.mock('@/lib/scratchpad/mutations', () => ({
  createScratchpadRow: jest.fn(),
  updateScratchpadRow: jest.fn(),
  deleteScratchpadRow: jest.fn(),
}));
jest.mock('@/lib/scratchpad/queries', () => ({
  getScratchpadBoard: jest.fn(),
  getLabelSuggestions: jest.fn(),
}));

import { GET as boardGET, POST } from '@/app/api/scratchpad/route';
import { PATCH, DELETE } from '@/app/api/scratchpad/[id]/route';
import { GET as labelsGET } from '@/app/api/scratchpad/labels/route';
import { requireApproved } from '@/lib/api-utils';
import { validateCSRFToken } from '@/lib/csrf';
import { applyRateLimitHeaders } from '@/lib/rateLimit';
import { recordChange } from '@/lib/change-tracking';
import {
  createScratchpadRow,
  updateScratchpadRow,
  deleteScratchpadRow,
} from '@/lib/scratchpad/mutations';
import { getScratchpadBoard, getLabelSuggestions } from '@/lib/scratchpad/queries';
import { OptimisticLockError } from '@/lib/inventory';
import { AppError } from '@/lib/error-handling';

const mockValidateCSRF = validateCSRFToken as jest.Mock;
const mockApplyRateLimitHeaders = applyRateLimitHeaders as jest.Mock;
const mockRecordChange = recordChange as jest.Mock;

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
});

describe('POST /api/scratchpad (create)', () => {
  it('creates a row (201) and writes a SCRATCHPAD_CREATE audit entry', async () => {
    setApprovedUser();
    (createScratchpadRow as jest.Mock).mockResolvedValue({ id: 42, label: 'Awake Price', productId: 1 });

    const res = await POST(
      mkReq('http://t/api/scratchpad', 'POST', { productId: 1, label: 'Awake Price' }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe(42);
    const [input, actor] = (createScratchpadRow as jest.Mock).mock.calls[0];
    expect(input).toMatchObject({ productId: 1, label: 'Awake Price' });
    expect(actor).toEqual({ id: APPROVED_USER.id });
    expect(mockRecordChange).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actionType: 'SCRATCHPAD_CREATE', entityType: 'SCRATCHPAD', entityId: 42 }),
    );
  });

  it('returns 403 when CSRF is invalid and does not create', async () => {
    setApprovedUser({ id: 9, isAdmin: false });
    mockValidateCSRF.mockResolvedValue(false);

    const res = await POST(
      mkReq('http://t/api/scratchpad', 'POST', { productId: 1, label: 'x' }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/CSRF/i);
    expect(createScratchpadRow).not.toHaveBeenCalled();
  });

  it('returns 400 (Zod) when label is empty, without calling the lib', async () => {
    setApprovedUser();
    const res = await POST(
      mkReq('http://t/api/scratchpad', 'POST', { productId: 1, label: '' }),
    );
    expect(res.status).toBe(400);
    expect(createScratchpadRow).not.toHaveBeenCalled();
  });
});

describe('GET /api/scratchpad (board)', () => {
  it('returns the board (200)', async () => {
    setApprovedUser();
    (getScratchpadBoard as jest.Mock).mockResolvedValue([{ id: 1, scratchpadPrices: [] }]);

    const res = await boardGET(mkReq('http://t/api/scratchpad', 'GET'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.board).toHaveLength(1);
    expect(body.board[0].id).toBe(1);
  });
});

describe('PATCH /api/scratchpad/[id]', () => {
  it('updates a row (200) and writes a SCRATCHPAD_UPDATE audit entry', async () => {
    setApprovedUser();
    (updateScratchpadRow as jest.Mock).mockResolvedValue({ id: 5, version: 3 });

    const res = await PATCH(
      mkReq('http://t/api/scratchpad/5', 'PATCH', { expectedVersion: 2, value: '42' }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(200);
    const [id, expectedVersion, patch, actor] = (updateScratchpadRow as jest.Mock).mock.calls[0];
    expect(id).toBe(5);
    expect(expectedVersion).toBe(2);
    expect(patch).toEqual({ value: '42' }); // expectedVersion stripped from the patch
    expect(actor).toEqual({ id: APPROVED_USER.id });
    expect(mockRecordChange).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actionType: 'SCRATCHPAD_UPDATE', entityType: 'SCRATCHPAD', entityId: 5 }),
    );
  });

  it('returns 409 when the lib throws OptimisticLockError (stale version)', async () => {
    setApprovedUser();
    (updateScratchpadRow as jest.Mock).mockRejectedValue(
      new OptimisticLockError('Row was modified by someone else', 7, 2),
    );

    const res = await PATCH(
      mkReq('http://t/api/scratchpad/5', 'PATCH', { expectedVersion: 2, value: '42' }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.currentVersion).toBe(7);
    expect(body.expectedVersion).toBe(2);
  });

  it('returns 404 when the lib throws a NOT_FOUND AppError', async () => {
    setApprovedUser();
    (updateScratchpadRow as jest.Mock).mockRejectedValue(
      new AppError('Scratchpad row not found', 'NOT_FOUND', 404),
    );

    const res = await PATCH(
      mkReq('http://t/api/scratchpad/999', 'PATCH', { expectedVersion: 0, value: '1' }),
      { params: { id: '999' } },
    );

    expect(res.status).toBe(404);
  });

  it('returns 200 { deleted: true } when the row was raced-deleted (lib returns null) — never 500', async () => {
    setApprovedUser();
    (updateScratchpadRow as jest.Mock).mockResolvedValue(null);

    const res = await PATCH(
      mkReq('http://t/api/scratchpad/5', 'PATCH', { expectedVersion: 2, value: '42' }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
    expect(mockRecordChange).not.toHaveBeenCalled(); // no row to log against
  });

  it('returns 400 (Zod) on an empty PATCH (no mutable field), without calling the lib', async () => {
    setApprovedUser();
    const res = await PATCH(
      mkReq('http://t/api/scratchpad/5', 'PATCH', { expectedVersion: 2 }),
      { params: { id: '5' } },
    );
    expect(res.status).toBe(400);
    expect(updateScratchpadRow).not.toHaveBeenCalled();
  });

  it('returns 403 when CSRF is invalid (lib not called)', async () => {
    setApprovedUser();
    mockValidateCSRF.mockResolvedValue(false);

    const res = await PATCH(
      mkReq('http://t/api/scratchpad/5', 'PATCH', { expectedVersion: 2, value: '42' }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(403);
    expect(updateScratchpadRow).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/scratchpad/[id]', () => {
  it('deletes a row (200) and writes a SCRATCHPAD_DELETE audit entry', async () => {
    setApprovedUser();
    (deleteScratchpadRow as jest.Mock).mockResolvedValue({ deleted: true });

    const res = await DELETE(
      mkReq('http://t/api/scratchpad/5', 'DELETE', { expectedVersion: 1 }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
    const [id, expectedVersion] = (deleteScratchpadRow as jest.Mock).mock.calls[0];
    expect(id).toBe(5);
    expect(expectedVersion).toBe(1);
    expect(mockRecordChange).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actionType: 'SCRATCHPAD_DELETE', entityType: 'SCRATCHPAD', entityId: 5 }),
    );
  });

  it('returns 409 when the lib throws OptimisticLockError', async () => {
    setApprovedUser();
    (deleteScratchpadRow as jest.Mock).mockRejectedValue(
      new OptimisticLockError('Row was modified by someone else', 4, 1),
    );

    const res = await DELETE(
      mkReq('http://t/api/scratchpad/5', 'DELETE', { expectedVersion: 1 }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(409);
  });

  it('returns 403 when CSRF is invalid (lib not called)', async () => {
    setApprovedUser();
    mockValidateCSRF.mockResolvedValue(false);

    const res = await DELETE(
      mkReq('http://t/api/scratchpad/5', 'DELETE', { expectedVersion: 1 }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(403);
    expect(deleteScratchpadRow).not.toHaveBeenCalled();
  });
});

describe('GET /api/scratchpad/labels', () => {
  it('returns label suggestions filtered by q (200)', async () => {
    setApprovedUser();
    (getLabelSuggestions as jest.Mock).mockResolvedValue(['Awake Price']);

    const res = await labelsGET(mkReq('http://t/api/scratchpad/labels?q=Aw', 'GET'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.labels).toEqual(['Awake Price']);
    expect((getLabelSuggestions as jest.Mock).mock.calls[0][0]).toBe('Aw');
  });
});
