// @jest-environment node
/**
 * Read-path isolation REGRESSION MATRIX (Pre-Staging Inventory, Task 16).
 *
 * Task 11 (`__tests__/unit/lib/read-path-isolation.test.ts`) already pins the
 * shared LIB helpers (checkLowStock / checkMinimums / price-sync candidate set /
 * compute-bundle-status), so this file deliberately does NOT re-test those.
 *
 * What this file ADDS is ROUTE-level coverage: the API handlers that query
 * `prisma.product` DIRECTLY (rather than delegating to an already-tested lib
 * helper) must apply the same `approvalStatus: 'APPROVED'` provisional filter
 * on every outward / decision read path — and the SHOW surfaces must NOT apply
 * it (a PENDING_REVIEW product is real stock and stays visible in browse).
 *
 * It also pins the graduate route's concurrency contract end-to-end: two
 * near-simultaneous claims on the same box yield exactly one 200 and one 409,
 * with the AppError(409) surfaced through the REAL apiHandler mapping.
 *
 * Prisma is mocked with jest-mock-extended (no real DB). The real apiHandler is
 * preserved so ZodError -> 400 and AppError -> its status map centrally; only
 * the auth guards / CSRF / rate-limit / audit / email side-effects are stubbed.
 */

import { NextRequest } from 'next/server';
import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

// --- Prisma: deep mock so every model method is a jest.fn() we can assert on.
jest.mock('@/lib/prisma', () => {
  const { mockDeep: md } = require('jest-mock-extended');
  return { __esModule: true, default: md() };
});

// --- Keep the REAL apiHandler (central ZodError->400 / AppError->status / 403
// mapping that these routes lean on); only stub the auth guards.
jest.mock('@/lib/api-utils', () => {
  const actual = jest.requireActual('@/lib/api-utils');
  return {
    __esModule: true,
    ...actual,
    requireApproved: jest.fn(),
    requireAdmin: jest.fn(),
  };
});

// --- Side-effects the routes touch but that are irrelevant to read-path / 409.
jest.mock('@/lib/csrf', () => ({
  validateCSRFToken: jest.fn(async () => true),
}));

jest.mock('@/lib/rateLimit', () => ({
  __esModule: true,
  // Preserve the real class — apiHandler does `instanceof RateLimitError`.
  RateLimitError: jest.requireActual('@/lib/rateLimit').RateLimitError,
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((resp: any) => resp),
}));


// The weekly-report route sends email; stub the whole service.
jest.mock('@/lib/email', () => ({
  __esModule: true,
  emailService: {
    generateWeeklyReportHTML: jest.fn(() => '<html></html>'),
    generateWeeklyReportText: jest.fn(() => 'text'),
    sendEmail: jest.fn(async () => undefined),
  },
}));

// graduateStagingItem is unit-tested in __tests__/unit/lib/staging/graduate.test.ts;
// here we mock it to drive the route's HTTP-level concurrency behavior.
jest.mock('@/lib/staging/graduate', () => ({
  graduateStagingItem: jest.fn(),
}));

import prisma from '@/lib/prisma';
import { requireApproved, requireAdmin } from '@/lib/api-utils';
import { validateCSRFToken } from '@/lib/csrf';
import { graduateStagingItem } from '@/lib/staging/graduate';
import { AppError } from '@/lib/error-handling';

// Route handlers under test
import { GET as metricsGET } from '@/app/api/reports/metrics/route';
import { GET as reorderGET } from '@/app/api/reports/reorder-recommendations/route';
import { GET as weeklyReportGET } from '@/app/api/cron/weekly-report/route';
import { GET as adminProductsGET } from '@/app/api/admin/products/route';
import { GET as lowStockGET } from '@/app/api/reports/low-stock/route';
import { GET as optimizedGET } from '@/app/api/products/optimized/route';
import { GET as variantsGET } from '@/app/api/inventory/variants/route';
import { POST as graduatePOST } from '@/app/api/staging-items/[id]/graduate/route';

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const mockRequireApproved = requireApproved as jest.Mock;
const mockRequireAdmin = requireAdmin as jest.Mock;
const mockValidateCSRF = validateCSRFToken as jest.Mock;
const mockGraduate = graduateStagingItem as jest.Mock;

const APPROVED_USER = {
  id: 7,
  email: 'a@b.c',
  name: 'Tester',
  isAdmin: false,
  isApproved: true,
  defaultLocationId: null,
};
const ADMIN_USER = { ...APPROVED_USER, id: 1, isAdmin: true };

function mkReq(
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> }
) {
  return new NextRequest(url, {
    method: init?.method,
    ...(init?.body !== undefined ? { body: init.body } : {}),
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': 'x',
      ...(init?.headers ?? {}),
    },
  });
}

beforeEach(() => {
  mockReset(db);
  jest.clearAllMocks();
  mockRequireApproved.mockResolvedValue({ user: APPROVED_USER });
  mockRequireAdmin.mockResolvedValue({ user: ADMIN_USER });
  mockValidateCSRF.mockResolvedValue(true);
});

// ===========================================================================
// EXCLUDE routes — handlers that query prisma.product DIRECTLY must carry
// approvalStatus: 'APPROVED' on the where clause. (Routes that merely delegate
// to checkLowStock/etc. are covered by Task 11 and intentionally absent here.)
// ===========================================================================

describe('EXCLUDE route: GET /api/reports/metrics', () => {
  it('counts and lists only APPROVED, non-deleted products', async () => {
    db.product.count.mockResolvedValue(0 as any);
    db.product.findMany.mockResolvedValue([] as any);
    db.product_locations.findMany.mockResolvedValue([] as any);
    db.inventory_logs.groupBy.mockResolvedValue([] as any);
    db.inventory_logs.count.mockResolvedValue(0 as any);
    // B8 (T4): the metrics route now reads stock snapshots for lowStockTrend; stub the new query.
    // aggregate resolves the latest snapshot day first; null skips the trend groupBy entirely.
    db.productStockSnapshot.aggregate.mockResolvedValue({ _max: { dayKey: null } } as any);
    db.productStockSnapshot.groupBy.mockResolvedValue([] as any);

    const resp = await metricsGET(mkReq('http://t/api/reports/metrics'));
    expect(resp.status).toBe(200);

    const countWhere = (db.product.count.mock.calls[0][0] as any).where;
    const findWhere = (db.product.findMany.mock.calls[0][0] as any).where;
    expect(countWhere).toMatchObject({ deletedAt: null, approvalStatus: 'APPROVED' });
    expect(findWhere).toMatchObject({ deletedAt: null, approvalStatus: 'APPROVED' });
  });
});

describe('EXCLUDE route: GET /api/reports/reorder-recommendations', () => {
  it('selects only APPROVED, non-deleted products as reorder candidates', async () => {
    db.product.findMany.mockResolvedValue([] as any);
    db.product_locations.findMany.mockResolvedValue([] as any);
    // The demand-based report seeds/reads the global reorder settings singleton.
    db.globalReorderSettings.upsert.mockResolvedValue({
      id: 1,
      defaultLeadTimeDays: 14,
      defaultSafetyStockDays: 7,
      defaultTargetCoverageMultiple: 2,
      minEvidenceEvents: 3,
      holdingCostRate: '0.2500',
      updatedBy: null,
      updatedAt: new Date(),
    } as any);

    const resp = await reorderGET(
      mkReq('http://t/api/reports/reorder-recommendations')
    );
    expect(resp.status).toBe(200);

    expect(db.product.findMany).toHaveBeenCalledTimes(1);
    const where = (db.product.findMany.mock.calls[0][0] as any).where;
    expect(where).toMatchObject({ deletedAt: null, approvalStatus: 'APPROVED' });
  });
});

describe('EXCLUDE route: GET /api/cron/weekly-report', () => {
  const CRON_SECRET = 'test-cron-secret';

  function cronReq() {
    return mkReq('http://t/api/cron/weekly-report', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
  }

  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET;
  });

  it('the count + low-stock product scan exclude provisional products', async () => {
    db.systemSetting.findUnique.mockResolvedValue({
      key: 'weeklyReportsEnabled',
      value: 'true',
    } as any);
    db.product.count.mockResolvedValue(0 as any);
    db.product_locations.aggregate.mockResolvedValue({ _sum: { quantity: 0 } } as any);
    // first product.findMany = the low-stock scan; second = mover-name hydration
    db.product.findMany.mockResolvedValue([] as any);
    db.inventory_logs.groupBy.mockResolvedValue([] as any);
    db.product_locations.groupBy.mockResolvedValue([] as any);
    db.location.findMany.mockResolvedValue([] as any);
    // at least one opted-in user so the handler runs to completion (200)
    db.user.findMany.mockResolvedValue([
      { email: 'u@x.io', username: 'u' },
    ] as any);

    const resp = await weeklyReportGET(cronReq());
    expect(resp.status).toBe(200);

    const countWhere = (db.product.count.mock.calls[0][0] as any).where;
    expect(countWhere).toMatchObject({ deletedAt: null, approvalStatus: 'APPROVED' });

    // The low-stock scan is the product.findMany that pulls product_locations.
    const scanCall = db.product.findMany.mock.calls.find(
      (c) => (c[0] as any)?.include?.product_locations
    );
    expect(scanCall).toBeDefined();
    expect((scanCall![0] as any).where).toMatchObject({
      deletedAt: null,
      approvalStatus: 'APPROVED',
    });
  });
});

describe('EXCLUDE route: GET /api/admin/products (review queue)', () => {
  it('filters by the approvalStatus query param AND deletedAt: null', async () => {
    db.product.findMany.mockResolvedValue([] as any);

    const resp = await adminProductsGET(
      mkReq('http://t/api/admin/products?approvalStatus=PENDING_REVIEW')
    );
    expect(resp.status).toBe(200);

    const where = (db.product.findMany.mock.calls[0][0] as any).where;
    expect(where).toMatchObject({
      deletedAt: null,
      approvalStatus: 'PENDING_REVIEW',
    });
  });

  it('ignores an invalid approvalStatus param but still scopes to non-deleted', async () => {
    db.product.findMany.mockResolvedValue([] as any);

    const resp = await adminProductsGET(
      mkReq('http://t/api/admin/products?approvalStatus=BOGUS')
    );
    expect(resp.status).toBe(200);

    const where = (db.product.findMany.mock.calls[0][0] as any).where;
    expect(where).toMatchObject({ deletedAt: null });
    expect(where).not.toHaveProperty('approvalStatus');
  });
});

describe('EXCLUDE route: GET /api/reports/low-stock', () => {
  // This route queries prisma.product DIRECTLY (it does NOT delegate to
  // stockChecker.checkLowStock), so its route-level filter is asserted here and
  // is not redundant with Task 11's lib-level checkLowStock test.
  it('scans only APPROVED, non-deleted products for low-stock alerts', async () => {
    db.product.findMany.mockResolvedValue([] as any);
    db.inventory_logs.findMany.mockResolvedValue([] as any);

    const resp = await lowStockGET(mkReq('http://t/api/reports/low-stock'));
    expect(resp.status).toBe(200);

    const where = (db.product.findMany.mock.calls[0][0] as any).where;
    expect(where).toMatchObject({ deletedAt: null, approvalStatus: 'APPROVED' });
  });
});

// ===========================================================================
// SHOW routes — provisional products stay VISIBLE: the where must NOT carry
// approvalStatus (only the soft-delete scope).
// ===========================================================================

describe('SHOW route: GET /api/products/optimized does not exclude provisional', () => {
  it('omits approvalStatus from both findMany and count where clauses', async () => {
    db.product.findMany.mockResolvedValue([] as any);
    db.product.count.mockResolvedValue(0 as any);

    const resp = await optimizedGET(mkReq('http://t/api/products/optimized'));
    expect(resp.status).toBe(200);

    const findWhere = (db.product.findMany.mock.calls[0][0] as any).where;
    const countWhere = (db.product.count.mock.calls[0][0] as any).where;
    expect(findWhere).not.toHaveProperty('approvalStatus');
    expect(countWhere).not.toHaveProperty('approvalStatus');
    expect(findWhere).toMatchObject({ deletedAt: null });
  });
});

describe('SHOW route: GET /api/inventory/variants does not exclude provisional', () => {
  it('omits approvalStatus from both findMany and count where clauses', async () => {
    db.product.findMany.mockResolvedValue([] as any);
    db.product.count.mockResolvedValue(0 as any);

    const resp = await variantsGET(mkReq('http://t/api/inventory/variants'));
    expect(resp.status).toBe(200);

    const findWhere = (db.product.findMany.mock.calls[0][0] as any).where;
    const countWhere = (db.product.count.mock.calls[0][0] as any).where;
    expect(findWhere).not.toHaveProperty('approvalStatus');
    expect(countWhere).not.toHaveProperty('approvalStatus');
    expect(findWhere).toMatchObject({ deletedAt: null });
  });
});

// ===========================================================================
// Concurrency at the route level: two near-simultaneous graduate POSTs on the
// SAME box -> exactly one 200 and one 409. The losing claim's AppError(409)
// (thrown by graduateStagingItem's atomic updateMany count===0 guard) must
// surface as a 409 through the real apiHandler.
// ===========================================================================

describe('CONCURRENCY: POST /api/staging-items/[id]/graduate (same item, two callers)', () => {
  function graduateReq() {
    return mkReq('http://t/api/staging-items/5/graduate', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'existing',
        productId: 100,
        locationId: 1,
      }),
    });
  }

  it('yields exactly one 200 and one 409 when both fire at once', async () => {
    // Simulate the DB-level race: the first claim wins (count:1 -> result),
    // the second sees count:0 inside the lib and throws AppError(409).
    let claimTaken = false;
    mockGraduate.mockImplementation(async () => {
      if (claimTaken) {
        throw new AppError(
          'Item already graduated or discarded',
          'CONFLICT',
          409
        );
      }
      claimTaken = true;
      return {
        productId: 100,
        approvalStatus: 'PENDING_REVIEW',
        locationId: 1,
        countedQuantity: 5,
        bookedQuantity: 5,
      };
    });

    // Fire both near-simultaneously and await together.
    const [r1, r2] = await Promise.all([
      graduatePOST(graduateReq(), { params: { id: '5' } }),
      graduatePOST(graduateReq(), { params: { id: '5' } }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);

    // The lib (the atomic claim) was invoked once per caller.
    expect(mockGraduate).toHaveBeenCalledTimes(2);

    // The 409 body is the conflict message, surfaced via apiHandler's AppError map.
    const conflict = r1.status === 409 ? r1 : r2;
    const body = await conflict.json();
    expect(body.error).toMatch(/already graduated/i);
  });

  it('surfaces the loser as 409 regardless of which Promise settles first', async () => {
    // Deterministic variant: first call resolves, every subsequent call 409s.
    mockGraduate
      .mockResolvedValueOnce({
        productId: 100,
        approvalStatus: 'PENDING_REVIEW',
        locationId: 1,
        countedQuantity: 5,
      })
      .mockRejectedValue(
        new AppError('Item already graduated or discarded', 'CONFLICT', 409)
      );

    const winner = await graduatePOST(graduateReq(), { params: { id: '5' } });
    const loser = await graduatePOST(graduateReq(), { params: { id: '5' } });

    expect(winner.status).toBe(200);
    expect(loser.status).toBe(409);
  });
});
