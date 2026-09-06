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


// The products POST/PUT write an audit row inside their transaction; the row is
// not what these pins are about (they read the RESPONSE BODY).
jest.mock('@/lib/change-tracking', () => {
  const actual = jest.requireActual('@/lib/change-tracking');
  return { __esModule: true, ...actual, recordChange: jest.fn(async () => undefined) };
});

// The weekly-report route sends email; stub the whole service.
jest.mock('@/lib/email', () => ({
  __esModule: true,
  emailService: {
    generateWeeklyReportHTML: jest.fn(() => '<html></html>'),
    generateWeeklyReportText: jest.fn(() => 'text'),
    sendEmail: jest.fn(async () => undefined),
  },
}));

import prisma from '@/lib/prisma';
import { requireApproved, requireAdmin } from '@/lib/api-utils';
import { validateCSRFToken } from '@/lib/csrf';

// Route handlers under test
import { GET as metricsGET } from '@/app/api/reports/metrics/route';
import { GET as reorderGET } from '@/app/api/reports/reorder-recommendations/route';
import { GET as weeklyReportGET } from '@/app/api/cron/weekly-report/route';
import { GET as adminProductsGET } from '@/app/api/admin/products/route';
import { GET as lowStockGET } from '@/app/api/reports/low-stock/route';
import { GET as optimizedGET } from '@/app/api/products/optimized/route';
import { GET as productGET, PUT as productPUT, DELETE as productDELETE } from '@/app/api/products/[id]/route';
import { GET as productsGET, POST as productsPOST } from '@/app/api/products/route';
import { GET as variantsGET } from '@/app/api/inventory/variants/route';
import { POST as adminRestorePOST } from '@/app/api/admin/products/[id]/restore/route';
import { GET as adminDeletedGET } from '@/app/api/admin/products/deleted/route';
import { GET as inventoryProductGET } from '@/app/api/inventory/product/[id]/route';
import { GET as currentFastGET } from '@/app/api/inventory/current-fast/route';

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const mockRequireApproved = requireApproved as jest.Mock;
const mockRequireAdmin = requireAdmin as jest.Mock;
const mockValidateCSRF = validateCSRFToken as jest.Mock;

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
// THE WIRE: the RETIRED loc-1 `products.quantity` mirror never ships (pack
// CB2.5b.1, amended B25-FR1/F1 and B25-FR2/FD1-2). ELEVEN routes in all.
//
// FOUR READ routes spread the raw Prisma product row onto the wire beside a
// SEPARATELY computed `currentQuantity` — `/api/products/optimized`,
// `/api/admin/products`, `/api/products/[id]` and `/api/products` (the last one
// through `getProductsWithQuantities`, which spreads at BOTH of its map sites).
// TWO WRITE responses hand the freshly created / updated row straight back:
// POST `/api/products` (201) and PUT `/api/products/[id]` (200).
//
// FOUR MORE (B25-FR2) return the WHOLE row UNSPREAD: DELETE `/api/products/[id]`
// and POST `/api/admin/products/[id]/restore` echo it as `{ message, product }`,
// GET `/api/admin/products/deleted` lists the rows whole, and
// GET `/api/inventory/product/[id]` nests it as `ProductInventoryHistory.product`
// — a shape the `ProductWithQuantity` = `Omit<Product, 'quantity'>` guard never
// reached, so that field is now `Omit<Product, 'quantity'>` too.
//
// The B25-FR2 sweep for `NextResponse.json(...)` bodies derived from a product
// delegate turned up ONE MORE, outside the reviewer's four: GET
// `/api/inventory/current-fast`, whose `CurrentInventoryLevel.product` carries the
// whole row at BOTH of `getCurrentInventoryLevelsFast`'s map sites (the
// `include: { products: true }` join read AND the zero-fill `product.findMany`).
// Its type is narrowed the same way. The LEVEL's own `quantity` — the real one,
// read from `product_locations` — is NOT the mirror and stays.
//
// The column they were leaking is dead (P2-B2.5) and its value is now whatever
// it happened to hold when the last writer stopped — a number that looks
// authoritative and is not. Every site strips the key BEFORE the spread (the
// write responses strip the value handed to `NextResponse.json`; the audit work
// inside the transaction is untouched); the `include` shapes stay, so nothing
// else on the payload moves.
// ===========================================================================

describe('the retired mirror never reaches the wire (pack CB2.5b.1)', () => {
  it('GET /api/products/optimized: no `quantity` at the product root; currentQuantity is the sum', async () => {
    db.product.findMany.mockResolvedValue([
      {
        id: 3,
        name: 'Widget',
        quantity: 949, // the stale mirror value, as a prod row would carry it
        location: 1,
        product_locations: [
          { quantity: 4, locationId: 1 },
          { quantity: 6, locationId: 2 },
        ],
      },
    ] as any);
    db.product.count.mockResolvedValue(1 as any);

    const resp = await optimizedGET(mkReq('http://t/api/products/optimized'));
    expect(resp.status).toBe(200);
    const body = await resp.json();

    expect(body.products).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(body.products[0], 'quantity')).toBe(false);
    // Byte-identical to what the route computed before the strip.
    expect(body.products[0].currentQuantity).toBe(10);
    // The rest of the row is untouched.
    expect(body.products[0]).toMatchObject({ id: 3, name: 'Widget', location: 1 });
  });

  it('GET /api/admin/products: no `quantity` at the product root; currentQuantity is the sum', async () => {
    mockRequireAdmin.mockResolvedValue({ user: ADMIN_USER });
    db.product.findMany.mockResolvedValue([
      {
        id: 3,
        name: 'Widget',
        quantity: 949,
        approvalStatus: 'PENDING_REVIEW',
        createdByUser: { id: 7, username: 'tester', email: 'a@b.c' },
        product_locations: [{ quantity: 4 }, { quantity: 6 }],
      },
    ] as any);

    const resp = await adminProductsGET(mkReq('http://t/api/admin/products'));
    expect(resp.status).toBe(200);
    const body = await resp.json();

    expect(body.products).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(body.products[0], 'quantity')).toBe(false);
    expect(body.products[0].currentQuantity).toBe(10);
    expect(body.products[0]).toMatchObject({ id: 3, name: 'Widget', approvalStatus: 'PENDING_REVIEW' });
  });

  it('GET /api/products/[id]: no `quantity` at the root; currentQuantity is location 1s row', async () => {
    mockRequireApproved.mockResolvedValue({ user: APPROVED_USER });
    db.product.findFirst.mockResolvedValue({
      id: 3,
      name: 'Widget',
      quantity: 949,
      reorderConfig: null,
      inventory_logs: [],
    } as any);
    db.location.findFirst.mockResolvedValue({ id: 1, name: 'Warehouse' } as any);
    db.product_locations.findUnique.mockResolvedValue({ quantity: 4 } as any);

    const resp = await productGET(mkReq('http://t/api/products/3'), { params: { id: '3' } });
    expect(resp.status).toBe(200);
    const body = await resp.json();

    expect(Object.prototype.hasOwnProperty.call(body, 'quantity')).toBe(false);
    expect(body.currentQuantity).toBe(4);
    expect(body).toMatchObject({ id: 3, name: 'Widget' });
  });

  it('GET /api/products: no `quantity` at the product root; currentQuantity is the sum', async () => {
    mockRequireApproved.mockResolvedValue({ user: APPROVED_USER });
    db.product.count.mockResolvedValue(1 as any);
    db.product.findMany.mockResolvedValue([
      { id: 3, name: 'Widget', quantity: 949, location: 1 },
    ] as any);
    // getProductsWithQuantities -> getBulkTotalQuantities reads product_locations.
    db.product_locations.findMany.mockResolvedValue([
      { productId: 3, quantity: 4 },
      { productId: 3, quantity: 6 },
    ] as any);

    const resp = await productsGET(mkReq('http://t/api/products'));
    expect(resp.status).toBe(200);
    const body = await resp.json();

    expect(body.products).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(body.products[0], 'quantity')).toBe(false);
    // Byte-identical to what the helper computed before the strip.
    expect(body.products[0].currentQuantity).toBe(10);
    expect(body.products[0]).toMatchObject({ id: 3, name: 'Widget', location: 1 });
  });

  it('GET /api/products?locationId: the location-specific map site strips it too', async () => {
    mockRequireApproved.mockResolvedValue({ user: APPROVED_USER });
    db.product.count.mockResolvedValue(1 as any);
    db.product.findMany.mockResolvedValue([
      { id: 3, name: 'Widget', quantity: 949, location: 1 },
    ] as any);
    // getBulkCurrentQuantities: the SAME delegate, scoped to one location.
    db.product_locations.findMany.mockResolvedValue([{ productId: 3, quantity: 4 }] as any);

    const resp = await productsGET(mkReq('http://t/api/products?locationId=2'));
    expect(resp.status).toBe(200);
    const body = await resp.json();

    expect(body.products).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(body.products[0], 'quantity')).toBe(false);
    expect(body.products[0].currentQuantity).toBe(4);
    expect(body.products[0]).toMatchObject({ id: 3, name: 'Widget' });
  });

  it('POST /api/products: the 201 body carries no `quantity` at the root', async () => {
    mockRequireApproved.mockResolvedValue({ user: ADMIN_USER });
    // isProductUnique -> no clash.
    db.product.findFirst.mockResolvedValue(null as any);
    db.location.findUnique.mockResolvedValue({ id: 1, name: 'Warehouse' } as any);
    db.product.create.mockResolvedValue({
      id: 3,
      name: 'Test A',
      baseName: 'Test',
      variant: 'A',
      quantity: 0, // the schema default the dead column still carries
      location: 1,
    } as any);
    db.$transaction.mockImplementation(async (cb: any) => cb(db));

    const resp = await productsPOST(
      mkReq('http://t/api/products', {
        method: 'POST',
        body: JSON.stringify({ baseName: 'Test', variant: 'A' }),
      })
    );
    expect(resp.status).toBe(201);
    const body = await resp.json();

    expect(Object.prototype.hasOwnProperty.call(body, 'quantity')).toBe(false);
    expect(body).toMatchObject({ id: 3, name: 'Test A' });
  });

  it('PUT /api/products/[id]: the 200 body carries no `quantity` at the root', async () => {
    mockRequireApproved.mockResolvedValue({ user: ADMIN_USER });
    db.product.findUnique.mockResolvedValue({
      id: 3,
      name: 'Widget',
      baseName: 'Widget',
      variant: 'A',
      unit: null,
      numericValue: null,
      quantity: 949,
      costPrice: null,
      retailPrice: null,
      lowStockThreshold: null,
      createdBy: ADMIN_USER.id,
      approvalStatus: 'APPROVED',
      deletedAt: null,
      reorderConfig: null,
    } as any);
    db.product.update.mockResolvedValue({
      id: 3,
      name: 'Widget',
      baseName: 'Widget',
      variant: 'A',
      quantity: 949, // the stale mirror the update echoes back
      location: 1,
    } as any);
    db.$transaction.mockImplementation(async (cb: any) => cb(db));

    const resp = await productPUT(
      mkReq('http://t/api/products/3', {
        method: 'PUT',
        body: JSON.stringify({ lowStockThreshold: 12 }),
      }),
      { params: { id: '3' } }
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();

    expect(Object.prototype.hasOwnProperty.call(body, 'quantity')).toBe(false);
    expect(body).toMatchObject({ id: 3, name: 'Widget' });
  });

  it('DELETE /api/products/[id]: the echoed `product` carries no `quantity`', async () => {
    mockRequireAdmin.mockResolvedValue({ user: ADMIN_USER });
    db.product.findUnique.mockResolvedValue({ id: 3, name: 'Widget', deletedAt: null } as any);
    db.product_locations.findMany.mockResolvedValue([] as any);
    db.product.update.mockResolvedValue({
      id: 3,
      name: 'Widget',
      quantity: 949, // the stale mirror the soft-delete echoes back
      deletedAt: new Date('2026-01-01T00:00:00.000Z'),
    } as any);
    db.$transaction.mockImplementation(async (cb: any) => cb(db));

    const resp = await productDELETE(mkReq('http://t/api/products/3', { method: 'DELETE' }), {
      params: { id: '3' },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();

    expect(Object.prototype.hasOwnProperty.call(body.product, 'quantity')).toBe(false);
    expect(body.message).toBe('Product deleted successfully');
    // The rest of the echoed row is untouched.
    expect(body.product).toMatchObject({ id: 3, name: 'Widget' });
  });

  it('POST /api/admin/products/[id]/restore: the echoed `product` carries no `quantity`', async () => {
    mockRequireAdmin.mockResolvedValue({ user: ADMIN_USER });
    db.product.findUnique.mockResolvedValue({
      id: 3,
      name: 'Widget',
      deletedAt: new Date('2026-01-01T00:00:00.000Z'),
    } as any);
    db.product_locations.findMany.mockResolvedValue([] as any);
    db.product.update.mockResolvedValue({
      id: 3,
      name: 'Widget',
      quantity: 949, // the stale mirror the restore echoes back
      deletedAt: null,
    } as any);
    db.$transaction.mockImplementation(async (cb: any) => cb(db));

    const resp = await adminRestorePOST(
      mkReq('http://t/api/admin/products/3/restore', { method: 'POST' }),
      { params: { id: '3' } }
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();

    expect(Object.prototype.hasOwnProperty.call(body.product, 'quantity')).toBe(false);
    expect(body.message).toBe('Product restored successfully');
    expect(body.product).toMatchObject({ id: 3, name: 'Widget' });
  });

  it('GET /api/admin/products/deleted: no `quantity` on any listed row', async () => {
    mockRequireAdmin.mockResolvedValue({ user: ADMIN_USER });
    db.product.findMany.mockResolvedValue([
      {
        id: 3,
        name: 'Widget',
        quantity: 949,
        deletedAt: new Date('2026-01-01T00:00:00.000Z'),
        deletedByUser: { id: 1, username: 'admin', email: 'a@b.c' },
      },
    ] as any);

    const resp = await adminDeletedGET(mkReq('http://t/api/admin/products/deleted'));
    expect(resp.status).toBe(200);
    const body = await resp.json();

    expect(body.products).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(body.products[0], 'quantity')).toBe(false);
    // The `include`d relation rides along untouched.
    expect(body.products[0]).toMatchObject({
      id: 3,
      name: 'Widget',
      deletedByUser: { id: 1, username: 'admin', email: 'a@b.c' },
    });
  });

  it('GET /api/inventory/product/[id]: the nested `product` carries no `quantity`', async () => {
    mockRequireApproved.mockResolvedValue({ user: APPROVED_USER });
    db.product.findFirst.mockResolvedValue({ id: 3, name: 'Widget', quantity: 949 } as any);
    db.location.findFirst.mockResolvedValue({ id: 1, name: 'Warehouse' } as any);
    db.product_locations.findUnique.mockResolvedValue({ quantity: 4 } as any);
    db.inventory_logs.findMany.mockResolvedValue([] as any);

    const resp = await inventoryProductGET(mkReq('http://t/api/inventory/product/3'), {
      params: { id: '3' },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();

    expect(Object.prototype.hasOwnProperty.call(body.product, 'quantity')).toBe(false);
    expect(body.currentQuantity).toBe(4);
    expect(body.product).toMatchObject({ id: 3, name: 'Widget' });
    expect(body.location).toMatchObject({ id: 1, name: 'Warehouse' });
  });

  it('GET /api/inventory/current-fast: no `quantity` on either nested `product` (both map sites)', async () => {
    mockRequireApproved.mockResolvedValue({ user: APPROVED_USER });
    // Map site 1 — the join read hands the product row over whole.
    db.product_locations.findMany.mockResolvedValue([
      {
        productId: 3,
        locationId: 1,
        quantity: 4,
        version: 2,
        products: { id: 3, name: 'Widget', quantity: 949 },
        locations: { id: 1, name: 'Warehouse' },
      },
    ] as any);
    // Map site 2 — the zero-fill branch reads the product delegate directly.
    db.product.findMany.mockResolvedValue([{ id: 9, name: 'Gadget', quantity: 949 }] as any);
    db.location.findUnique.mockResolvedValue({ id: 1, name: 'Warehouse' } as any);

    const resp = await currentFastGET(mkReq('http://t/api/inventory/current-fast?locationId=1'));
    expect(resp.status).toBe(200);
    const body = await resp.json();

    expect(body.inventory).toHaveLength(2);
    for (const level of body.inventory) {
      expect(Object.prototype.hasOwnProperty.call(level.product, 'quantity')).toBe(false);
    }
    // The LEVEL's own quantity (from product_locations) is the real number and stays.
    expect(body.inventory[0]).toMatchObject({ productId: 3, quantity: 4 });
    expect(body.inventory[0].product).toMatchObject({ id: 3, name: 'Widget' });
    expect(body.inventory[1]).toMatchObject({ productId: 9, quantity: 0 });
    expect(body.inventory[1].product).toMatchObject({ id: 9, name: 'Gadget' });
  });
});
