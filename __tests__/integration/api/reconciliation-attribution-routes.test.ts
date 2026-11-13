/**
 * @jest-environment node
 *
 * THE THREE R-B READ ROUTES (reconciliation lane, pack C2a.5; spec REV-7 §5).
 *
 *   GET /api/reconciliation/attribution            -> the AttributionReport envelope
 *   GET /api/reconciliation/attribution/[batchId]  -> the BatchDetail envelope, or 404
 *   GET /api/reconciliation/orders/search          -> { orders, moreCount, exactCount }
 *
 * The REAL producer runs against a mocked Prisma, so these pins cover the HTTP
 * surface AND the seam between it and `lib/reconciliation/attribution.ts`: the
 * envelope keys, the four 400s the pack names, the 404 body, and the fact that
 * every one of them is dynamic. The report and the drill-down are admin-guarded;
 * the search is NOT since Part 2 B3-1 (pack CB3b-ii.1) — an approved user
 * searches their own companies' orders, an admin searches every order — so its
 * pins drive `requireApproved` with an admin arm and a member arm.
 */

jest.mock('@/lib/api-utils', () => ({
  __esModule: true,
  ...jest.requireActual('@/lib/api-utils'),
  requireAdmin: jest.fn(() => Promise.resolve({ user: { id: 1, isAdmin: true } })),
  requireApproved: jest.fn(() =>
    Promise.resolve({ user: { id: 1, isAdmin: true, isApproved: true } }),
  ),
}));

// The REAL limiter, observed: the search's per-user limit is pinned by its call
// AND by driving it past the limit (the 429), so the spy passes straight through.
jest.mock('@/lib/rateLimit', () => {
  const actual = jest.requireActual('@/lib/rateLimit');
  return { __esModule: true, ...actual, enforceRateLimit: jest.fn(actual.enforceRateLimit) };
});

jest.mock('@/lib/prisma', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockDeep } = require('jest-mock-extended');
  return { __esModule: true, default: mockDeep() };
});

import { NextRequest } from 'next/server';
import { mockReset, type DeepMockProxy } from 'jest-mock-extended';
import type { Prisma, PrismaClient } from '@prisma/client';
import prisma from '@/lib/prisma';
import { requireAdmin, requireApproved } from '@/lib/api-utils';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  NO_COMPANY_MEMBERSHIP_NOTE,
  NO_MEMBER_ORDER_NOTE,
  __resetForTests,
} from '@/lib/reconciliation/attribution';
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
const mockRequireApproved = requireApproved as jest.Mock;
const mockEnforceRateLimit = enforceRateLimit as jest.Mock;

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
  mockRequireApproved.mockClear();
  mockRequireApproved.mockResolvedValue({ user: { id: 1, isAdmin: true, isApproved: true } });
  mockEnforceRateLimit.mockClear();
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
      // Part 2 B2b (pack CB2b.4 / seam S-A6 amended): the fulfilment fact the
      // reverse and the move refuse on, so the drill-down can hide a control
      // the ladder would always refuse.
      fulfilled: false,
    });
    // The envelope pin above covers the TOP LEVEL only, so the ROW shape gets
    // its own exact assertion — a field added to the wire without a pin is a
    // contract nobody agreed to.
    expect(Object.keys(body.rows[0]).sort()).toEqual(
      [
        'actor',
        'at',
        'attributeLock',
        'batchId',
        'canAttribute',
        'fulfilled',
        'fulfilledAgainst',
        'fulfillmentTargetMissing',
        'how',
        'logTypes',
        'match',
        'matchUnavailable',
        'order',
        'productCount',
        'source',
        'units',
      ].sort(),
    );
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
        locationId: 3,
        products: { name: 'Widget' },
        locations: { name: 'Main' },
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

  it('a LEDGER ROW names its location — the two fields the drill-down Move gates on', async () => {
    const res = await detailGET(
      new NextRequest('http://localhost/api/reconciliation/attribution/batch-1'),
      { params: { batchId: 'batch-1' } },
    );
    const body = await res.json();

    // Part 2 (pack CB2c.3): ADDITIVE and NESTED, so the envelope's own
    // `Object.keys` pin above does not move. The row's shape gets its own.
    expect(Object.keys(body.ledgerRows[0]).sort()).toEqual(
      [
        'changeTime',
        'delta',
        'id',
        'locationId',
        'locationName',
        'logType',
        'orderRecordId',
        'productId',
        'productName',
      ].sort(),
    );
    expect(body.ledgerRows[0]).toMatchObject({ locationId: 3, locationName: 'Main' });
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

/** The search URL for a raw query string (already encoded). */
function searchRequest(query = 'q=100'): NextRequest {
  return new NextRequest(`http://localhost/api/reconciliation/orders/search?${query}`);
}

/** An approved user who is NOT an admin; the membership read decides their scope. */
function asMember(companyIds: string[], id = 7): void {
  mockRequireApproved.mockResolvedValue({ user: { id, isAdmin: false, isApproved: true } });
  db.userCompany.findMany.mockResolvedValue(
    companyIds.map((companyId) => ({ companyId })) as never,
  );
}

/** A search row as the search's OWN select returns it (pack § P2-B3-1R, R-a.1). */
const SEARCH_ROW = { ...ORDER, company: { name: 'Acme Store' }, _count: { items: 3 } };

/**
 * What the search's five statements answer, told apart by their `where` (R-a.1):
 * G1 is the equality, G2 the starts-with, G3 the contains; the first count is
 * G1's where and the second the contains. The mock does not apply the where —
 * the producer suite's in-memory book does that — so each group is handed its
 * rows here.
 */
function searchAnswers(
  answers: {
    exact?: unknown[];
    prefix?: unknown[];
    contains?: unknown[];
    exactCount?: number;
    matchCount?: number;
  } = {},
): void {
  const groupOf = (where: { orderNumber: unknown }): 'exact' | 'prefix' | 'contains' => {
    const on = where.orderNumber as string | { startsWith?: string; contains?: string };
    if (typeof on === 'string') return 'exact';
    return on.startsWith !== undefined ? 'prefix' : 'contains';
  };
  db.externalOrder.findMany.mockImplementation(((args: { where: { orderNumber: unknown } }) =>
    Promise.resolve(answers[groupOf(args.where)] ?? [])) as never);
  db.externalOrder.count.mockImplementation(((args: { where: { orderNumber: unknown } }) =>
    Promise.resolve(
      groupOf(args.where) === 'exact' ? (answers.exactCount ?? 0) : (answers.matchCount ?? 0),
    )) as never);
}

/** The `where` of every one of the search's five statements, reads then counts. */
function searchWheres(): unknown[] {
  return [
    ...db.externalOrder.findMany.mock.calls.map((c) => (c[0] as { where?: unknown }).where),
    ...db.externalOrder.count.mock.calls.map((c) => (c[0] as { where?: unknown }).where),
  ];
}

/** The five wheres for `q`, optionally scoped. */
function expectedWheres(q: string, scope?: string[]): unknown[] {
  const s = scope === undefined ? {} : { companyId: { in: scope } };
  return [
    { orderNumber: q, ...s },
    { orderNumber: { startsWith: q }, NOT: { orderNumber: q }, ...s },
    { orderNumber: { contains: q }, NOT: { orderNumber: { startsWith: q } }, ...s },
    { orderNumber: q, ...s },
    { orderNumber: { contains: q }, ...s },
  ];
}

describe('GET /api/reconciliation/orders/search', () => {
  beforeEach(() => {
    searchAnswers();
  });

  it('is dynamic and guarded by APPROVAL, not admin (Part 2 B3-1)', async () => {
    expect(searchDynamic).toBe('force-dynamic');
    await searchGET(searchRequest());
    expect(mockRequireApproved).toHaveBeenCalledTimes(1);
    expect(mockRequireAdmin).not.toHaveBeenCalled();
  });

  it('an admin searches EVERY order: no company scope on any of the five statements, and no membership read', async () => {
    searchAnswers({ exact: [SEARCH_ROW], exactCount: 1, matchCount: 1 });

    const res = await searchGET(searchRequest());
    expect(res.status).toBe(200);

    expect(searchWheres()).toEqual(expectedWheres('100'));
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.userCompany.findMany).not.toHaveBeenCalled();
  });

  it("a member searches their OWN companies' orders — the scope rides ALL FIVE statements", async () => {
    asMember(['co-1', 'co-2']);
    searchAnswers({ exact: [SEARCH_ROW], exactCount: 1, matchCount: 1 });

    const res = await searchGET(searchRequest());
    expect(res.status).toBe(200);

    expect(db.userCompany.findMany).toHaveBeenCalledTimes(1);
    expect(db.userCompany.findMany).toHaveBeenCalledWith({
      where: { userId: 7 },
      select: { companyId: true },
    });
    expect(searchWheres()).toEqual(expectedWheres('100', ['co-1', 'co-2']));

    // A member's NON-empty answer is the plain envelope — no note.
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['exactCount', 'moreCount', 'orders']);
    expect(body.orders).toHaveLength(1);
  });

  it('an approved user with NO memberships gets an empty answer that NAMES why, never a 403 (B3-1 FR1)', async () => {
    asMember([]);

    const res = await searchGET(searchRequest());

    expect(res.status).toBe(200);
    expect(NO_COMPANY_MEMBERSHIP_NOTE).toBe(
      'you are not a member of any company yet, so there are no orders to search — ask an admin to add you',
    );
    expect(await res.json()).toEqual({
      orders: [],
      moreCount: 0,
      exactCount: 0,
      note: 'you are not a member of any company yet, so there are no orders to search — ask an admin to add you',
    });
    // Scoped to nothing — not unscoped.
    expect(searchWheres()).toEqual(expectedWheres('100', []));
  });

  it("a member's EMPTY answer carries the house sentence (pack row 94); an admin's carries none", async () => {
    expect(NO_MEMBER_ORDER_NOTE).toBe('no order matching that number in your companies');

    const admin = await searchGET(searchRequest());
    expect(await admin.json()).toEqual({ orders: [], moreCount: 0, exactCount: 0 });

    asMember(['co-1']);
    const member = await searchGET(searchRequest());
    expect(await member.json()).toEqual({
      orders: [],
      moreCount: 0,
      exactCount: 0,
      note: 'no order matching that number in your companies',
    });
  });

  it('one or more companies and no match keep the house sentence — never the no-company reason (B3-1 FR1)', async () => {
    for (const companies of [['co-1'], ['co-1', 'co-2']]) {
      asMember(companies);
      const body = await (await searchGET(searchRequest())).json();
      expect(body).toEqual({ orders: [], moreCount: 0, exactCount: 0, note: NO_MEMBER_ORDER_NOTE });
      expect(body.note).not.toBe(NO_COMPANY_MEMBERSHIP_NOTE);
    }
  });

  it("a zero-company member's blank q still answers BEFORE the membership read, with no note", async () => {
    asMember([]);

    const blank = await searchGET(searchRequest('q=%20%20'));

    expect(await blank.json()).toEqual({ orders: [], moreCount: 0, exactCount: 0 });
    expect(db.userCompany.findMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('the projection carries no customer field — for a member as for an admin', async () => {
    asMember(['co-1']);
    searchAnswers({
      exact: [
        {
          ...SEARCH_ROW,
          // What a widened select WOULD hand back; the projection must drop it.
          customerEmail: 'buyer@example.com',
          customerName: 'A Buyer',
          shippingAddress: { line1: '1 Test Street' },
          rawPayload: { id: 4242 },
        },
      ],
      exactCount: 1,
      matchCount: 1,
    });

    const body = await (await searchGET(searchRequest())).json();

    expect(body.orders).toEqual([
      {
        id: 'ord-1',
        orderNumber: '#1001',
        platform: 'WOOCOMMERCE',
        internalStatus: 'pending',
        externalCreatedAt: '2026-08-09T00:00:00.000Z',
        itemCount: 3,
        store: 'Acme Store',
      },
    ]);
  });

  it('is rate-limited PER USER at 60 (no ttl key), after the guard, with the headers on the 200', async () => {
    asMember(['co-1'], 9101);

    const res = await searchGET(searchRequest());

    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
    expect(mockEnforceRateLimit.mock.calls[0][1]).toBe('reconciliation:orders-search');
    expect(mockEnforceRateLimit.mock.calls[0][2]).toEqual({ identifier: 9101, limit: 60 });
    expect(mockRequireApproved.mock.invocationCallOrder[0]).toBeLessThan(
      mockEnforceRateLimit.mock.invocationCallOrder[0],
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('59');
  });

  it('the 61st search inside the window is a 429 with the limiter headers', async () => {
    // A user id no other pin spends, so the in-process window is this pin's own.
    mockRequireApproved.mockResolvedValue({ user: { id: 9202, isAdmin: true, isApproved: true } });

    for (let i = 0; i < 60; i += 1) {
      const ok = await searchGET(searchRequest());
      expect(ok.status).toBe(200);
    }
    const limited = await searchGET(searchRequest());

    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'Too many requests', code: 'RATE_LIMITED' });
    expect(limited.headers.get('Retry-After')).not.toBeNull();
    expect(limited.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(limited.headers.get('X-RateLimit-Remaining')).toBe('0');
    // Refused before the database is asked: sixty searches, each ONE transaction
    // of three group reads.
    expect(db.$transaction).toHaveBeenCalledTimes(60);
    expect(db.externalOrder.findMany).toHaveBeenCalledTimes(180);
  });

  it('serves { orders, moreCount, exactCount } and says how many it left off', async () => {
    searchAnswers({ exact: [SEARCH_ROW], exactCount: 1, matchCount: 25 });

    const res = await searchGET(
      new NextRequest('http://localhost/api/reconciliation/orders/search?q=100'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Object.keys(body).sort()).toEqual(['exactCount', 'moreCount', 'orders']);
    expect(body.orders[0]).toEqual({
      id: 'ord-1',
      orderNumber: '#1001',
      platform: 'WOOCOMMERCE',
      internalStatus: 'pending',
      externalCreatedAt: '2026-08-09T00:00:00.000Z',
      itemCount: 3,
      store: 'Acme Store',
    });
    expect(body.moreCount).toBe(24);
    expect(body.exactCount).toBe(1);
  });

  it('ranks the groups exact -> starts-with -> contains on the wire', async () => {
    searchAnswers({
      exact: [{ ...SEARCH_ROW, id: 'e', orderNumber: '100' }],
      prefix: [{ ...SEARCH_ROW, id: 'p', orderNumber: '1001' }],
      contains: [{ ...SEARCH_ROW, id: 'c', orderNumber: '2100' }],
      exactCount: 1,
      matchCount: 3,
    });

    const body = await (await searchGET(searchRequest())).json();

    expect(body.orders.map((o: { id: string }) => o.id)).toEqual(['e', 'p', 'c']);
    expect(body.moreCount).toBe(0);
  });

  it('limit=5 reaches every group read, and the page is cut after the ranking', async () => {
    const rows = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...SEARCH_ROW, id: `${prefix}${i}` }));
    searchAnswers({ exact: rows('e', 2), prefix: rows('p', 5), contains: rows('c', 5), exactCount: 2, matchCount: 30 });

    const body = await (await searchGET(searchRequest('q=100&limit=5'))).json();

    for (const call of db.externalOrder.findMany.mock.calls) {
      expect(call[0]).toMatchObject({ take: 5 });
    }
    expect(body.orders.map((o: { id: string }) => o.id)).toEqual(['e0', 'e1', 'p0', 'p1', 'p2']);
    expect(body.moreCount).toBe(25);
    expect(body.exactCount).toBe(2);
  });

  it('an absent or empty limit is twenty', async () => {
    await searchGET(searchRequest('q=100'));
    await searchGET(searchRequest('q=100&limit='));
    for (const call of db.externalOrder.findMany.mock.calls) {
      expect(call[0]).toMatchObject({ take: 20 });
    }
    expect(db.externalOrder.findMany).toHaveBeenCalledTimes(6);
  });

  it('productId adds thisProduct to every row, read for the page ids only; absent or empty adds nothing', async () => {
    searchAnswers({ exact: [SEARCH_ROW], exactCount: 1, matchCount: 1 });
    db.externalOrderItem.findMany.mockResolvedValue([
      {
        id: 'item-1',
        orderId: 'ord-1',
        quantity: 2,
        fulfilledQty: 0,
        isMapped: true,
        productLinkId: 'link-1',
        bundleComponentSnapshot: null,
        productLink: { internalProductId: 9, isBundle: false, bundleComponents: [] },
      },
      {
        id: 'item-2',
        orderId: 'ord-1',
        quantity: 1,
        fulfilledQty: 0,
        isMapped: false,
        productLinkId: null,
        bundleComponentSnapshot: null,
        productLink: null,
      },
    ] as never);

    const withProduct = await (await searchGET(searchRequest('q=100&productId=9'))).json();
    expect(withProduct.orders[0].thisProduct).toEqual({ orderedUnits: 2, uncheckedLines: 1 });
    expect(
      (db.externalOrderItem.findMany.mock.calls[0][0] as { where: unknown }).where,
    ).toEqual({ orderId: { in: ['ord-1'] } });

    db.externalOrderItem.findMany.mockClear();
    for (const query of ['q=100', 'q=100&productId=']) {
      const body = await (await searchGET(searchRequest(query))).json();
      expect('thisProduct' in body.orders[0]).toBe(false);
    }
    expect(db.externalOrderItem.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ['a 41-character q', `q=${'1'.repeat(41)}`, 'search text is at most 40 characters'],
    ['productId=0', 'q=100&productId=0', 'productId must be a positive whole number'],
    ['productId=-1', 'q=100&productId=-1', 'productId must be a positive whole number'],
    ['productId=abc', 'q=100&productId=abc', 'productId must be a positive whole number'],
    ['productId=1.5', 'q=100&productId=1.5', 'productId must be a positive whole number'],
    ['productId=+5', 'q=100&productId=%2B5', 'productId must be a positive whole number'],
    ['productId=2147483648', 'q=100&productId=2147483648', 'productId must be a positive whole number'],
    ['limit=0', 'q=100&limit=0', 'limit must be a whole number from 1 to 20'],
    ['limit=21', 'q=100&limit=21', 'limit must be a whole number from 1 to 20'],
    ['limit=abc', 'q=100&limit=abc', 'limit must be a whole number from 1 to 20'],
    ['limit=2.5', 'q=100&limit=2.5', 'limit must be a whole number from 1 to 20'],
  ])('%s -> 400 VALIDATION_ERROR with its sentence, before the membership read', async (_label, query, sentence) => {
    asMember(['co-1']);

    const res = await searchGET(searchRequest(query));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: sentence, code: 'VALIDATION_ERROR' });
    expect(db.userCompany.findMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('validates in the pack order: q, then productId, then limit', async () => {
    const first = await searchGET(searchRequest(`q=${'1'.repeat(41)}&productId=0&limit=0`));
    expect((await first.json()).error).toBe('search text is at most 40 characters');
    const second = await searchGET(searchRequest('q=100&productId=0&limit=0'));
    expect((await second.json()).error).toBe('productId must be a positive whole number');
  });

  it('accepts a 40-character q (trimmed first), productId 2147483647 and limit 1', async () => {
    const forty = await searchGET(searchRequest(`q=%20${'1'.repeat(40)}%20`));
    expect(forty.status).toBe(200);
    const edge = await searchGET(searchRequest('q=100&productId=2147483647&limit=1'));
    expect(edge.status).toBe(200);
  });

  it('a blank q with a bad productId or limit is still the blank answer — nothing else is validated', async () => {
    const res = await searchGET(searchRequest('q=%20&productId=abc&limit=99'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orders: [], moreCount: 0, exactCount: 0 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('an absent or blank q asks the database nothing', async () => {
    const res = await searchGET(
      new NextRequest('http://localhost/api/reconciliation/orders/search?q=%20%20'),
    );
    expect(await res.json()).toEqual({ orders: [], moreCount: 0, exactCount: 0 });

    const bare = await searchGET(
      new NextRequest('http://localhost/api/reconciliation/orders/search'),
    );
    expect(await bare.json()).toEqual({ orders: [], moreCount: 0, exactCount: 0 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("a member's blank q answers BEFORE the membership read — and carries no note", async () => {
    asMember(['co-1']);

    const blank = await searchGET(searchRequest('q=%20%20'));
    const bare = await searchGET(searchRequest(''));

    expect(blank.status).toBe(200);
    expect(await blank.json()).toEqual({ orders: [], moreCount: 0, exactCount: 0 });
    expect(await bare.json()).toEqual({ orders: [], moreCount: 0, exactCount: 0 });
    // Still rate-limited, still carrying the headers.
    expect(blank.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(db.userCompany.findMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
