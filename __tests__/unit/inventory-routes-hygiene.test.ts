// @jest-environment node
/**
 * Inventory route hygiene (inventory-page-overhaul, Task 16).
 *
 * Pins three route-level contracts:
 *  1. /api/inventory/variants clamps pagination (NaN-safe defaults, pageSize cap)
 *     and keeps the SHOW contract (no approvalStatus filter; deletedAt: null only)
 *     — mirroring __tests__/integration/read-path-isolation.test.ts so this suite
 *     also locks it.
 *  2. /api/inventory/logs validates its query string with zod: bad dates and
 *     bogus logType values become 400 (via apiHandler's central ZodError map),
 *     valid enum values flow into the prisma where clause unchanged.
 *  3. /api/inventory/export is rate limited under the "inventory:export" scope.
 *
 * Harness modeled on __tests__/integration/read-path-isolation.test.ts:
 * deep-mocked prisma, REAL apiHandler (so ZodError -> 400 maps centrally),
 * stubbed auth guards, rateLimit module spread-from-actual with enforceRateLimit
 * replaced by a jest.fn passthrough.
 */

import { NextRequest } from 'next/server';
import { mockReset, type DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

// --- Prisma: deep mock so every model method is a jest.fn() we can assert on.
jest.mock('@/lib/prisma', () => {
  const { mockDeep: md } = require('jest-mock-extended');
  return { __esModule: true, default: md() };
});

// --- Keep the REAL apiHandler (central ZodError->400 mapping); stub auth guards.
jest.mock('@/lib/api-utils', () => {
  const actual = jest.requireActual('@/lib/api-utils');
  return {
    __esModule: true,
    ...actual,
    requireApproved: jest.fn(),
    requireAdmin: jest.fn(),
  };
});

// --- rateLimit: spread the real module (RateLimitError class, real
// applyRateLimitHeaders) but make enforceRateLimit an assertable passthrough
// that returns a headers object like the real one does.
jest.mock('@/lib/rateLimit', () => {
  const actual = jest.requireActual('@/lib/rateLimit');
  return {
    __esModule: true,
    ...actual,
    enforceRateLimit: jest.fn(() => ({ 'X-RateLimit-Limit': '10' })),
  };
});

import prisma from '@/lib/prisma';
import { requireApproved } from '@/lib/api-utils';
import { enforceRateLimit } from '@/lib/rateLimit';

// Route handlers under test
import { GET as variantsGET } from '@/app/api/inventory/variants/route';
import { GET as logsGET } from '@/app/api/inventory/logs/route';
import { GET as exportGET } from '@/app/api/inventory/export/route';
import { GET as productHistoryGET } from '@/app/api/inventory/product/[id]/route';

// Lib under test (uses the same deep-mocked prisma default export)
import { createInventoryLog } from '@/lib/inventory';

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const mockRequireApproved = requireApproved as jest.Mock;
const mockEnforceRateLimit = enforceRateLimit as jest.Mock;

const APPROVED_USER = {
  id: 7,
  email: 'a@b.c',
  name: 'Tester',
  isAdmin: false,
  isApproved: true,
  defaultLocationId: null,
};

function mkReq(url: string) {
  return new NextRequest(url);
}

beforeEach(() => {
  mockReset(db);
  jest.clearAllMocks();
  mockEnforceRateLimit.mockReturnValue({ 'X-RateLimit-Limit': '10' });
  mockRequireApproved.mockResolvedValue({ user: APPROVED_USER });
});

// ===========================================================================
// 1. GET /api/inventory/variants — pagination clamping
// ===========================================================================

describe('GET /api/inventory/variants pagination clamping', () => {
  beforeEach(() => {
    db.product.count.mockResolvedValue(0 as any);
    db.product.findMany.mockResolvedValue([] as any);
  });

  it('clamps page=0 and pageSize=100000 to take <= 100 and skip >= 0', async () => {
    const resp = await variantsGET(
      mkReq('http://t/api/inventory/variants?page=0&pageSize=100000')
    );
    expect(resp.status).toBe(200);

    const args = db.product.findMany.mock.calls[0][0] as any;
    expect(args.take).toBeLessThanOrEqual(100);
    expect(args.skip).toBeGreaterThanOrEqual(0);
  });

  it('falls back to defaults (page 1, pageSize 12) on non-numeric params', async () => {
    const resp = await variantsGET(
      mkReq('http://t/api/inventory/variants?page=abc&pageSize=xyz')
    );
    expect(resp.status).toBe(200);

    const args = db.product.findMany.mock.calls[0][0] as any;
    expect(args.take).toBe(12);
    expect(args.skip).toBe(0);

    const body = await resp.json();
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.pageSize).toBe(12);
  });
});

// ===========================================================================
// 2. GET /api/inventory/variants — SHOW contract (mirrors read-path-isolation)
// ===========================================================================

describe('GET /api/inventory/variants SHOW contract', () => {
  it('bare GET: where has deletedAt: null and NO approvalStatus filter', async () => {
    db.product.count.mockResolvedValue(0 as any);
    db.product.findMany.mockResolvedValue([] as any);

    const resp = await variantsGET(mkReq('http://t/api/inventory/variants'));
    expect(resp.status).toBe(200);

    const findWhere = (db.product.findMany.mock.calls[0][0] as any).where;
    const countWhere = (db.product.count.mock.calls[0][0] as any).where;
    expect(findWhere).not.toHaveProperty('approvalStatus');
    expect(countWhere).not.toHaveProperty('approvalStatus');
    expect(findWhere).toMatchObject({ deletedAt: null });
    expect(countWhere).toMatchObject({ deletedAt: null });
  });
});

// ===========================================================================
// 3. GET /api/inventory/logs — zod query validation
// ===========================================================================

describe('GET /api/inventory/logs query validation', () => {
  beforeEach(() => {
    db.inventory_logs.count.mockResolvedValue(0 as any);
    db.inventory_logs.findMany.mockResolvedValue([] as any);
  });

  it('returns 400 (with error body) for an unparseable startDate', async () => {
    const resp = await logsGET(
      mkReq('http://t/api/inventory/logs?startDate=not-a-date')
    );
    expect(resp.status).toBe(400);

    const body = await resp.json();
    expect(body.error).toBeDefined();
  });

  it('returns 400 for a logType outside the inventory_logs_logType enum', async () => {
    const resp = await logsGET(mkReq('http://t/api/inventory/logs?logType=BOGUS'));
    expect(resp.status).toBe(400);
  });

  it('passes a real enum logType through to the prisma where clause', async () => {
    const resp = await logsGET(
      mkReq('http://t/api/inventory/logs?logType=ADJUSTMENT')
    );
    expect(resp.status).toBe(200);

    const where = (db.inventory_logs.findMany.mock.calls[0][0] as any).where;
    expect(where).toMatchObject({ logType: 'ADJUSTMENT' });
  });
});

// ===========================================================================
// 4. GET /api/inventory/export — rate limited under "inventory:export"
// ===========================================================================

describe('GET /api/inventory/export rate limiting', () => {
  it('calls enforceRateLimit with the "inventory:export" scope', async () => {
    db.product.findMany.mockResolvedValue([] as any);
    db.location.findMany.mockResolvedValue([] as any);

    const resp = await exportGET(mkReq('http://t/api/inventory/export'));
    expect(resp.status).toBe(200);

    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      'inventory:export',
      expect.objectContaining({ limit: 10 })
    );
  });
});

// ===========================================================================
// 5. passwordHash never leaves the server (MAJOR-2 capstone fix)
//    createInventoryLog is the single source for every mutation-path log row
//    (adjust, stock-in, transfer, batch-adjust all flow through it), so the
//    include shape it sends to prisma IS the leak surface. Pin it to selects.
// ===========================================================================

describe('inventory log relation hygiene (no passwordHash)', () => {
  it('createInventoryLog uses field selects on users/products/locations — no full User row', async () => {
    db.inventory_logs.create.mockResolvedValue({} as any);

    await createInventoryLog({ userId: 7, productId: 2, locationId: 3, delta: 5 });

    expect(db.inventory_logs.create).toHaveBeenCalledTimes(1);
    const args = db.inventory_logs.create.mock.calls[0][0] as any;

    // users must be a select (never `true`) and must not name passwordHash
    expect(args.include.users).not.toBe(true);
    expect(args.include.users.select).toMatchObject({ id: true, username: true, email: true });
    expect(JSON.stringify(args.include)).not.toContain('passwordHash');

    // products/locations narrowed the same way (mirrors /api/inventory/logs)
    expect(args.include.products.select).toMatchObject({ id: true, name: true });
    expect(args.include.locations.select).toMatchObject({ id: true, name: true });
  });

  it('GET /api/inventory/product/[id] history query selects relation fields — no users: true', async () => {
    db.product.findFirst.mockResolvedValue({ id: 2, name: 'Widget', deletedAt: null } as any);
    db.location.findUnique.mockResolvedValue({ id: 3, name: 'Main' } as any);
    db.product_locations.findUnique.mockResolvedValue({ quantity: 5 } as any);
    db.inventory_logs.findMany.mockResolvedValue([] as any);

    const resp = await productHistoryGET(
      mkReq('http://t/api/inventory/product/2?locationId=3&limit=1'),
      { params: { id: '2' } } as any
    );
    expect(resp.status).toBe(200);

    const args = db.inventory_logs.findMany.mock.calls[0][0] as any;
    expect(args.include.users).not.toBe(true);
    expect(args.include.users.select).toMatchObject({ id: true, username: true, email: true });
    expect(JSON.stringify(args.include)).not.toContain('passwordHash');
  });
});
