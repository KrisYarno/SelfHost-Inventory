// @jest-environment node
/**
 * M3a — the POLYMORPHIC READS: `GET /api/inbound-shipments` (list) and
 * `GET /api/inbound-shipments/[id]` (detail).
 *
 * ONE endpoint family, TWO models, discriminated per header by `model`
 * (`orderedAt IS NULL` is a legacy W1 receipt). The route owns only the query
 * parsing and the envelope; `lib/supply-orders/queries.ts` owns the shape, and
 * it is deliberately REAL here — a mocked query module would prove nothing about
 * the two things this suite exists for:
 *
 *   1. the legacy branch still renders TODAY'S `ShipmentSummary`/`ShipmentDetail`
 *      verbatim (seam S16), and
 *   2. THE PII PROJECTION (S26 / pack C6.4, a CRITICAL exit criterion). This is
 *      the re-home of `staging-items-password-hash.test.ts`, which M6 deletes:
 *      users appear only as `{ id, username }`, and NO key matching
 *      /password|hash|token|secret|email/i appears anywhere in a response.
 *
 * To make that scan meaningful without a database the mocked delegate SIMULATES
 * Prisma's include semantics: `relation: true` hands back the WHOLE row (hash and
 * all), `relation: { select }` hands back only the selected keys. The scan
 * therefore goes red against a hydrating include for the same reason production
 * would.
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
    inboundShipment: { findMany: jest.fn(), findUnique: jest.fn() },
    stagingItem: { findMany: jest.fn() },
    inventoryException: { findMany: jest.fn(async () => []) },
  };
  return { __esModule: true, default: client };
});

jest.mock('@/lib/rateLimit', () => ({
  __esModule: true,
  RateLimitError: jest.requireActual('@/lib/rateLimit').RateLimitError,
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((resp: unknown) => resp),
}));

import { GET as listGET } from '@/app/api/inbound-shipments/route';
import { GET as detailGET } from '@/app/api/inbound-shipments/[id]/route';
import { SUPPLY_ORDER_LIST_LIMIT } from '@/lib/supply-orders/queries';
import prisma from '@/lib/prisma';

const db = prisma as unknown as Record<string, any>;

const ORDER_ID = 'cksupplyorder00000000001';
const LEGACY_ID = 'cklegacyreceipt000000001';

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

function supplyHeader(include: unknown, overrides: Record<string, unknown> = {}) {
  const spec = (include as { creator?: unknown } | undefined)?.creator;
  return {
    id: ORDER_ID,
    supplierRef: 'PO-42',
    supplier: 'Acme',
    status: 'RECEIVING',
    notes: null,
    createdBy: 7,
    closedBy: null,
    orderedAt: new Date('2026-08-14T00:00:00.000Z'),
    feesCents: 1_200,
    feesNote: 'freight',
    createdAt: new Date('2026-08-14T09:00:00.000Z'),
    updatedAt: new Date('2026-08-14T09:00:00.000Z'),
    closedAt: null,
    creator: spec ? mockHydrate(spec, mockFullUser) : undefined,
    ...overrides,
  };
}

function legacyHeader(include: unknown, overrides: Record<string, unknown> = {}) {
  return supplyHeader(include, {
    id: LEGACY_ID,
    status: 'CLOSED',
    orderedAt: null,
    supplier: null,
    feesCents: null,
    feesNote: null,
    closedAt: new Date('2026-08-02T00:00:00.000Z'),
    closedBy: 7,
    ...overrides,
  });
}

function supplyLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 501,
    description: 'Vial Blue',
    status: 'VERIFIED',
    shipmentId: ORDER_ID,
    orderedProductId: 31,
    resolvedProductId: 31,
    orderedQuantity: 100,
    verifiedQuantity: 90,
    stockedQuantity: 0,
    disposedQuantity: 0,
    lineTotalCents: 100_000,
    labelingRequired: true,
    locationId: null,
    verifiedAt: new Date('2026-08-15T10:00:00.000Z'),
    verifiedBy: 7,
    expectedQuantity: null,
    countedQuantity: null,
    ...overrides,
  };
}

function legacyLine(include: unknown, overrides: Record<string, unknown> = {}) {
  const spec = include as { location?: unknown; resolvedProduct?: unknown } | undefined;
  return {
    id: 9,
    description: 'Box of vials',
    status: 'GRADUATED',
    shipmentId: LEGACY_ID,
    expectedQuantity: 10,
    countedQuantity: 10,
    unitCostCents: 250,
    resolvedProductId: 31,
    orderedProductId: null,
    orderedQuantity: null,
    verifiedQuantity: null,
    stockedQuantity: 0,
    disposedQuantity: 0,
    lineTotalCents: null,
    labelingRequired: true,
    vendor: null,
    reference: null,
    notes: null,
    locationId: 1,
    receivedBy: 7,
    receivedAt: new Date('2026-08-01T00:00:00.000Z'),
    countedAt: new Date('2026-08-02T00:00:00.000Z'),
    countedBy: 7,
    verifiedAt: null,
    verifiedBy: null,
    location: spec?.location ? { id: 1, name: 'Main' } : undefined,
    resolvedProduct: spec?.resolvedProduct ? { id: 31, name: 'Vial Blue' } : undefined,
    ...overrides,
  };
}

function mkReq(url: string) {
  return new NextRequest(url);
}

beforeEach(() => {
  jest.clearAllMocks();
  db.inventoryException.findMany.mockResolvedValue([]);
});

describe('GET /api/inbound-shipments (polymorphic list)', () => {
  it('defaults to the ORDERED,RECEIVING working set and bounds the page', async () => {
    db.inboundShipment.findMany.mockResolvedValue([]);

    const res = await listGET(mkReq('http://t/api/inbound-shipments'), {} as never);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ shipments: [] });
    const args = db.inboundShipment.findMany.mock.calls[0][0];
    expect(args.where.status).toEqual({ in: ['ORDERED', 'RECEIVING'] });
    expect(args.take).toBe(SUPPLY_ORDER_LIST_LIMIT);
    // No headers matched -> the line query never runs.
    expect(db.stagingItem.findMany).not.toHaveBeenCalled();
  });

  it('accepts a comma-separated ?status= list', async () => {
    db.inboundShipment.findMany.mockResolvedValue([]);

    await listGET(
      mkReq('http://t/api/inbound-shipments?status=ORDERED,RECEIVING,CLOSED'),
      {} as never,
    );

    expect(db.inboundShipment.findMany.mock.calls[0][0].where.status).toEqual({
      in: ['ORDERED', 'RECEIVING', 'CLOSED'],
    });
  });

  it('filters by ?model= on the orderedAt discriminator', async () => {
    db.inboundShipment.findMany.mockResolvedValue([]);

    await listGET(mkReq('http://t/api/inbound-shipments?model=legacy'), {} as never);
    expect(db.inboundShipment.findMany.mock.calls[0][0].where.orderedAt).toBeNull();

    await listGET(mkReq('http://t/api/inbound-shipments?model=supply-order'), {} as never);
    expect(db.inboundShipment.findMany.mock.calls[1][0].where.orderedAt).toEqual({ not: null });
  });

  it('400s an unknown status and an unknown model rather than silently listing everything', async () => {
    const badStatus = await listGET(
      mkReq('http://t/api/inbound-shipments?status=NOPE'),
      {} as never,
    );
    expect(badStatus.status).toBe(400);

    const badModel = await listGET(
      mkReq('http://t/api/inbound-shipments?model=nope'),
      {} as never,
    );
    expect(badModel.status).toBe(400);
    expect(db.inboundShipment.findMany).not.toHaveBeenCalled();
  });

  it('discriminates each header: a supply order rolls up ordered vs verified, a legacy one keeps its W1 shape', async () => {
    db.inboundShipment.findMany.mockImplementation(async ({ include }: any) => [
      supplyHeader(include),
      legacyHeader(include),
    ]);
    db.stagingItem.findMany.mockResolvedValue([
      supplyLine(),
      legacyLine(undefined, { shipmentId: LEGACY_ID }),
    ]);

    const res = await listGET(mkReq('http://t/api/inbound-shipments'), {} as never);
    const json = await res.json();

    const [order, legacy] = json.shipments;
    expect(order.model).toBe('supply-order');
    expect(order.lineCounts).toEqual({
      ordered: 0,
      verified: 1,
      labeling: 0,
      complete: 0,
      discarded: 0,
    });
    expect(order.units).toEqual({ verified: 90, stocked: 0, disposed: 0 });
    expect(order.discrepancy).toMatchObject({ linesWithDiscrepancy: 1, shortUnits: 10 });

    expect(legacy.model).toBe('legacy');
    expect(legacy.legacy).toMatchObject({
      id: LEGACY_ID,
      itemCount: 1,
      graduatedItemCount: 1,
    });
    // The legacy half carries no new-flow keys at all — today's shape verbatim.
    expect(legacy.legacy.lineCounts).toBeUndefined();
  });
});

describe('GET /api/inbound-shipments/[id] (polymorphic detail)', () => {
  it('404s an unknown id', async () => {
    db.inboundShipment.findUnique.mockResolvedValue(null);

    const res = await detailGET(mkReq(`http://t/api/inbound-shipments/${ORDER_ID}`), {
      params: { id: ORDER_ID },
    } as never);

    expect(res.status).toBe(404);
  });

  it('serves a supply order with its lines, money derivation and exception keys', async () => {
    db.inboundShipment.findUnique.mockImplementation(async ({ include }: any) =>
      supplyHeader(include),
    );
    db.stagingItem.findMany.mockResolvedValue([supplyLine()]);
    db.inventoryException.findMany.mockResolvedValue([
      {
        id: 1,
        key: 'recv-discrepancy:501',
        kind: 'recv-discrepancy',
        subject: { stagingItemId: 501, shortUnits: 10 },
        firstSeenAt: new Date('2026-08-15T10:00:00.000Z'),
        lastSeenAt: new Date('2026-08-15T10:00:00.000Z'),
        resolvedAt: null,
        resolvedBy: null,
        resolution: null,
        note: null,
      },
    ]);

    const res = await detailGET(mkReq(`http://t/api/inbound-shipments/${ORDER_ID}`), {
      params: { id: ORDER_ID },
    } as never);
    const json = await res.json();

    expect(json.model).toBe('supply-order');
    expect(json.lines[0]).toMatchObject({
      id: 501,
      productId: 31,
      productName: 'Vial Blue',
      remaining: 90,
      unitCostCents: 1_000,
      exceptionKeys: ['recv-discrepancy:501'],
    });
    expect(json.lines[0].derivation).toBe('$1,000.00 / 100 ordered = $10.00/unit');
    expect(json.exceptions[0]).toMatchObject({ key: 'recv-discrepancy:501', lineId: 501 });
  });

  it('serves a legacy header as { model: "legacy", legacy } through the W1 mapper', async () => {
    db.inboundShipment.findUnique.mockImplementation(async ({ include }: any) =>
      legacyHeader(include),
    );
    db.stagingItem.findMany.mockImplementation(async ({ include }: any) => [legacyLine(include)]);

    const res = await detailGET(mkReq(`http://t/api/inbound-shipments/${LEGACY_ID}`), {
      params: { id: LEGACY_ID },
    } as never);
    const json = await res.json();

    expect(json.model).toBe('legacy');
    expect(json.legacy.items[0]).toMatchObject({
      id: 9,
      description: 'Box of vials',
      expectedQuantity: 10,
      countedQuantity: 10,
      location: { id: 1, name: 'Main' },
      flags: { counted: true, delta: 0, direction: 'MATCH' },
    });
    // The legacy read is the W1 read, includes and ordering included.
    expect(db.stagingItem.findMany.mock.calls[0][0].orderBy).toEqual([
      { receivedAt: 'asc' },
      { id: 'asc' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// PII PROJECTION (S26 / pack C6.4) — a CRITICAL exit criterion, re-homed here
// from __tests__/integration/api/staging-items-password-hash.test.ts.
// ---------------------------------------------------------------------------

describe('the polymorphic reads never ship a password hash (S26)', () => {
  it('the LIST projects users as { id, username } and nothing else', async () => {
    db.inboundShipment.findMany.mockImplementation(async ({ include }: any) => [
      supplyHeader(include),
      legacyHeader(include),
    ]);
    db.stagingItem.findMany.mockResolvedValue([supplyLine()]);

    const res = await listGET(mkReq('http://t/api/inbound-shipments'), {} as never);
    const json = await res.json();

    expect(json.shipments[0].creator).toEqual({ id: 7, username: 'kris' });
    expect(json.shipments[1].legacy.creator).toEqual({ id: 7, username: 'kris' });
    for (const key of deepKeys(json)) {
      expect(key).not.toMatch(SENSITIVE_KEY);
    }
  });

  it('the supply-order DETAIL carries no password/hash/token/secret/email key at any depth', async () => {
    db.inboundShipment.findUnique.mockImplementation(async ({ include }: any) =>
      supplyHeader(include),
    );
    db.stagingItem.findMany.mockResolvedValue([supplyLine()]);

    const res = await detailGET(mkReq(`http://t/api/inbound-shipments/${ORDER_ID}`), {
      params: { id: ORDER_ID },
    } as never);
    const json = await res.json();

    expect(json.creator).toEqual({ id: 7, username: 'kris' });
    for (const key of deepKeys(json)) {
      expect(key).not.toMatch(SENSITIVE_KEY);
    }
  });

  it('the legacy DETAIL carries none of them either', async () => {
    db.inboundShipment.findUnique.mockImplementation(async ({ include }: any) =>
      legacyHeader(include),
    );
    db.stagingItem.findMany.mockImplementation(async ({ include }: any) => [legacyLine(include)]);

    const res = await detailGET(mkReq(`http://t/api/inbound-shipments/${LEGACY_ID}`), {
      params: { id: LEGACY_ID },
    } as never);
    const json = await res.json();

    expect(json.legacy.creator).toEqual({ id: 7, username: 'kris' });
    for (const key of deepKeys(json)) {
      expect(key).not.toMatch(SENSITIVE_KEY);
    }
  });

  it('the deep scan itself works (it finds a hash that IS present)', () => {
    const keys = deepKeys({ shipments: [{ creator: mockFullUser }] });
    expect(keys).toContain('passwordHash');
    expect(keys.some((k) => SENSITIVE_KEY.test(k))).toBe(true);
  });
});
