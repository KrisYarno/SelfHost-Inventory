// @jest-environment node
/**
 * P2-B1.5 (pack CB1.5a-i.7(d), QB-5) — THE FULFIL/UNFULFILL WIRE.
 *
 * What a caller actually receives. Every other fulfil suite drives the library
 * or a route whose `apiHandler` has been replaced by the identity function; this
 * one runs the REAL `@/lib/api-utils` ladder, because the codes this wave adds
 * (`DUPLICATE_ITEM`, `TOO_MANY_KEYS`) and the one it MOVES (a transient inside
 * the transaction is now a whole-request 503 `BUSY`, never a per-item sentence
 * on a 200) are decided there and nowhere else.
 *
 * Harness class: OWN hand-built prisma factory (PKd-1). The GLOBAL `jest.setup.js`
 * mock has no `externalOrder` / `externalOrderItem` / `auditLog` /
 * `orderAttributionAttempt` delegates, so a suite leaning on it dies at the
 * routes' company pre-read. Everything the ladder itself runs on stays REAL:
 * `apiHandler`, `requireApproved`, `requireCompanyMembership`, `RateLimitError`,
 * `newBatchId`. Egress is mocked so no fire-and-forget push leaks past a test.
 */

jest.mock('next-auth', () => ({
  getServerSession: jest.fn(),
}));

jest.mock('@/lib/csrf', () => ({
  validateCSRFToken: jest.fn(async () => true),
}));

// The REAL ladder runs `instanceof RateLimitError` BEFORE the AppError rung, so
// a bare factory would kill every pin in this suite.
jest.mock('@/lib/rateLimit', () => ({
  __esModule: true,
  RateLimitError: jest.requireActual('@/lib/rateLimit').RateLimitError,
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((resp: any) => resp),
}));

// `newBatchId` is PRESERVED: the route mints the batchId the non-null pin reads.
jest.mock('@/lib/change-tracking', () => ({
  __esModule: true,
  recordChange: jest.fn(async () => undefined),
  newBatchId: jest.requireActual('@/lib/change-tracking').newBatchId,
}));

jest.mock('@/lib/attribution/attempts', () => ({
  recordAttributionAttempt: jest.fn(async () => undefined),
}));

jest.mock('@/lib/inventory', () => ({
  createInventoryLog: jest.fn(async () => ({ id: 777 })),
}));

jest.mock('@/lib/external-orders/shared', () => ({
  pushOrderStatusToExternal: jest.fn(async () => ({ success: true })),
}));
jest.mock('@/lib/external-orders/stock-sync', () => ({
  pushStockForProducts: jest.fn(async () => undefined),
}));

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    externalOrder: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}));

import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { getServerSession } from 'next-auth';
import { POST as FULFILL } from '@/app/api/orders/[orderId]/fulfill/route';
import { POST as UNFULFILL } from '@/app/api/orders/[orderId]/unfulfill/route';
import { pushOrderStatusToExternal } from '@/lib/external-orders/shared';
import { TX_BUSY_MESSAGE } from '@/lib/api-utils';
import prisma from '@/lib/prisma';

const ORDER_CUID = 'cmdq7f3k80001s6h4p2n9wxyz';
const COMPANY_ID = 'company-abc';
const LOCATION_ID = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const db = prisma as unknown as {
  externalOrder: { findUnique: jest.Mock };
  $transaction: jest.Mock;
};

// The session `requireApproved` reads. isAdmin: true short-circuits the LIVE
// `requireCompanyMembership`, which would otherwise need a `userCompany`
// delegate this factory does not carry.
const SESSION = {
  user: {
    id: 7,
    email: 'kris@example.com',
    name: 'Kris',
    isAdmin: true,
    isApproved: true,
    defaultLocationId: 1,
  },
};

// ---------------------------------------------------------------------------
// THE HAND-BUILT TX (the change-tracking-orders factory idiom).
// ---------------------------------------------------------------------------

type RawCall = { kind: 'query' | 'execute' | 'executeUnsafe'; sql: string };

const rawCalls: RawCall[] = [];

function sqlTextOf(arg: unknown): string {
  return arg && typeof arg === 'object' && typeof (arg as { sql?: unknown }).sql === 'string'
    ? (arg as { sql: string }).sql
    : String(arg);
}

function isOrderLockSelect(sql: string): boolean {
  return sql.includes('FROM external_orders') && sql.includes('FOR UPDATE');
}

function isPrelockSelect(sql: string): boolean {
  return sql.includes('FROM product_locations') && sql.includes('(productId, locationId) IN');
}

/** What the two raw dispatchers answer — reset per test, steered per pin. */
const knobs: {
  lockedOrders: Array<{ id: string; orderNumber: string }>;
  stock: number;
  stockUpdateAffected: number;
  stockUpdateError: Error | null;
  knownProductIds: number[] | null;
} = {
  lockedOrders: [],
  stock: 100,
  stockUpdateAffected: 1,
  stockUpdateError: null,
  knownProductIds: null,
};

function makeTx(order: any) {
  const queryRaw = jest.fn(async (query: any) => {
    const sql = sqlTextOf(query);
    rawCalls.push({ kind: 'query', sql });
    if (isOrderLockSelect(sql)) return knobs.lockedOrders;
    if (isPrelockSelect(sql)) {
      const values = (query?.values ?? []) as number[];
      const rows = [];
      for (let i = 0; i < values.length; i += 2) {
        rows.push({
          productId: values[i],
          locationId: values[i + 1],
          quantity: knobs.stock,
          version: 1,
        });
      }
      return rows;
    }
    return [];
  });

  const executeRaw = jest.fn(async (query: any) => {
    const sql = sqlTextOf(query);
    rawCalls.push({ kind: 'execute', sql });
    if (/UPDATE product_locations/.test(sql)) {
      if (knobs.stockUpdateError) throw knobs.stockUpdateError;
      return knobs.stockUpdateAffected;
    }
    return 1;
  });

  return {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
    $executeRawUnsafe: jest.fn(async () => 0),
    externalOrder: {
      findUnique: jest.fn(async () => order),
      update: jest.fn(async () => ({})),
    },
    externalOrderItem: {
      update: jest.fn(async () => ({})),
      findMany: jest.fn(async () =>
        (order.items as any[]).map((i) => ({ quantity: i.quantity, fulfilledQty: i.fulfilledQty }))
      ),
    },
    product: {
      findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, deletedAt: null })),
      findMany: jest.fn(async ({ where }: any) =>
        ((where?.id?.in ?? []) as number[])
          .filter((id) => (knobs.knownProductIds ? knobs.knownProductIds.indexOf(id) !== -1 : true))
          .map((id) => ({ id, name: `Product ${id}` }))
      ),
    },
    auditLog: { create: jest.fn(async () => ({ id: 1 })) },
    orderAttributionAttempt: { create: jest.fn(async () => ({ id: 1 })) },
  };
}

function driveWith(order: any) {
  const tx = makeTx(order);
  db.$transaction.mockImplementation(async (cb: any) => cb(tx));
  return tx;
}

// ---------------------------------------------------------------------------
// Order fixtures
// ---------------------------------------------------------------------------

function singleLine(over: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    orderId: ORDER_CUID,
    quantity: 2,
    fulfilledQty: 0,
    name: 'Widget A',
    sku: 'WA-001',
    isMapped: true,
    bundleComponentSnapshot: null,
    productLink: {
      isBundle: false,
      internalProductId: 10,
      internalProduct: { id: 10, name: 'Widget A' },
      bundleComponents: [],
    },
    ...over,
  };
}

/** One bundle line whose snapshot names `componentIds`, each one unit. */
function bundleLine(id: string, componentIds: number[], fulfilledQty = 0) {
  return {
    id,
    orderId: ORDER_CUID,
    quantity: 1,
    fulfilledQty,
    name: `Bundle ${id}`,
    sku: null,
    isMapped: true,
    bundleComponentSnapshot: componentIds.map((componentId, i) => ({
      internalProductId: componentId,
      internalProductName: `Component ${componentId}`,
      quantity: 1,
      sortOrder: i,
    })),
    productLink: {
      isBundle: true,
      internalProductId: null,
      internalProduct: null,
      bundleComponents: [],
    },
  };
}

function orderWith(items: any[], over: Record<string, unknown> = {}) {
  return {
    id: ORDER_CUID,
    externalId: 'ext-1',
    integrationId: 'int-1',
    internalStatus: 'processing',
    stockedOut: false,
    stockedOutAt: null,
    stockedOutBy: null,
    fulfilledAt: null,
    fulfilledBy: null,
    companyId: COMPANY_ID,
    integration: { id: 'int-1', platform: 'WOOCOMMERCE', fulfillmentPushEnabled: false },
    items,
    ...over,
  };
}

/**
 * 67 bundle lines × 3 distinct components = 201 keys, one past the prelock cap.
 * `fulfilledQty` decides which route the fixture is for: fulfil needs OPEN lines
 * (0), unfulfill needs lines with something to give back (1).
 */
function overCapLines(fulfilledQty: number) {
  const lines: any[] = [];
  let nextComponentId = 100;
  for (let i = 0; i < 67; i += 1) {
    lines.push(
      bundleLine(
        `item-b${i}`,
        [nextComponentId++, nextComponentId++, nextComponentId++],
        fulfilledQty
      )
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The driver: both routes are param routes on the same order.
// ---------------------------------------------------------------------------

type ParamRoute = (req: NextRequest, ctx: any) => Promise<Response>;

async function callParamRoute(route: ParamRoute, body: unknown) {
  const request = new NextRequest(`http://x/api/orders/${ORDER_CUID}/fulfill`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-csrf-token': 'x' },
  });
  const response = await route(request, { params: { orderId: ORDER_CUID } });
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  jest.clearAllMocks();
  rawCalls.length = 0;
  knobs.lockedOrders = [{ id: ORDER_CUID, orderNumber: '12345' }];
  knobs.stock = 100;
  knobs.stockUpdateAffected = 1;
  knobs.stockUpdateError = null;
  knobs.knownProductIds = null;
  (getServerSession as jest.Mock).mockResolvedValue(SESSION);
  db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID });
});

// ---------------------------------------------------------------------------

describe('fulfil — the refusals this wave adds', () => {
  it('DUPLICATE_ITEM: the same order line twice is a 400 and never opens a transaction', async () => {
    driveWith(orderWith([singleLine()]));

    const res = await callParamRoute(FULFILL, {
      locationId: LOCATION_ID,
      items: [
        { itemId: 'item-1', quantity: 1 },
        { itemId: 'item-1', quantity: 1 },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'the same order line appears more than once in the request',
      code: 'DUPLICATE_ITEM',
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('TOO_MANY_KEYS: past 200 stock rows fulfil answers its OWN sentence', async () => {
    const lines = overCapLines(0);
    driveWith(orderWith(lines));

    const res = await callParamRoute(FULFILL, {
      locationId: LOCATION_ID,
      items: lines.map((line) => ({ itemId: line.id, quantity: 1 })),
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error:
        'this order needs more than 200 stock rows in one request and cannot be fulfilled in one pass',
      code: 'TOO_MANY_KEYS',
    });
    // Nothing was locked or written on the way out.
    expect(rawCalls.filter((c) => /product_locations/.test(c.sql))).toHaveLength(0);
  });

  it('ORDER_GONE: an order that vanished after discovery is a 409', async () => {
    knobs.lockedOrders = [];
    driveWith(orderWith([singleLine()]));

    const res = await callParamRoute(FULFILL, {
      locationId: LOCATION_ID,
      items: [{ itemId: 'item-1', quantity: 1 }],
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_GONE');
  });

  it('an absent override product is a 200 with a failed[] entry — never a 404', async () => {
    // Only product 10 exists; the second line's override names 999.
    knobs.knownProductIds = [10];
    driveWith(
      orderWith([
        singleLine(),
        singleLine({ id: 'item-2', quantity: 1, isMapped: false, productLink: null }),
      ])
    );

    const res = await callParamRoute(FULFILL, {
      locationId: LOCATION_ID,
      items: [
        { itemId: 'item-1', quantity: 2 },
        { itemId: 'item-2', quantity: 1, productId: 999 },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.results.failed).toEqual([
      { itemId: 'item-2', error: 'Product with ID 999 not found' },
    ]);
    expect(res.body.results.fulfilled.map((f: any) => f.itemId)).toEqual(['item-1']);
  });

  it('a transient inside the transaction is a whole-request 503 BUSY, never a 200', async () => {
    knobs.stockUpdateError = new Prisma.PrismaClientKnownRequestError(
      'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
      { code: 'P2034', clientVersion: 'test' } as never
    );
    driveWith(orderWith([singleLine()]));

    const res = await callParamRoute(FULFILL, {
      locationId: LOCATION_ID,
      items: [{ itemId: 'item-1', quantity: 2 }],
    });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: TX_BUSY_MESSAGE, code: 'BUSY' });
  });
});

describe('fulfil — the 200 envelope and the push gate', () => {
  it('a committed line answers failed: [], a non-null batchId and summary.fulfilled = 1', async () => {
    driveWith(orderWith([singleLine()]));

    const res = await callParamRoute(FULFILL, {
      locationId: LOCATION_ID,
      items: [{ itemId: 'item-1', quantity: 2 }],
    });

    expect(res.status).toBe(200);
    expect(res.body.results.failed).toEqual([]);
    expect(res.body.summary.fulfilled).toBe(1);
    expect(res.body.batchId).toMatch(UUID_RE);
  });

  it('PKc-3: a fulfilled line beside a refusal STILL pushes the WC status', async () => {
    driveWith(orderWith([singleLine()]));

    const res = await callParamRoute(FULFILL, {
      locationId: LOCATION_ID,
      items: [
        { itemId: 'item-1', quantity: 2 },
        // Not a line of this order: a `failed[]` entry, and nothing else.
        { itemId: 'item-missing', quantity: 1 },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.results.failed).toHaveLength(1);
    expect(res.body.summary.fulfilled).toBe(1);
    expect(pushOrderStatusToExternal).toHaveBeenCalledTimes(1);
  });

  it('PKc-3: an ALL-refused request pushes nothing', async () => {
    driveWith(orderWith([singleLine()]));

    const res = await callParamRoute(FULFILL, {
      locationId: LOCATION_ID,
      items: [{ itemId: 'item-missing', quantity: 1 }],
    });

    expect(res.status).toBe(200);
    expect(res.body.summary.fulfilled).toBe(0);
    expect(res.body.batchId).toBeNull();
    expect(pushOrderStatusToExternal).not.toHaveBeenCalled();
  });
});

describe('unfulfill — the same two codes, its own sentence (QB-5)', () => {
  it('TOO_MANY_KEYS: unfulfill keeps its own wording', async () => {
    const lines = overCapLines(1);
    driveWith(orderWith(lines));

    const res = await callParamRoute(UNFULFILL, {
      items: lines.map((line) => ({
        itemId: line.id,
        productId: 1,
        quantity: 1,
        locationId: LOCATION_ID,
      })),
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'too many restorations in one request — split it',
      code: 'TOO_MANY_KEYS',
    });
  });

  it('ORDER_GONE: the lock that finds nothing is a 409', async () => {
    knobs.lockedOrders = [];
    driveWith(orderWith([singleLine({ fulfilledQty: 2 })]));

    const res = await callParamRoute(UNFULFILL, {
      items: [{ itemId: 'item-1', productId: 10, quantity: 2, locationId: LOCATION_ID }],
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_GONE');
  });

  it('the happy path restores and answers 200', async () => {
    driveWith(orderWith([singleLine({ fulfilledQty: 2 })]));

    const res = await callParamRoute(UNFULFILL, {
      items: [{ itemId: 'item-1', productId: 10, quantity: 2, locationId: LOCATION_ID }],
    });

    expect(res.status).toBe(200);
    expect(res.body.restored).toHaveLength(1);
    expect(res.body.skipped).toEqual([]);
  });
});
