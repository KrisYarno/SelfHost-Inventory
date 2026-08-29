/**
 * @jest-environment node
 *
 * THE THREE R-B READ ROUTES (reconciliation lane, pack C2a.5; spec REV-7 §5).
 *
 *   GET /api/reconciliation/attribution            -> the AttributionReport envelope
 *   GET /api/reconciliation/attribution/[batchId]  -> the BatchDetail envelope, or 404
 *   GET /api/reconciliation/orders/search          -> { orders, moreCount }
 *
 * The REAL producer runs against a mocked Prisma, so these pins cover the HTTP
 * surface AND the seam between it and `lib/reconciliation/attribution.ts`: the
 * envelope keys, the four 400s the pack names, the 404 body, and the fact that
 * every one of them is admin-guarded and dynamic.
 */

jest.mock('@/lib/api-utils', () => ({
  __esModule: true,
  ...jest.requireActual('@/lib/api-utils'),
  requireAdmin: jest.fn(() => Promise.resolve({ user: { id: 1, isAdmin: true } })),
}));

jest.mock('@/lib/prisma', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockDeep } = require('jest-mock-extended');
  return { __esModule: true, default: mockDeep() };
});

import { NextRequest } from 'next/server';
import { mockReset, type DeepMockProxy } from 'jest-mock-extended';
import type { Prisma, PrismaClient } from '@prisma/client';
import prisma from '@/lib/prisma';
import { requireAdmin } from '@/lib/api-utils';
import { __resetForTests } from '@/lib/reconciliation/attribution';
import { MAX_MATCH_ORDERS } from '@/lib/reconciliation/match-producer';
import { GET as reportGET, dynamic as reportDynamic } from '@/app/api/reconciliation/attribution/route';
import {
  GET as detailGET,
  dynamic as detailDynamic,
} from '@/app/api/reconciliation/attribution/[batchId]/route';
import {
  GET as searchGET,
  dynamic as searchDynamic,
} from '@/app/api/reconciliation/orders/search/route';

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const mockRequireAdmin = requireAdmin as jest.Mock;

function summaryRow(over: Record<string, unknown> = {}) {
  return {
    nonAttributableBatches: 0,
    noBatchRows: 0,
    orderNumberMatches: 0,
    batchId: 'batch-1',
    minChangeTime: new Date('2026-08-10T12:00:00.000Z'),
    rowCount: 2,
    units: 5,
    productCount: 2,
    logTypes: 'SALE',
    distinctStamps: 1,
    firstStamp: 'ord-1',
    lastStamp: 'ord-1',
    unstampedRows: 0,
    auditId: null,
    auditActionType: null,
    auditEntityId: null,
    auditOrderAttributionSource: null,
    auditIntent: null,
    auditSelectedExternalOrderId: null,
    auditOrderId: null,
    auditHasOrderReference: 0,
    auditHasRows: 0,
    auditHasRowsOmitted: 0,
    attemptId: 10,
    attemptOutcome: 'attributed',
    attemptEvidence: 'selected',
    attemptReason: null,
    attemptSource: 'live-deduct',
    attemptActorUserId: 7,
    attemptOrderRecordId: 'ord-1',
    ...over,
  };
}

const ORDER = {
  id: 'ord-1',
  orderNumber: '#1001',
  internalStatus: 'pending',
  externalCreatedAt: new Date('2026-08-09T00:00:00.000Z'),
  companyId: 'co-1',
  integration: { platform: 'WOOCOMMERCE' },
};

function reportRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/reconciliation/attribution?${query}`);
}

/**
 * ONE raw channel, TWO statements (Part 2 A2, pack CA2.3): the batch summary and
 * the match's deducted-side aggregate, told apart by the builder's own alias.
 * Feeding summary rows to the matcher is a fixture bug, not a producer that
 * should tolerate them.
 */
function mockSummary(rows: unknown[]): void {
  db.$queryRaw.mockImplementation(((query: Prisma.Sql) =>
    Promise.resolve(query.sql.includes('AS outUnits') ? [] : rows)) as never);
}

beforeEach(() => {
  mockReset(db);
  __resetForTests();
  mockRequireAdmin.mockClear();
  mockRequireAdmin.mockResolvedValue({ user: { id: 1, isAdmin: true } });
  mockSummary([summaryRow()]);
  db.orderAttributionAttempt.findFirst.mockResolvedValue(null as never);
  db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);
  db.externalOrder.findMany.mockResolvedValue([ORDER] as never);
  // The match producer's two delegate reads (A2): empty by default, so a
  // fixture that says nothing about the match still answers.
  db.externalOrderItem.findMany.mockResolvedValue([] as never);
  db.product.findMany.mockResolvedValue([] as never);
  db.$transaction.mockImplementation(((ops: unknown) =>
    Promise.all(ops as Promise<unknown>[])) as never);
});

describe('GET /api/reconciliation/attribution', () => {
  it('is dynamic and admin-guarded', async () => {
    expect(reportDynamic).toBe('force-dynamic');
    await reportGET(reportRequest('from=2026-08-01&to=2026-08-31'));
    expect(mockRequireAdmin).toHaveBeenCalledTimes(1);
  });

  it('serves the AttributionReport envelope verbatim', async () => {
    const res = await reportGET(reportRequest('from=2026-08-01&to=2026-08-31'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Object.keys(body).sort()).toEqual(
      [
        'coverage',
        'count',
        'definitions',
        // Part 2 A2 (pack CA2.2 / spec §5): the page's matches ride the envelope.
        'matches',
        'moreCount',
        'nextCursor',
        'rows',
        'totals',
        'window',
      ].sort(),
    );
    expect(body.window).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(body.rows[0]).toMatchObject({
      batchId: 'batch-1',
      how: { classKey: 'attributed·selected' },
      order: { orderNumber: '#1001' },
      actor: { id: 7, username: 'kris' },
      fulfillmentTargetMissing: false,
    });
    expect(body.coverage.orderFilterScope).toBe('all orders');
    expect(body.count).toBe(1);
    expect(body.moreCount).toBe(0);
    expect(body.nextCursor).toBeNull();
  });

  // CR-1: a deleted R2b target, on the wire. The report's own batched order
  // lookup is what knows, so the row arrives with the fact and without the lock.
  it('a deleted R2b target reaches the client as a stated fact, never as a lock', async () => {
    mockSummary([
      summaryRow({
        distinctStamps: 0,
        firstStamp: null,
        lastStamp: null,
        unstampedRows: 2,
        attemptId: null,
        attemptOutcome: null,
        attemptEvidence: null,
        attemptSource: null,
        attemptActorUserId: null,
        attemptOrderRecordId: null,
        auditId: 6,
        auditActionType: 'EXTERNAL_ORDER_FULFILLMENT',
        auditEntityId: 'ord-gone',
      }),
    ]);
    db.externalOrder.findMany.mockResolvedValue([] as never);

    const res = await reportGET(reportRequest('from=2026-08-01&to=2026-08-31'));
    const body = await res.json();

    expect(body.rows[0].fulfillmentTargetMissing).toBe(true);
    expect(body.rows[0].canAttribute).toBe(false);
    expect(body.rows[0].attributeLock).toBeNull();
    expect(typeof body.definitions.fulfillmentTargetMissing).toBe('string');
  });

  it('400s when `from` is after `to`', async () => {
    const res = await reportGET(reportRequest('from=2026-08-31&to=2026-08-01'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('`to` must not be before `from`');
  });

  it('400s on a window wider than 366 days', async () => {
    const res = await reportGET(reportRequest('from=2025-01-01&to=2026-08-31'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('the window may span at most 366 days');
  });

  // ONE BOUND (G2-11): the schema's max IS `MAX_MATCH_ORDERS`, so the largest
  // page the route accepts is the largest page the match producer will read. A
  // route bound above the producer's meant a valid request answering 500.
  it('400s one past MAX_MATCH_ORDERS, and accepts exactly MAX_MATCH_ORDERS', async () => {
    const over = await reportGET(
      reportRequest(`from=2026-08-01&to=2026-08-31&limit=${MAX_MATCH_ORDERS + 1}`),
    );
    expect(over.status).toBe(400);

    const at = await reportGET(
      reportRequest(`from=2026-08-01&to=2026-08-31&limit=${MAX_MATCH_ORDERS}`),
    );
    expect(at.status).toBe(200);
  });

  it('400s on a cursor it did not mint', async () => {
    const res = await reportGET(reportRequest('from=2026-08-01&to=2026-08-31&cursor=zzz'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid cursor');
  });

  it('400s on a class outside the closed vocabulary', async () => {
    const res = await reportGET(reportRequest('from=2026-08-01&to=2026-08-31&class=made-up'));
    expect(res.status).toBe(400);
  });

  it('400s on a day key that is not a real calendar day', async () => {
    const res = await reportGET(reportRequest('from=2026-02-30&to=2026-08-31'));
    expect(res.status).toBe(400);
  });

  it('passes the class chip, the order number, the bound and the cursor through', async () => {
    mockSummary([
      summaryRow({ batchId: 'a', minChangeTime: new Date('2026-08-12T12:00:00.000Z') }),
      summaryRow({ batchId: 'b', minChangeTime: new Date('2026-08-11T12:00:00.000Z') }),
    ]);

    const first = await reportGET(
      reportRequest(
        'from=2026-08-01&to=2026-08-31&class=attributed%C2%B7selected&orderNumber=%231001&limit=1',
      ),
    );
    const firstBody = await first.json();
    expect(firstBody.rows.map((r: { batchId: string }) => r.batchId)).toEqual(['a']);
    expect(firstBody.moreCount).toBe(1);
    expect((db.$queryRaw.mock.calls[0][0] as unknown as { values: unknown[] }).values).toContain(
      '#1001',
    );

    mockSummary([
      summaryRow({ batchId: 'a', minChangeTime: new Date('2026-08-12T12:00:00.000Z') }),
      summaryRow({ batchId: 'b', minChangeTime: new Date('2026-08-11T12:00:00.000Z') }),
    ]);
    const second = await reportGET(
      reportRequest(
        `from=2026-08-01&to=2026-08-31&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      ),
    );
    const secondBody = await second.json();
    expect(secondBody.rows.map((r: { batchId: string }) => r.batchId)).toEqual(['b']);
    expect(secondBody.moreCount).toBe(0);
  });
});

describe('GET /api/reconciliation/attribution/[batchId]', () => {
  beforeEach(() => {
    db.inventory_logs.findMany.mockResolvedValue([
      {
        id: 501,
        productId: 9,
        delta: -5,
        logType: 'SALE',
        changeTime: new Date('2026-08-10T12:00:00.000Z'),
        orderRecordId: 'ord-1',
        products: { name: 'Widget' },
      },
    ] as never);
    db.auditLog.findMany.mockResolvedValue([] as never);
    db.orderAttributionAttempt.findMany.mockResolvedValue([] as never);
  });

  it('is dynamic and admin-guarded', async () => {
    expect(detailDynamic).toBe('force-dynamic');
    await detailGET(new NextRequest('http://localhost/api/reconciliation/attribution/batch-1'), {
      params: { batchId: 'batch-1' },
    });
    expect(mockRequireAdmin).toHaveBeenCalledTimes(1);
  });

  it('serves the BatchDetail envelope', async () => {
    const res = await detailGET(
      new NextRequest('http://localhost/api/reconciliation/attribution/batch-1'),
      { params: { batchId: 'batch-1' } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // `ledgerRowsTruncated` joined the envelope with the bounded ledger read
    // (OC-8): the drill-down list is now a PAGE of the batch, and the flag is
    // what stops a short list being read as a complete one. CR-4 bounded the two
    // APPEND-ONLY histories the same way, so each of those carries the same pair
    // — the flag and the total it is a page of.
    expect(Object.keys(body).sort()).toEqual(
      [
        'attempts',
        'attemptsCount',
        'attemptsTruncated',
        'attributionEvents',
        'attributionEventsCount',
        'attributionEventsTruncated',
        'auditEvent',
        'batch',
        'derived',
        'ledgerRows',
        'ledgerRowsTruncated',
        // Part 2 A2 (pack CA2.2): the "This order" panel's pair.
        'orderMatch',
        'orderMatchUnavailable',
      ].sort(),
    );
    expect(body.batch.batchId).toBe('batch-1');
    expect(body.ledgerRows[0].productName).toBe('Widget');
    expect(body.ledgerRowsTruncated).toBe(false);
    expect(body.attemptsTruncated).toBe(false);
    expect(body.attemptsCount).toBe(0);
    expect(body.attributionEventsTruncated).toBe(false);
    expect(body.attributionEventsCount).toBe(0);
  });

  it('404s an unknown batch with the pack envelope', async () => {
    db.inventory_logs.findMany.mockResolvedValue([] as never);
    const res = await detailGET(
      new NextRequest('http://localhost/api/reconciliation/attribution/nope'),
      { params: { batchId: 'nope' } },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown batch', code: 'NOT_FOUND' });
  });

  it('exports the drill-down GET and the manual-attribution POST, and nothing else', async () => {
    // M2a pinned this segment as read-only; M2b landed the POST beside it (pack
    // C2b.3). The pin stays a WHITELIST, so a third verb appearing on the
    // lane's only write surface is still caught here. Its behaviour lives in
    // `reconciliation-attribute.test.ts`.
    const mod = await import('@/app/api/reconciliation/attribution/[batchId]/route');
    expect(Object.keys(mod).sort()).toEqual(['GET', 'POST', 'dynamic']);
  });
});

describe('GET /api/reconciliation/orders/search', () => {
  it('is dynamic and admin-guarded', async () => {
    expect(searchDynamic).toBe('force-dynamic');
    db.externalOrder.count.mockResolvedValue(0 as never);
    db.externalOrder.findMany.mockResolvedValue([] as never);
    await searchGET(new NextRequest('http://localhost/api/reconciliation/orders/search?q=100'));
    expect(mockRequireAdmin).toHaveBeenCalledTimes(1);
  });

  it('serves { orders, moreCount } and says how many it left off', async () => {
    db.externalOrder.count.mockResolvedValue(25 as never);
    db.externalOrder.findMany.mockResolvedValue([{ ...ORDER, _count: { items: 3 } }] as never);

    const res = await searchGET(
      new NextRequest('http://localhost/api/reconciliation/orders/search?q=100'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Object.keys(body).sort()).toEqual(['moreCount', 'orders']);
    expect(body.orders[0]).toEqual({
      id: 'ord-1',
      orderNumber: '#1001',
      platform: 'WOOCOMMERCE',
      internalStatus: 'pending',
      externalCreatedAt: '2026-08-09T00:00:00.000Z',
      itemCount: 3,
    });
    expect(body.moreCount).toBe(24);
  });

  it('an absent or blank q asks the database nothing', async () => {
    const res = await searchGET(
      new NextRequest('http://localhost/api/reconciliation/orders/search?q=%20%20'),
    );
    expect(await res.json()).toEqual({ orders: [], moreCount: 0 });

    const bare = await searchGET(
      new NextRequest('http://localhost/api/reconciliation/orders/search'),
    );
    expect(await bare.json()).toEqual({ orders: [], moreCount: 0 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
