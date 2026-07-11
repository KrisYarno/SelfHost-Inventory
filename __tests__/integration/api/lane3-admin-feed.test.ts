// @jest-environment node
//
// Lane 3 Task 4 (W2-B) — admin activity feed + batch drill-down + server CSV.
//
// Covers the three REQUIRED gates from the plan:
//   1. audit-logs GET 400 regression — garbage actionType/entityType/actionGroup
//      now 400s (was a SILENT-EMPTY cast into the where clause).
//   2. actionGroup server-side expansion to `actionType: { in: members }` (R-L7).
//   3. GET /api/admin/batch/[batchId] — pagination-param bounds (400), ASC order,
//      strict allowlist (NO ip/userAgent/email), changes via extractChanges.
//   4. GET /api/admin/audit-logs/export — CSV completeness (batchId + stringified
//      changes) + DATA_EXPORT recorded before streaming + 400-before-record.
import { NextRequest } from 'next/server';
import { expandActionGroup } from '@/lib/change-tracking/taxonomy';

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
    auditLog: { findMany: jest.fn(), count: jest.fn() },
    inventory_logs: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn(async (cb: any) => cb({})),
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

jest.mock('@/lib/inventory', () => ({
  __esModule: true,
  OptimisticLockError: jest.requireActual('@/lib/inventory').OptimisticLockError,
}));

jest.mock('next/headers', () => ({
  headers: jest.fn(async () => ({ get: () => null })),
}));

// The export route records a DATA_EXPORT event; mock recordChange so no real DB
// write is attempted. extractChanges / taxonomy live in SEPARATE modules and are
// NOT mocked (they run for real).
jest.mock('@/lib/change-tracking', () => {
  const actual = jest.requireActual('@/lib/change-tracking');
  return {
    __esModule: true,
    ...actual,
    recordChange: jest.fn(async () => undefined),
  };
});

import { GET as auditLogsGET } from '@/app/api/admin/audit-logs/route';
import { GET as batchGET } from '@/app/api/admin/batch/[batchId]/route';
import { GET as exportGET } from '@/app/api/admin/audit-logs/export/route';
import { requireAdmin } from '@/lib/api-utils';
import { recordChange } from '@/lib/change-tracking';
import prisma from '@/lib/prisma';

const db: any = prisma as any;
const ADMIN_USER = { id: 1, isAdmin: true, isApproved: true };
const BATCH_UUID = '11111111-1111-4111-8111-111111111111';

function mkGet(url: string) {
  return new NextRequest(`http://t${url}`, { method: 'GET' });
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireAdmin as jest.Mock).mockResolvedValue({ user: ADMIN_USER });
  db.auditLog.findMany.mockResolvedValue([]);
  db.auditLog.count.mockResolvedValue(0);
  db.inventory_logs.findMany.mockResolvedValue([]);
  db.inventory_logs.count.mockResolvedValue(0);
  db.$transaction.mockImplementation(async (cb: any) => cb({}));
});

// ---------------------------------------------------------------------------
// 1. audit-logs GET validation — 400 regression
// ---------------------------------------------------------------------------

describe('GET /api/admin/audit-logs — validation (400 regression)', () => {
  it('rejects a garbage actionType with 400 (was silent-empty) and runs NO query', async () => {
    const resp = await auditLogsGET(mkGet('/api/admin/audit-logs?actionType=NOT_A_REAL_ACTION'), undefined as any);
    expect(resp.status).toBe(400);
    expect(db.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('rejects a garbage entityType with 400', async () => {
    const resp = await auditLogsGET(mkGet('/api/admin/audit-logs?entityType=WIDGET'), undefined as any);
    expect(resp.status).toBe(400);
    expect(db.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('rejects a garbage actionGroup with 400', async () => {
    const resp = await auditLogsGET(mkGet('/api/admin/audit-logs?actionGroup=NONSENSE'), undefined as any);
    expect(resp.status).toBe(400);
    expect(db.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('accepts a real actionType (PRODUCT_UPDATE) and filters on the scalar', async () => {
    const resp = await auditLogsGET(mkGet('/api/admin/audit-logs?actionType=PRODUCT_UPDATE'), undefined as any);
    expect(resp.status).toBe(200);
    const where = db.auditLog.findMany.mock.calls[0][0].where;
    expect(where.actionType).toBe('PRODUCT_UPDATE');
  });
});

describe('GET /api/admin/audit-logs — actionGroup server-side expansion (R-L7)', () => {
  it('expands actionGroup=PRODUCT to an actionType IN filter over the group members', async () => {
    const resp = await auditLogsGET(mkGet('/api/admin/audit-logs?actionGroup=PRODUCT'), undefined as any);
    expect(resp.status).toBe(200);

    const members = expandActionGroup('PRODUCT');
    expect(members).not.toBeNull();
    const where = db.auditLog.findMany.mock.calls[0][0].where;
    expect(where.actionType).toEqual({ in: members });
    expect(where.actionType.in).toContain('PRODUCT_UPDATE');
    // count uses the same where.
    expect(db.auditLog.count).toHaveBeenCalledWith({ where });
  });

  it('preserves the getAuditLogs query shape (include/order/paging) on the group path', async () => {
    await auditLogsGET(mkGet('/api/admin/audit-logs?actionGroup=INVENTORY'), undefined as any);
    const call = db.auditLog.findMany.mock.calls[0][0];
    expect(call.include).toEqual({ user: { select: { id: true, username: true, email: true } } });
    expect(call.orderBy).toEqual({ createdAt: 'desc' });
    expect(call.take).toBe(50);
    expect(call.skip).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. batch drill-down endpoint
// ---------------------------------------------------------------------------

describe('GET /api/admin/batch/[batchId]', () => {
  const eventRow = {
    id: 5,
    createdAt: new Date('2026-07-10T10:00:00.000Z'),
    actionType: 'INVENTORY_ADJUSTMENT',
    actorKind: 'USER',
    action: 'Adjusted stock',
    details: { changes: { quantity: { from: 5, to: 8 } }, actor: { userId: 1 } },
    entityType: 'INVENTORY',
    entityId: '42',
    affectedCount: 1,
    user: { username: 'kris' },
  };
  const ledgerRow = {
    id: 9,
    changeTime: new Date('2026-07-10T10:00:01.000Z'),
    delta: 3,
    logType: 'ADJUSTMENT',
    reasonCode: 'DAMAGE',
    unitCostCents: 1234,
    transferId: null,
    products: { name: 'BPC 5mg' },
    locations: { name: 'Main' },
    users: { username: 'kris' },
  };

  it('rejects a non-uuid batchId with 400', async () => {
    const resp = await batchGET(mkGet('/api/admin/batch/not-a-uuid'), { params: { batchId: 'not-a-uuid' } });
    expect(resp.status).toBe(400);
    expect(db.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('rejects out-of-bounds pagination params with 400', async () => {
    for (const q of ['?eventsLimit=0', '?eventsLimit=101', '?ledgerLimit=0', '?eventsOffset=-1', '?ledgerOffset=-3']) {
      db.auditLog.findMany.mockClear();
      const resp = await batchGET(mkGet(`/api/admin/batch/${BATCH_UUID}${q}`), { params: { batchId: BATCH_UUID } });
      expect(resp.status).toBe(400);
      expect(db.auditLog.findMany).not.toHaveBeenCalled();
    }
  });

  it('returns events (createdAt ASC) and ledger movements (changeTime ASC) with independent paging', async () => {
    db.auditLog.findMany.mockResolvedValue([eventRow]);
    db.auditLog.count.mockResolvedValue(1);
    db.inventory_logs.findMany.mockResolvedValue([ledgerRow]);
    db.inventory_logs.count.mockResolvedValue(1);

    const resp = await batchGET(
      mkGet(`/api/admin/batch/${BATCH_UUID}?eventsLimit=10&ledgerLimit=20&ledgerOffset=5`),
      { params: { batchId: BATCH_UUID } }
    );
    expect(resp.status).toBe(200);
    const body = await (resp as Response).json();

    expect(body.events.total).toBe(1);
    expect(body.events.limit).toBe(10);
    expect(body.ledgerRows.total).toBe(1);
    expect(body.ledgerRows.limit).toBe(20);
    expect(body.ledgerRows.offset).toBe(5);

    // ASC ordering on both tables.
    expect(db.auditLog.findMany.mock.calls[0][0].orderBy).toEqual([
      { createdAt: 'asc' },
      { id: 'asc' },
    ]);
    expect(db.inventory_logs.findMany.mock.calls[0][0].orderBy).toEqual([
      { changeTime: 'asc' },
      { id: 'asc' },
    ]);

    // changes normalized via extractChanges.
    expect(body.events.items[0].changes).toEqual({ quantity: { from: 5, to: 8 } });
    expect(body.events.items[0].actorName).toBe('kris');
    expect(body.ledgerRows.items[0].productName).toBe('BPC 5mg');
    expect(body.ledgerRows.items[0].reasonCode).toBe('DAMAGE');
  });

  it('never leaks ip/userAgent/email — the select omits them and the payload has no such keys', async () => {
    db.auditLog.findMany.mockResolvedValue([eventRow]);
    db.auditLog.count.mockResolvedValue(1);

    const resp = await batchGET(mkGet(`/api/admin/batch/${BATCH_UUID}`), { params: { batchId: BATCH_UUID } });
    const body = await (resp as Response).json();

    const select = db.auditLog.findMany.mock.calls[0][0].select;
    expect(select.ipAddress).toBeUndefined();
    expect(select.userAgent).toBeUndefined();
    // user select is username-only (no email).
    expect(select.user).toEqual({ select: { username: true } });

    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/ipAddress|userAgent|"email"/);
  });
});

// ---------------------------------------------------------------------------
// 4. server-side CSV export
// ---------------------------------------------------------------------------

describe('GET /api/admin/audit-logs/export', () => {
  const csvRow = {
    id: 1,
    createdAt: new Date('2026-07-10T10:00:00.000Z'),
    actionType: 'INVENTORY_ADJUSTMENT',
    entityType: 'INVENTORY',
    entityId: '42',
    action: 'Adjusted stock',
    affectedCount: 1,
    batchId: BATCH_UUID,
    details: { changes: { quantity: { from: 5, to: 8 } } },
    ipAddress: '127.0.0.1',
    user: { username: 'kris', email: 'kris@example.com' },
  };

  it('streams a CSV including batchId + JSON-stringified changes, and records DATA_EXPORT', async () => {
    db.auditLog.findMany.mockResolvedValue([csvRow]);

    const resp = await exportGET(mkGet('/api/admin/audit-logs/export'), undefined as any);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('Content-Type')).toBe('text/csv');

    const body = await (resp as Response).text();
    expect(body).toContain('Batch ID');
    expect(body).toContain('Changes');
    expect(body).toContain(BATCH_UUID);
    // canonical changes serialized into the cell.
    expect(body).toContain('quantity');
    expect(body).toContain('from');

    // DATA_EXPORT recorded (record-before-stream).
    expect(recordChange as jest.Mock).toHaveBeenCalledTimes(1);
    const recordedEvent = (recordChange as jest.Mock).mock.calls[0][1];
    expect(recordedEvent.actionType).toBe('DATA_EXPORT');
  });

  it('400s on a garbage actionType with NO DATA_EXPORT side effect', async () => {
    const resp = await exportGET(mkGet('/api/admin/audit-logs/export?actionType=BOGUS'), undefined as any);
    expect(resp.status).toBe(400);
    expect(recordChange as jest.Mock).not.toHaveBeenCalled();
    expect(db.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('expands actionGroup for the export where clause', async () => {
    db.auditLog.findMany.mockResolvedValue([]);
    await exportGET(mkGet('/api/admin/audit-logs/export?actionGroup=PRODUCT'), undefined as any);
    const where = db.auditLog.findMany.mock.calls[0][0].where;
    expect(where.actionType).toEqual({ in: expandActionGroup('PRODUCT') });
  });
});
