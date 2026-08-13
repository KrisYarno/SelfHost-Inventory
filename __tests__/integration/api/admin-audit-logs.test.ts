// @jest-environment node
//
// Task 5 regression suite (eng-review iron rule, plan §Task 5): after the read
// path flipped from lib/audit.ts (auditService, entityId: number) to
// lib/change-tracking.ts (plain functions, entityId: string), the audit-logs
// route MUST (a) return previously-written rows unchanged in shape — including
// numeric-STRING entityIds written before the migration — and (b) accept BOTH
// `?entityId=42` and `?entityId=<cuid>` filters.
import { NextRequest } from 'next/server';

// Keep the REAL apiHandler (so ZodError -> 400 and AppError -> its status get
// mapped centrally), but stub the auth guard.
jest.mock('@/lib/api-utils', () => {
  const actual = jest.requireActual('@/lib/api-utils');
  return {
    __esModule: true,
    ...actual,
    requireAdmin: jest.fn(),
  };
});

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    auditLog: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));

jest.mock('@/lib/csrf', () => ({
  validateCSRFToken: jest.fn(async () => true),
}));

jest.mock('@/lib/rateLimit', () => ({
  __esModule: true,
  RateLimitError: jest.requireActual('@/lib/rateLimit').RateLimitError,
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((resp: any) => resp),
}));

// api-utils re-exports OptimisticLockError from the inventory graph; stub the
// rest so importing the route doesn't pull real inventory code.
jest.mock('@/lib/inventory', () => ({
  __esModule: true,
  OptimisticLockError: jest.requireActual('@/lib/inventory').OptimisticLockError,
}));

// lib/change-tracking imports next/headers at module top; the read functions
// never call it, but keep the import inert under jest's node environment.
jest.mock('next/headers', () => ({
  headers: jest.fn(async () => ({ get: () => null })),
}));

import { GET as auditLogsGET } from '@/app/api/admin/audit-logs/route';
import { requireAdmin } from '@/lib/api-utils';
import prisma from '@/lib/prisma';

const db: any = prisma as any;

const ADMIN_USER = { id: 1, isAdmin: true, isApproved: true };

// A row written BEFORE the string-entityId migration: its entityId was a
// numeric FK rendered to the string "42" by the VARCHAR(64) column. The read
// path must hand it back verbatim.
const LEGACY_ROW = {
  id: 101,
  userId: 7,
  actorKind: 'USER',
  companyId: null,
  actionType: 'PRODUCT_UPDATE',
  entityType: 'PRODUCT',
  entityId: '42',
  batchId: null,
  action: 'Updated product "BPC 5mg"',
  details: { productName: 'BPC 5mg' },
  ipAddress: '127.0.0.1',
  userAgent: 'jest',
  affectedCount: 1,
  createdAt: new Date('2026-06-01T12:00:00.000Z'),
  user: { id: 7, username: 'kris', email: 'kris@example.com' },
};

const CUID = 'cmcy1x2z90000abcd1234efgh';

function mkGet(query = '') {
  return new NextRequest(`http://t/api/admin/audit-logs${query}`, { method: 'GET' });
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireAdmin as jest.Mock).mockResolvedValue({ user: ADMIN_USER });
  db.auditLog.findMany.mockResolvedValue([LEGACY_ROW]);
  db.auditLog.count.mockResolvedValue(1);
});

describe('GET /api/admin/audit-logs (read path via lib/change-tracking)', () => {
  it('returns previously-written rows unchanged in shape (numeric-string entityId renders)', async () => {
    const resp = await auditLogsGET(mkGet(), undefined as any);
    expect(resp.status).toBe(200);

    const body = await (resp as Response).json();
    expect(body.total).toBe(1);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(body.logs).toHaveLength(1);
    // Row shape is byte-for-byte what the query returned (dates JSON-serialized).
    expect(body.logs[0]).toEqual({
      ...LEGACY_ROW,
      createdAt: LEGACY_ROW.createdAt.toISOString(),
    });
    // The load-bearing assertion: the pre-migration numeric id is the STRING "42".
    expect(body.logs[0].entityId).toBe('42');
  });

  it('preserves the lib/audit.ts query shape: user include, desc order, default paging', async () => {
    await auditLogsGET(mkGet(), undefined as any);

    expect(db.auditLog.findMany).toHaveBeenCalledWith({
      where: {},
      include: { user: { select: { id: true, username: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      skip: 0,
    });
    expect(db.auditLog.count).toHaveBeenCalledWith({ where: {} });
  });

  it('accepts ?entityId=42 (numeric-string) and filters on the string form', async () => {
    const resp = await auditLogsGET(mkGet('?entityId=42'), undefined as any);
    expect(resp.status).toBe(200);

    const where = db.auditLog.findMany.mock.calls[0][0].where;
    expect(where.entityId).toBe('42');
    expect(db.auditLog.count).toHaveBeenCalledWith({ where });
  });

  it('accepts ?entityId=<cuid> and filters on it verbatim', async () => {
    const resp = await auditLogsGET(mkGet(`?entityId=${CUID}`), undefined as any);
    expect(resp.status).toBe(200);

    const where = db.auditLog.findMany.mock.calls[0][0].where;
    expect(where.entityId).toBe(CUID);
  });

  it('trims surrounding whitespace from entityId before filtering', async () => {
    const resp = await auditLogsGET(mkGet('?entityId=%20%2042%20'), undefined as any);
    expect(resp.status).toBe(200);

    const where = db.auditLog.findMany.mock.calls[0][0].where;
    expect(where.entityId).toBe('42');
  });

  it('rejects an empty/whitespace-only entityId with 400 (no query runs)', async () => {
    for (const query of ['?entityId=', '?entityId=%20%20']) {
      db.auditLog.findMany.mockClear();
      const resp = await auditLogsGET(mkGet(query), undefined as any);
      expect(resp.status).toBe(400);
      const body = await (resp as Response).json();
      expect(body.error).toBe('Invalid query parameters');
      expect(db.auditLog.findMany).not.toHaveBeenCalled();
    }
  });

  it('omits entityId from the where clause when the filter is absent', async () => {
    await auditLogsGET(mkGet('?actionType=PRODUCT_UPDATE'), undefined as any);

    const where = db.auditLog.findMany.mock.calls[0][0].where;
    expect('entityId' in where).toBe(false);
    expect(where.actionType).toBe('PRODUCT_UPDATE');
  });

  // W1-2b ride-along: ALL_ACTION_TYPES is this route's actionType allowlist, and
  // it was built from a union the source parser truncated — so filtering the
  // feed by a REAL, emitted Lane 4 action answered 400 "Unknown actionType".
  it.each(['AI_PROVIDER_CREATE', 'AI_PROVIDER_UPDATE', 'API_TOKEN_CREATE', 'API_TOKEN_REVOKE'])(
    'accepts ?actionType=%s (was a 400 while the union parse truncated)',
    async (actionType) => {
      const resp = await auditLogsGET(mkGet(`?actionType=${actionType}`), undefined as any);

      expect((resp as Response).status).toBe(200);
      expect(db.auditLog.findMany.mock.calls[0][0].where.actionType).toBe(actionType);
    },
  );

  it('accepts ?actionType=STAGING_RECOUNT (the W1-2b count verb)', async () => {
    const resp = await auditLogsGET(mkGet('?actionType=STAGING_RECOUNT'), undefined as any);

    expect((resp as Response).status).toBe(200);
    expect(db.auditLog.findMany.mock.calls[0][0].where.actionType).toBe('STAGING_RECOUNT');
  });
});
