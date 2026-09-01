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
//   5. P2-B1.5b — the batch envelope's `summary`: THREE groupBy aggregates + one
//      COUNT(DISTINCT productId) raw scalar + two dependent lookups, all TOTAL over
//      the batch (never the section page) and never a findMany over the rows.
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
    // groupBy / $queryRaw / the two lookups are what the P2-B1.5b summary calls.
    inventory_logs: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
    user: { findMany: jest.fn() },
    externalOrder: { findMany: jest.fn() },
    $queryRaw: jest.fn(),
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

/**
 * The batch route issues THREE groupBys on the SAME delegate (logType / userId /
 * orderRecordId). One `mockResolvedValue` would hand all three the same rows and
 * every summary expectation would pass for the wrong reason — so the mock
 * DISPATCHES on `args.by[0]`, and each test fills only the groups it cares about.
 */
const groups: { logType: any[]; userId: any[]; orderRecordId: any[] } = {
  logType: [],
  userId: [],
  orderRecordId: [],
};
/** The COUNT(DISTINCT productId) scalar — BigInt, as MySQL really answers it. */
let productCountScalar: Array<{ n: unknown }> = [{ n: BigInt(0) }];

beforeEach(() => {
  jest.clearAllMocks();
  (requireAdmin as jest.Mock).mockResolvedValue({ user: ADMIN_USER });
  db.auditLog.findMany.mockResolvedValue([]);
  db.auditLog.count.mockResolvedValue(0);
  db.inventory_logs.findMany.mockResolvedValue([]);
  db.inventory_logs.count.mockResolvedValue(0);
  groups.logType = [];
  groups.userId = [];
  groups.orderRecordId = [];
  productCountScalar = [{ n: BigInt(0) }];
  db.inventory_logs.groupBy.mockImplementation(async (args: any) => {
    const by = args?.by?.[0] as keyof typeof groups;
    if (by !== 'logType' && by !== 'userId' && by !== 'orderRecordId') {
      throw new Error(`unexpected groupBy by: ${JSON.stringify(args?.by)}`);
    }
    return groups[by];
  });
  db.$queryRaw.mockImplementation(async (q: any) => {
    // Answered by SQL TEXT, so the pin survives a re-worded query only if it is
    // still the distinct-product count.
    const text = String(q?.sql ?? '');
    if (/COUNT\(DISTINCT productId\)/.test(text)) return productCountScalar;
    throw new Error(`unexpected $queryRaw: ${text}`);
  });
  db.user.findMany.mockResolvedValue([]);
  db.externalOrder.findMany.mockResolvedValue([]);
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
    // P2-B1.5b: the allowlist must hold over `summary` too — it names actors and
    // orders, and neither may bring an address, an agent string or an email along.
    db.inventory_logs.count.mockResolvedValue(4);
    groups.logType = [{ logType: 'SALE', _count: { _all: 4 }, _sum: { delta: -4 } }];
    groups.userId = [{ userId: 7 }];
    groups.orderRecordId = [{ orderRecordId: 'ord_1' }];
    productCountScalar = [{ n: BigInt(2) }];
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'derek' }]);
    db.externalOrder.findMany.mockResolvedValue([{ id: 'ord_1', orderNumber: '23716' }]);

    const resp = await batchGET(mkGet(`/api/admin/batch/${BATCH_UUID}`), { params: { batchId: BATCH_UUID } });
    const body = await (resp as Response).json();

    // the lookups are username-only / orderNumber-only.
    expect(db.user.findMany.mock.calls[0][0].select).toEqual({ id: true, username: true });
    expect(db.externalOrder.findMany.mock.calls[0][0].select).toEqual({ id: true, orderNumber: true });
    expect(JSON.stringify(body.summary)).not.toMatch(/ipAddress|userAgent|"email"/);

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
// 5. P2-B1.5b — the batch envelope's `summary` (aggregates only, TOTAL grain)
// ---------------------------------------------------------------------------

describe('GET /api/admin/batch/[batchId] — summary (P2-B1.5b)', () => {
  /** The worked fixture: 4 SALE rows, 2 products, net -4, one actor, one order. */
  function fourRowBatch() {
    db.inventory_logs.count.mockResolvedValue(4);
    groups.logType = [{ logType: 'SALE', _count: { _all: 4 }, _sum: { delta: -4 } }];
    groups.userId = [{ userId: 7 }];
    groups.orderRecordId = [{ orderRecordId: 'ord_1' }];
    productCountScalar = [{ n: BigInt(2) }];
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'derek' }]);
    db.externalOrder.findMany.mockResolvedValue([{ id: 'ord_1', orderNumber: '23716' }]);
  }

  it('builds the summary from aggregates: the 4-row fixture answers the exact object', async () => {
    fourRowBatch();

    const resp = await batchGET(mkGet(`/api/admin/batch/${BATCH_UUID}`), { params: { batchId: BATCH_UUID } });
    expect(resp.status).toBe(200);
    const body = await (resp as Response).json();

    expect(body.summary).toEqual({
      rowCount: 4,
      productCount: 2,
      netUnits: -4,
      logTypes: ['SALE'],
      actors: ['derek'],
      orders: [{ id: 'ord_1', orderNumber: '23716' }],
    });
    // productCount came back through the BigInt coercion, not as a serialized string.
    expect(typeof body.summary.productCount).toBe('number');
  });

  it('the aggregates carry where.batchId and NO take/skip — they describe the TOTAL, not a page', async () => {
    fourRowBatch();
    await batchGET(mkGet(`/api/admin/batch/${BATCH_UUID}?ledgerLimit=1&eventsLimit=1`), {
      params: { batchId: BATCH_UUID },
    });

    const byArg = db.inventory_logs.groupBy.mock.calls.map((c: any[]) => c[0].by[0]);
    expect(byArg.sort()).toEqual(['logType', 'orderRecordId', 'userId']);
    db.inventory_logs.groupBy.mock.calls.forEach((c: any[]) => {
      expect(c[0].where.batchId).toBe(BATCH_UUID);
      expect(c[0].take).toBeUndefined();
      expect(c[0].skip).toBeUndefined();
    });
    // the orderRecordId aggregate excludes the unstamped rows at the DB.
    const orderCall = db.inventory_logs.groupBy.mock.calls.find(
      (c: any[]) => c[0].by[0] === 'orderRecordId'
    );
    expect(orderCall[0].where.orderRecordId).toEqual({ not: null });
    // the scalar is bound to the same batch (parameterized, never interpolated).
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.$queryRaw.mock.calls[0][0].values).toEqual([BATCH_UUID]);
    // and NO extra findMany over the batch's rows was issued for the summary.
    expect(db.inventory_logs.findMany).toHaveBeenCalledTimes(1);
  });

  it('is page-INDEPENDENT: a ledgerLimit=1 request carries the same summary', async () => {
    fourRowBatch();

    const full = await batchGET(mkGet(`/api/admin/batch/${BATCH_UUID}`), { params: { batchId: BATCH_UUID } });
    const fullBody = await (full as Response).json();

    const paged = await batchGET(mkGet(`/api/admin/batch/${BATCH_UUID}?ledgerLimit=1&ledgerOffset=3`), {
      params: { batchId: BATCH_UUID },
    });
    const pagedBody = await (paged as Response).json();

    expect(fullBody.ledgerRows.limit).toBe(50);
    expect(pagedBody.ledgerRows.limit).toBe(1);
    expect(pagedBody.ledgerRows.offset).toBe(3);
    expect(pagedBody.summary).toEqual(fullBody.summary);
  });

  it('an events-only batch answers the TOTAL zero block, with NO lookups issued', async () => {
    db.auditLog.count.mockResolvedValue(1);
    // ledger count 0, every groupBy empty, the scalar 0 (the beforeEach defaults).

    const resp = await batchGET(mkGet(`/api/admin/batch/${BATCH_UUID}`), { params: { batchId: BATCH_UUID } });
    const body = await (resp as Response).json();

    expect(body.summary).toEqual({
      rowCount: 0,
      productCount: 0,
      netUnits: 0,
      logTypes: [],
      actors: [],
      orders: [],
    });
    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(db.externalOrder.findMany).not.toHaveBeenCalled();
  });

  it('a positive-row batch with no order stamps answers orders: [] and issues no order lookup', async () => {
    db.inventory_logs.count.mockResolvedValue(3);
    groups.logType = [{ logType: 'COUNT', _count: { _all: 3 }, _sum: { delta: 6 } }];
    groups.userId = [{ userId: 7 }];
    groups.orderRecordId = [];
    productCountScalar = [{ n: BigInt(3) }];
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'derek' }]);

    const resp = await batchGET(mkGet(`/api/admin/batch/${BATCH_UUID}`), { params: { batchId: BATCH_UUID } });
    const body = await (resp as Response).json();

    expect(body.summary.rowCount).toBe(3);
    expect(body.summary.netUnits).toBe(6);
    expect(body.summary.orders).toEqual([]);
    expect(db.externalOrder.findMany).not.toHaveBeenCalled();
  });

  it('a stamped row whose order was DELETED is omitted — orders: [], never a null entry', async () => {
    fourRowBatch();
    db.externalOrder.findMany.mockResolvedValue([]); // the order row is gone

    const resp = await batchGET(mkGet(`/api/admin/batch/${BATCH_UUID}`), { params: { batchId: BATCH_UUID } });
    const body = await (resp as Response).json();

    // the lookup WAS issued (the ledger still names the id) and came back empty.
    expect(db.externalOrder.findMany).toHaveBeenCalledTimes(1);
    expect(body.summary.orders).toEqual([]);
  });

  it("a MIXED actor fixture reads ['System', 'derek'] under a PLAIN .sort() (code-unit order)", async () => {
    db.inventory_logs.count.mockResolvedValue(2);
    groups.logType = [{ logType: 'CORRECTION', _count: { _all: 2 }, _sum: { delta: 2 } }];
    // one real user + one machine-actor row (null userId).
    groups.userId = [{ userId: 7 }, { userId: null }];
    productCountScalar = [{ n: BigInt(1) }];
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'derek' }]);

    const resp = await batchGET(mkGet(`/api/admin/batch/${BATCH_UUID}`), { params: { batchId: BATCH_UUID } });
    const body = await (resp as Response).json();

    // 'S' (0x53) sorts before 'd' (0x64) by code unit; localeCompare would invert it.
    expect(body.summary.actors).toEqual(['System', 'derek']);
    // the null group never reaches the lookup.
    expect(db.user.findMany.mock.calls[0][0].where.id.in).toEqual([7]);
  });

  it('logTypes are ordered by count desc, then by name', async () => {
    db.inventory_logs.count.mockResolvedValue(6);
    groups.logType = [
      { logType: 'SALE', _count: { _all: 1 }, _sum: { delta: -1 } },
      { logType: 'ADJUSTMENT', _count: { _all: 4 }, _sum: { delta: 4 } },
      { logType: 'CORRECTION', _count: { _all: 1 }, _sum: { delta: 3 } },
    ];
    productCountScalar = [{ n: BigInt(2) }];

    const resp = await batchGET(mkGet(`/api/admin/batch/${BATCH_UUID}`), { params: { batchId: BATCH_UUID } });
    const body = await (resp as Response).json();

    expect(body.summary.logTypes).toEqual(['ADJUSTMENT', 'CORRECTION', 'SALE']);
    // netUnits sums every group's _sum.delta from 0.
    expect(body.summary.netUnits).toBe(6);
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
