// @jest-environment node
/**
 * M3b — the two REMAINING READS: `GET /api/labeling/queue?orderId=` and
 * `GET /api/receiving/legacy-lines`.
 *
 * Both are pure reads: `apiHandler` + `requireApproved` + the query parse, and
 * nothing else — no CSRF, no rate limiter, no audit, and deliberately no
 * `GET_SIDE_EFFECT_REGISTRY` entry, because neither handler causes one.
 *
 * They also carry the OTHER HALF of the PII PROJECTION pins (S26 / pack C6.4, a
 * CRITICAL exit criterion): the re-home of
 * `__tests__/integration/api/staging-items-password-hash.test.ts`, which M6
 * deletes. Users appear only as `{ id, username }`, and no key matching
 * /password|hash|token|secret|email/i appears anywhere in a response.
 *
 * As in the M3a reads suite, the mocked delegate SIMULATES Prisma's include
 * semantics — `relation: true` hands back the WHOLE row, `relation: { select }`
 * only the selected keys — so a future hydrating include goes red here for the
 * same reason it would leak in production.
 */

import { NextRequest } from 'next/server';

/** The FULL user row, exactly as MySQL holds it (`mock`-prefixed for the hoist). */
const mockFullUser = {
  id: 7,
  username: 'kris',
  email: 'kris@example.com',
  passwordHash: '$2b$10$notarealhashbutlongenoughtohurt',
  isAdmin: false,
  isApproved: true,
};

/** Project a relation the way Prisma does, given `true` or `{ select }`. */
const mockHydrate = (spec: unknown, row: Record<string, unknown>) => {
  if (spec === true) return { ...row };
  const select = (spec as { select?: Record<string, boolean> })?.select;
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [field, wanted] of Object.entries(select)) {
    if (wanted) out[field] = row[field];
  }
  return out;
};

jest.mock('@/lib/api-utils', () => {
  const actual = jest.requireActual('@/lib/api-utils');
  return {
    __esModule: true,
    ...actual,
    requireApproved: jest.fn(async () => ({
      user: { id: 7, isAdmin: false, isApproved: true },
    })),
  };
});

jest.mock('@/lib/prisma', () => {
  const client: Record<string, unknown> = {
    stagingItem: { findMany: jest.fn() },
    $queryRaw: jest.fn(),
  };
  client.$transaction = jest.fn(async (arg: unknown) =>
    Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(client),
  );
  return { __esModule: true, default: client };
});

import { GET as queueGET } from '@/app/api/labeling/queue/route';
import { GET as legacyGET } from '@/app/api/receiving/legacy-lines/route';
import { requireApproved } from '@/lib/api-utils';
import { LABELING_QUEUE_LIMIT, LEGACY_LINE_LIMIT } from '@/lib/supply-orders/queries';
import prisma from '@/lib/prisma';

const db = prisma as unknown as Record<string, any>;

const ORDER_ID = 'cksupplyorder00000000001';
const OTHER_ORDER_ID = 'cksupplyorder00000000002';

/** Every key name appearing anywhere in a JSON tree. */
function deepKeys(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) deepKeys(entry, acc);
    return acc;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      acc.push(key);
      deepKeys(child, acc);
    }
  }
  return acc;
}

const SENSITIVE_KEY = /password|hash|token|secret|email/i;

function mkReq(url: string) {
  return new NextRequest(url);
}

/** One queue row: the line's columns plus its header's, as the join returns them. */
function queueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 501,
    description: 'Vial Blue',
    status: 'LABELING',
    shipmentId: ORDER_ID,
    orderedProductId: 31,
    resolvedProductId: 31,
    orderedQuantity: 10,
    verifiedQuantity: 10,
    stockedQuantity: 4,
    disposedQuantity: 0,
    lineTotalCents: 10_000,
    labelingRequired: true,
    locationId: 2,
    verifiedAt: new Date('2026-08-15T09:00:00.000Z'),
    verifiedBy: 7,
    expectedQuantity: null,
    countedQuantity: null,
    orderId: ORDER_ID,
    orderStatus: 'RECEIVING',
    supplier: 'Acme',
    supplierRef: 'PO-42',
    orderedAt: new Date('2026-08-14T00:00:00.000Z'),
    ...overrides,
  };
}

/** One legacy (pre-staging) line, hydrated the way Prisma would. */
function legacyRow(include: unknown, overrides: Record<string, unknown> = {}) {
  const spec = include as Record<string, unknown> | undefined;
  const row: Record<string, unknown> = {
    id: 91,
    description: 'Box of vials',
    status: 'GRADUATED',
    resolvedProductId: 31,
    expectedQuantity: 12,
    countedQuantity: 12,
    locationId: 1,
    receivedAt: new Date('2026-06-01T10:00:00.000Z'),
    receivedBy: 7,
    shipmentId: null,
    ...overrides,
  };
  for (const [relation, relationSpec] of Object.entries(spec ?? {})) {
    if (relation === 'location') {
      row.location = mockHydrate(relationSpec, { id: 1, name: 'Main' });
    } else if (relation === 'resolvedProduct') {
      row.resolvedProduct = mockHydrate(relationSpec, { id: 31, name: 'Vial Blue' });
    } else {
      // Any OTHER relation this read might grow: hydrated as a user row, so a
      // `receiver: true` added later leaks its hash into the scan below.
      row[relation] = mockHydrate(relationSpec, mockFullUser);
    }
  }
  return row;
}

let queueRows: Record<string, unknown>[] = [];
let queueCount = 0;
let legacyCount = 1;

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({
    user: { id: 7, isAdmin: false, isApproved: true },
  });
  queueRows = [queueRow()];
  queueCount = 1;
  legacyCount = 1;

  db.$transaction.mockImplementation(async (arg: unknown) =>
    Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(db),
  );
  db.$queryRaw.mockImplementation(async (statement: { sql?: string }) => {
    const sql = String(statement?.sql ?? '');
    if (/COUNT\(\*\)/i.test(sql)) return [{ count: BigInt(queueCount) }];
    return queueRows;
  });
  db.stagingItem.findMany.mockImplementation(async ({ include }: any) =>
    Array.from({ length: legacyCount }, (_, i) => legacyRow(include, { id: 91 + i })),
  );
});

// ---------------------------------------------------------------------------
// GET /api/labeling/queue
// ---------------------------------------------------------------------------

describe('GET /api/labeling/queue', () => {
  it('requires an approved user', async () => {
    (requireApproved as jest.Mock).mockRejectedValue(
      new (jest.requireActual('@/lib/error-handling').AppError)('Unauthorized', 'UNAUTHORIZED', 401),
    );

    const res = await queueGET(mkReq('http://t/api/labeling/queue'), {} as never);
    expect(res.status).toBe(401);
  });

  it('answers { groups, count, moreCount } grouped by order', async () => {
    const res = await queueGET(mkReq('http://t/api/labeling/queue'), {} as never);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.count).toBe(1);
    expect(json.moreCount).toBe(0);
    expect(json.groups).toHaveLength(1);
    expect(json.groups[0].order).toMatchObject({
      id: ORDER_ID,
      status: 'RECEIVING',
      supplier: 'Acme',
      supplierRef: 'PO-42',
    });
    expect(json.groups[0].lines[0]).toMatchObject({
      id: 501,
      productId: 31,
      productName: 'Vial Blue',
      verifiedQuantity: 10,
      stockedQuantity: 4,
      remaining: 6,
      labelingRequired: true,
    });
  });

  it('narrows to ONE order when ?orderId= is given (the bound param reaches SQL)', async () => {
    await queueGET(mkReq(`http://t/api/labeling/queue?orderId=${ORDER_ID}`), {} as never);

    const values = db.$queryRaw.mock.calls.map((c: any[]) => c[0]?.values ?? []);
    expect(values.every((v: unknown[]) => v.includes(ORDER_ID))).toBe(true);
  });

  it('400s an orderId longer than the column holds', async () => {
    const res = await queueGET(
      mkReq(`http://t/api/labeling/queue?orderId=${'x'.repeat(64)}`),
      {} as never,
    );
    expect(res.status).toBe(400);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('reports a TRUTHFUL "N more" cue when the bound cut the list', async () => {
    queueCount = LABELING_QUEUE_LIMIT + 7;

    const json = await (await queueGET(mkReq('http://t/api/labeling/queue'), {} as never)).json();

    expect(json.count).toBe(LABELING_QUEUE_LIMIT + 7);
    expect(json.moreCount).toBe(7);
  });

  it('groups two orders separately, in queue order', async () => {
    queueRows = [
      queueRow(),
      queueRow({ id: 502, shipmentId: OTHER_ORDER_ID, orderId: OTHER_ORDER_ID, supplier: 'Beta' }),
    ];
    queueCount = 2;

    const json = await (await queueGET(mkReq('http://t/api/labeling/queue'), {} as never)).json();

    expect(json.groups.map((g: any) => g.order.id)).toEqual([ORDER_ID, OTHER_ORDER_ID]);
  });

  it('carries no password/hash/token/secret/email key at any depth (S26)', async () => {
    const json = await (await queueGET(mkReq('http://t/api/labeling/queue'), {} as never)).json();

    for (const key of deepKeys(json)) {
      expect(key).not.toMatch(SENSITIVE_KEY);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/receiving/legacy-lines
// ---------------------------------------------------------------------------

describe('GET /api/receiving/legacy-lines', () => {
  it('requires an approved user', async () => {
    (requireApproved as jest.Mock).mockRejectedValue(
      new (jest.requireActual('@/lib/error-handling').AppError)('Unauthorized', 'UNAUTHORIZED', 401),
    );

    const res = await legacyGET(mkReq('http://t/api/receiving/legacy-lines'), {} as never);
    expect(res.status).toBe(401);
  });

  it('answers { lines } of read-only pre-staging history, bounded', async () => {
    const res = await legacyGET(mkReq('http://t/api/receiving/legacy-lines'), {} as never);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.lines).toHaveLength(1);
    expect(json.lines[0]).toMatchObject({
      id: 91,
      description: 'Box of vials',
      status: 'GRADUATED',
      productId: 31,
      productName: 'Vial Blue',
      locationId: 1,
      locationName: 'Main',
      receivedBy: 7,
      receivedByName: 'kris',
    });
    expect(db.stagingItem.findMany.mock.calls[0][0].take).toBe(LEGACY_LINE_LIMIT);
  });

  it('fetches the receiver as { id, username } and NOTHING else (S26)', async () => {
    await legacyGET(mkReq('http://t/api/receiving/legacy-lines'), {} as never);

    const spec = db.stagingItem.findMany.mock.calls[0][0].include;
    expect(Object.keys(spec).sort()).toEqual(['location', 'receivedByUser', 'resolvedProduct']);
    expect(spec.location).toEqual({ select: { id: true, name: true } });
    expect(spec.resolvedProduct).toEqual({ select: { id: true, name: true } });
    // The ONLY user this read may carry, and only these two columns of it: the
    // mocked delegate hydrates any user relation from the FULL row, so a
    // `receivedByUser: true` here leaks a hash into the deep scan below.
    expect(spec.receivedByUser).toEqual({ select: { id: true, username: true } });
  });

  it('carries no password/hash/token/secret/email key at any depth (S26)', async () => {
    const json = await (
      await legacyGET(mkReq('http://t/api/receiving/legacy-lines'), {} as never)
    ).json();

    for (const key of deepKeys(json)) {
      expect(key).not.toMatch(SENSITIVE_KEY);
    }
  });

  it('the deep scan itself works (it finds a hash that IS present)', () => {
    const keys = deepKeys({ lines: [{ receiver: mockFullUser }] });
    expect(keys).toContain('passwordHash');
    expect(keys.some((k) => SENSITIVE_KEY.test(k))).toBe(true);
  });
});
