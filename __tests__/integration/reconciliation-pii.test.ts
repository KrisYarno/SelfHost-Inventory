/**
 * @jest-environment node
 *
 * THE ROUTE-RESPONSE PII HARNESS (reconciliation lane, pack C2a.3; spec REV-7 D6).
 *
 * Every reconciliation route is driven against a Prisma whose order rows carry
 * EVERY forbidden field — customer identity, the verbatim platform payload, the
 * outward link — and the JSON it answers with is walked by `assertNoPiiKeys`.
 *
 * TWO LAYERS, and this is the second one. `RECONCILIATION_ORDER_SELECT` is what
 * SHOULD reach a response; this harness is what proves nothing else did. A
 * producer that spread a row instead of picking its fields would pass every
 * envelope pin in the route suite and fail here — which is the whole point of
 * seeding the mock with fields the real select would never have asked for.
 *
 * EXTENSIBLE BY CONSTRUCTION: the routes are a TABLE. M2b added the POST envelope
 * and M2c added exceptions/unmapped by appending a row, not by writing a second
 * harness.
 *
 * The two M2c rows seed PII names where a careless producer would echo them: on
 * the exception row's `subject` blob (rendered into sentences, never returned)
 * and on the grouped unmapped row (rebuilt field by field, never spread). The
 * exception's `note` rides through UNTOUCHED and must keep passing — CX-6: an
 * admin's own free text on an admin-only surface is not order PII, and a
 * forbidden-name set containing `note` would fail every row the finder makes.
 */

jest.mock('@/lib/api-utils', () => ({
  __esModule: true,
  ...jest.requireActual('@/lib/api-utils'),
  requireAdmin: jest.fn(() => Promise.resolve({ user: { id: 1, isAdmin: true } })),
  // Part 2 B3-1 (pack CB3b-ii.1): the order search is guarded by APPROVAL, not
  // admin. The default is an admin, so the ROUTES row below keeps its admin
  // answer; the member arm is its own `it` further down.
  requireApproved: jest.fn(() =>
    Promise.resolve({ user: { id: 1, isAdmin: true, isApproved: true } }),
  ),
  // M2b: the table gained a WRITER, whose guards are pinned in its own suite.
  requireCSRF: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/lib/rateLimit', () => {
  const actual = jest.requireActual('@/lib/rateLimit');
  return { __esModule: true, ...actual, enforceRateLimit: jest.fn(() => ({})) };
});

jest.mock('@/lib/prisma', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockDeep } = require('jest-mock-extended');
  return { __esModule: true, default: mockDeep() };
});

import { NextRequest } from 'next/server';
import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended';
import type { Prisma, PrismaClient } from '@prisma/client';
import prisma from '@/lib/prisma';
import { requireApproved } from '@/lib/api-utils';
import {
  RECONCILIATION_PII_FIELD_NAMES,
  assertNoPiiKeys,
} from '@/lib/reconciliation/pii';
import { __resetForTests } from '@/lib/reconciliation/attribution';
import { GET as reportGET } from '@/app/api/reconciliation/attribution/route';
import {
  GET as detailGET,
  POST as attributePOST,
} from '@/app/api/reconciliation/attribution/[batchId]/route';
import { GET as searchGET } from '@/app/api/reconciliation/orders/search/route';
import { GET as exceptionsGET } from '@/app/api/reconciliation/exceptions/route';
import { GET as unmappedGET } from '@/app/api/reconciliation/unmapped/route';

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const mockRequireApproved = requireApproved as jest.Mock;

/**
 * An order row as a LEAKY producer would receive it: the frozen select's fields
 * plus every name the assertion forbids. The mock does not honour `select`, so
 * whatever the producer does with this row is what would happen if the select
 * were ever widened.
 */
const LEAKY_ORDER = {
  id: 'ord-1',
  orderNumber: '#1001',
  internalStatus: 'pending',
  externalCreatedAt: new Date('2026-08-09T00:00:00.000Z'),
  companyId: 'co-1',
  integration: { platform: 'WOOCOMMERCE' },
  customerEmail: 'buyer@example.com',
  customerName: 'A Buyer',
  customerPhone: '+1-555-0100',
  shippingAddress: { line1: '1 Test Street' },
  billingAddress: { line1: '1 Test Street' },
  rawPayload: { id: 4242, billing: { email: 'buyer@example.com' } },
  platformStatusRaw: { status: 'processing' },
  externalOrderUrl: 'https://shop.example.com/wp-admin/post.php?post=4242',
  // The ninth forbidden name (Part 2, pack CA1.4) is an ITEM column, not an
  // order one. It rides on this row anyway: the fixture's job is to carry every
  // name the assertion forbids, so the non-vacuity pin below stays total as the
  // set grows.
  variantName: '10 mg / 2 vials',
  _count: { items: 2 },
  // The order search's OWN select adds the store's name (pack § P2-B3-1R,
  // R-a.1); every other producer rebuilds field by field and never reads it.
  company: { name: 'Acme Store' },
};

/**
 * The MATCH's three reads, seeded as leakily as the orders are (Part 2, pack
 * CA2.3). `external_order_items` carries the customer's variant string and the
 * mock does not honour `select`, so a reader that spread its row — or a matcher
 * that carried a line onto the wire — fails the walk below rather than a code
 * review.
 *
 * The numbers are chosen so the order's match has BOTH halves of a tolerance:
 * 2 x 5 mg missing balances 4 x 2.5 mg extra (an `equivalentGroup`), and a
 * `pack` unit is refused (an `excludedProduct`). Without them the recursive
 * walk would pass over a `tolerance: null` and prove nothing.
 */
const LEAKY_ITEM_ROWS = [
  {
    id: 'item-1',
    orderId: 'ord-1',
    quantity: 2,
    fulfilledQty: 0,
    isMapped: true,
    productLinkId: 'link-1',
    bundleComponentSnapshot: null,
    productLink: { internalProductId: 9, isBundle: false, bundleComponents: [] },
    variantName: '10 mg / 2 vials',
    customerEmail: 'buyer@example.com',
  },
  {
    id: 'item-2',
    orderId: 'ord-1',
    quantity: 1,
    fulfilledQty: 0,
    isMapped: true,
    productLinkId: 'link-2',
    bundleComponentSnapshot: null,
    productLink: { internalProductId: 11, isBundle: false, bundleComponents: [] },
    variantName: '1 pack',
    customerEmail: 'buyer@example.com',
  },
];

/** The deducted side: four units of the 2.5 mg product left against this order. */
const DEDUCTED_SIDE_ROWS = [
  { orderRecordId: 'ord-1', productId: 10, outUnits: '4', correctedUnits: '0' },
];

/** The decomposition facts, seeded with names the response must never echo. */
const LEAKY_PRODUCT_ROWS = [
  {
    id: 9,
    name: 'Alpha 5 mg',
    baseName: 'alpha',
    unit: 'mg',
    numericValue: '5.00',
    variantName: '10 mg / 2 vials',
    customerName: 'A Buyer',
  },
  { id: 10, name: 'Alpha 2.5 mg', baseName: 'alpha', unit: 'mg', numericValue: '2.50' },
  { id: 11, name: 'Beta pack', baseName: 'beta', unit: 'pack', numericValue: '1.00' },
];

/** An exception row whose SUBJECT is as leaky as the orders are. */
const LEAKY_EXCEPTION_ROW = {
  id: 11,
  key: 'recv-discrepancy:501',
  kind: 'recv-discrepancy',
  subject: {
    stagingItemId: 501,
    shipmentId: 'ship-1',
    countedQty: 8,
    expectedQty: 10,
    shortUnits: 2,
    lossCents: 1200,
    customerEmail: 'buyer@example.com',
    customerName: 'A Buyer',
    shippingAddress: { line1: '1 Test Street' },
  },
  firstSeenAt: new Date('2026-08-10T00:00:00.000Z'),
  lastSeenAt: new Date('2026-08-18T00:00:00.000Z'),
  resolvedAt: null,
  resolvedBy: 7,
  resolution: null,
  // Admin free text: ALLOWED on this surface, and pinned by staying here.
  note: 'chased the supplier on the 12th',
};

/** A grouped unmapped row, seeded the same way. */
const LEAKY_UNMAPPED_ROW = {
  integrationId: 'int-1',
  externalProductId: 'P1',
  externalVariantId: null,
  integrationName: 'Acme Store',
  platform: 'WOOCOMMERCE',
  sku: 'SKU-1',
  name: 'Widget',
  itemCount: 4,
  oldest: new Date('2026-08-01T00:00:00.000Z'),
  customerEmail: 'buyer@example.com',
  rawPayload: { id: 4242 },
};

const UNMAPPED_TOTALS = {
  total: 1,
  unknownGroups: 0,
  bucket0: 0,
  bucket1: 1,
  bucket2: 0,
  bucket3: 0,
};

const SUMMARY_ROW = {
  nonAttributableBatches: 0,
  noBatchRows: 0,
  orderNumberMatches: 1,
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
  auditId: 3,
  auditActionType: 'INVENTORY_DEDUCT',
  auditEntityId: '9',
  auditOrderAttributionSource: 'selected',
  auditIntent: 'order',
  auditSelectedExternalOrderId: 'ord-1',
  auditOrderId: null,
  auditHasOrderReference: 1,
  auditHasRows: 0,
  auditHasRowsOmitted: 0,
  attemptId: 10,
  attemptOutcome: 'attributed',
  attemptEvidence: 'selected',
  attemptReason: null,
  attemptSource: 'live-deduct',
  attemptActorUserId: 7,
  attemptOrderRecordId: 'ord-1',
};

/**
 * The audit row the drill-down reads. It carries the operator's free text, which
 * IS allowed there (labelled, admin-only) — the harness cares about the eight
 * forbidden NAMES, and this row proves the two rules do not collide. It also
 * carries HOW the writer stamped (`orderAttributionSource`), which the
 * drill-down projects since B3-1 FR3.
 */
const AUDIT_ROW = {
  id: 3,
  actionType: 'INVENTORY_DEDUCT',
  entityId: '9',
  createdAt: new Date('2026-08-10T12:00:00.000Z'),
  details: {
    orderReference: '1001',
    intent: 'order',
    selectedExternalOrderId: 'ord-1',
    orderAttributionSource: 'selected',
  },
  userId: 7,
};

beforeEach(() => {
  mockReset(db);
  __resetForTests();
  mockRequireApproved.mockClear();
  mockRequireApproved.mockResolvedValue({ user: { id: 1, isAdmin: true, isApproved: true } });
  // ONE dispatcher, because FOUR producers now share the raw channel — the
  // match's deducted-side aggregate joined them at Part 2 A2, and it is
  // selected on its own alias (`AS outUnits`).
  db.$queryRaw.mockImplementation(((query: Prisma.Sql) =>
    Promise.resolve(
      query.sql.includes('AS outUnits')
        ? DEDUCTED_SIDE_ROWS
        : query.sql.includes('AS total')
          ? [UNMAPPED_TOTALS]
          : query.sql.includes('FROM grouped')
            ? [LEAKY_UNMAPPED_ROW]
            : [SUMMARY_ROW],
    )) as never);
  db.externalOrderItem.findMany.mockResolvedValue(LEAKY_ITEM_ROWS as never);
  db.product.findMany.mockResolvedValue(LEAKY_PRODUCT_ROWS as never);
  db.inventoryException.count.mockResolvedValue(1 as never);
  db.inventoryException.findMany.mockResolvedValue([LEAKY_EXCEPTION_ROW] as never);
  db.stagingItem.findMany.mockResolvedValue([] as never);
  db.orderAttributionAttempt.findFirst.mockResolvedValue(null as never);
  db.orderAttributionAttempt.findMany.mockResolvedValue([
    {
      id: 10,
      attemptedAt: new Date('2026-08-10T12:00:00.000Z'),
      outcome: 'attributed',
      evidence: 'selected',
      reason: null,
      source: 'live-deduct',
      actorUserId: 7,
      orderRecordId: 'ord-1',
      previousOrderRecordId: null,
      details: { intent: 'order' },
    },
  ] as never);
  db.auditLog.findMany.mockResolvedValue([AUDIT_ROW] as never);
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
  db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);
  db.externalOrder.findMany.mockResolvedValue([LEAKY_ORDER] as never);
  db.externalOrder.count.mockResolvedValue(1 as never);
  // The producers batch their reads as an ARRAY; the manual attribution runs a
  // CALLBACK. One implementation serves both so the table stays one table.
  db.$transaction.mockImplementation(((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: Prisma.TransactionClient) => Promise<unknown>)(attributionTx())
      : Promise.all(arg as Promise<unknown>[])) as never);
});

/**
 * The transaction the manual attribution runs in. Its order lock returns the
 * LEAKY row on purpose: the writer reads `external_orders` through a two-column
 * projection (D6's write-path exception), and if any of it ever reached the
 * response this harness is what would say so.
 */
function attributionTx(): Prisma.TransactionClient {
  const tx = mockDeep<Prisma.TransactionClient>();
  (tx.$queryRaw as unknown as jest.Mock).mockImplementation(async (query: Prisma.Sql) =>
    query.sql.includes('external_orders')
      ? [LEAKY_ORDER]
      : [{ id: 501, productId: 9, logType: 'SALE', orderRecordId: null }],
  );
  (tx.auditLog.findMany as unknown as jest.Mock).mockResolvedValue([]);
  (tx.orderAttributionAttempt.findFirst as unknown as jest.Mock).mockResolvedValue(null);
  (tx.inventory_logs.updateMany as unknown as jest.Mock).mockResolvedValue({ count: 1 });
  (tx.orderAttributionAttempt.create as unknown as jest.Mock).mockResolvedValue({ id: 1 });
  (tx.auditLog.create as unknown as jest.Mock).mockResolvedValue({ id: 1 });
  return tx;
}

/** The lane's route table. Append a row per route as each milestone lands. */
const ROUTES: Array<{ name: string; call: () => Promise<Response> }> = [
  {
    name: 'GET /api/reconciliation/attribution',
    call: () =>
      reportGET(
        new NextRequest(
          'http://localhost/api/reconciliation/attribution?from=2026-08-01&to=2026-08-31',
        ),
      ) as Promise<Response>,
  },
  {
    name: 'GET /api/reconciliation/attribution/[batchId]',
    call: () =>
      detailGET(new NextRequest('http://localhost/api/reconciliation/attribution/batch-1'), {
        params: { batchId: 'batch-1' },
      }) as Promise<Response>,
  },
  {
    // With `productId` (R-a.1), so the walk covers `thisProduct` — read from
    // the LEAKY item rows, which carry the variant string and an email.
    name: 'GET /api/reconciliation/orders/search',
    call: () =>
      searchGET(
        new NextRequest('http://localhost/api/reconciliation/orders/search?q=100&productId=9'),
      ) as Promise<Response>,
  },
  {
    name: 'GET /api/reconciliation/exceptions',
    call: () =>
      exceptionsGET(
        new NextRequest('http://localhost/api/reconciliation/exceptions'),
      ) as Promise<Response>,
  },
  {
    name: 'GET /api/reconciliation/unmapped',
    call: () =>
      unmappedGET(
        new NextRequest('http://localhost/api/reconciliation/unmapped'),
      ) as Promise<Response>,
  },
  {
    name: 'POST /api/reconciliation/attribution/[batchId]',
    call: () =>
      attributePOST(
        new NextRequest('http://localhost/api/reconciliation/attribution/batch-1', {
          method: 'POST',
          body: JSON.stringify({ orderRecordId: 'ord-1', expectPreviousOrderRecordId: null }),
          headers: { 'content-type': 'application/json', 'x-csrf-token': 'x' },
        }),
        { params: { batchId: 'batch-1' } },
      ) as Promise<Response>,
  },
];

describe('reconciliation routes never answer with order PII', () => {
  it.each(ROUTES)('$name', async ({ call }) => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    // A response that carried nothing at all would pass vacuously.
    expect(JSON.stringify(body).length).toBeGreaterThan(50);
    expect(() => assertNoPiiKeys(body)).not.toThrow();
  });

  it("the drill-down's audit event carries HOW the batch was stamped, and stays PII-free (B3-1 FR3)", async () => {
    const res = await detailGET(new NextRequest('http://localhost/api/reconciliation/attribution/batch-1'), {
      params: { batchId: 'batch-1' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The key really rides the walked body — the walk below is not vacuous for it.
    expect(body.auditEvent.orderAttributionSource).toBe('selected');
    expect(() => assertNoPiiKeys(body)).not.toThrow();
  });

  it("the order search's MEMBER arm: scoped to the seeded companies on ALL FIVE statements, and PII-free", async () => {
    // The first member-scoped reconciliation route (Part 2 B3-1, pack
    // CB3b-ii.1). Not a ROUTES row: the table has no per-row setup slot, and a
    // zero-membership member would trip its non-vacuity floor rather than prove
    // anything — so the member here HAS companies and gets the leaky row back.
    const companyIds = ['co-1', 'co-2'];
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false, isApproved: true } });
    db.userCompany.findMany.mockResolvedValue(companyIds.map((companyId) => ({ companyId })) as never);
    // The leaky row is the EXACT group's answer (G1: the equality where); the
    // starts-with and contains groups answer nothing.
    db.externalOrder.findMany.mockImplementation(((args: { where: { orderNumber: unknown } }) =>
      Promise.resolve(typeof args.where.orderNumber === 'string' ? [LEAKY_ORDER] : [])) as never);

    const res = await searchGET(
      new NextRequest('http://localhost/api/reconciliation/orders/search?q=100&productId=9'),
    );

    expect(res.status).toBe(200);
    expect(mockRequireApproved).toHaveBeenCalledTimes(1);
    // Pack § P2-B3-1R, R-a.1: three ranked group reads and two counts, ONE
    // transaction, and the member scope on every one of the five.
    const wheres = [
      ...db.externalOrder.findMany.mock.calls,
      ...db.externalOrder.count.mock.calls,
    ].map((call) => (call[0] as { where: { companyId: { in: string[] } } }).where);
    expect(wheres).toHaveLength(5);
    for (const where of wheres) expect(where.companyId.in).toEqual(companyIds);

    const body = await res.json();
    // The leaky row came back through the projection — the walk is not vacuous.
    expect(body.orders).toHaveLength(1);
    // ...and it carries the two new fields the walk must cover.
    expect(body.orders[0].store).toBe('Acme Store');
    expect(body.orders[0].thisProduct).toEqual({ orderedUnits: 2, uncheckedLines: 0 });
    expect(JSON.stringify(body).length).toBeGreaterThan(50);
    expect(() => assertNoPiiKeys(body)).not.toThrow();
    // The variant string and the email on the item rows never reach the wire.
    expect(JSON.stringify(body)).not.toContain('10 mg / 2 vials');
    expect(JSON.stringify(body)).not.toContain('buyer@example.com');
  });

  it('the seeded orders really do carry every forbidden name (the harness is not vacuous)', () => {
    for (const name of Array.from(RECONCILIATION_PII_FIELD_NAMES)) {
      expect(Object.prototype.hasOwnProperty.call(LEAKY_ORDER, name)).toBe(true);
    }
    expect(() => assertNoPiiKeys(LEAKY_ORDER)).toThrow();
  });

  it("the finder's admin note rides through — `note` is not a forbidden name (CX-6)", async () => {
    const res = await exceptionsGET(new NextRequest('http://localhost/api/reconciliation/exceptions'));
    const body = await res.json();
    expect(body.rows[0].note).toBe('chased the supplier on the 12th');
    expect(() => assertNoPiiKeys(body)).not.toThrow();
  });

  it('the seeded exception subject really is leaky too (the new rows are not vacuous)', () => {
    expect(() => assertNoPiiKeys(LEAKY_EXCEPTION_ROW)).toThrow('subject.customerEmail');
    expect(() => assertNoPiiKeys(LEAKY_UNMAPPED_ROW)).toThrow('customerEmail');
  });

  it('the walked envelopes really DO carry a match and a tolerance (not vacuous)', async () => {
    const report = await (
      await reportGET(
        new NextRequest(
          'http://localhost/api/reconciliation/attribution?from=2026-08-01&to=2026-08-31',
        ),
      )
    ).json();
    const match = report.rows[0].match;
    expect(match).not.toBeNull();
    expect(match.perProduct.length).toBeGreaterThan(0);
    expect(match.tolerance).not.toBeNull();
    expect(match.tolerance.equivalentGroups.length).toBeGreaterThan(0);
    expect(match.tolerance.excludedProducts.length).toBeGreaterThan(0);

    const detail = await (
      await detailGET(new NextRequest('http://localhost/api/reconciliation/attribution/batch-1'), {
        params: { batchId: 'batch-1' },
      })
    ).json();
    expect(detail.orderMatch).not.toBeNull();
    expect(detail.orderMatch.tolerance).not.toBeNull();
  });

  it('the positive control: a variantName on a perProduct row is caught, with its path', () => {
    // The match nests three arrays deep; the walk is recursive, and this is the
    // fixture that says so from the outside.
    const fixture = { rows: [{ match: { perProduct: [{ variantName: '10 mg / 2 vials' }] } }] };
    expect(() => assertNoPiiKeys(fixture)).toThrow('rows[0].match.perProduct[0].variantName');
  });

  it('the positive control: customerEmail three levels deep is caught, with its path', () => {
    const fixture = { rows: [{ order: { customerEmail: 'buyer@example.com' } }] };
    expect(() => assertNoPiiKeys(fixture)).toThrow('rows[0].order.customerEmail');
  });
});
