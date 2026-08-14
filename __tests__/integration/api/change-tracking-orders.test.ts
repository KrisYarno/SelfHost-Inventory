// @jest-environment node
/**
 * Task 12 (change-tracking) — orders group characterization.
 *
 * Proves the fulfill/unfulfill call sites now capture their ORDER change through
 * the REAL `@/lib/change-tracking` recordChange path, INSIDE the deduction
 * transaction (spec R-D2 same-tx / R-D8 company-scoped pass-through):
 *
 *   - the audit write lands on the IDENTICAL tx object as the stock mutation
 *     (both `tx.auditLog.create` and the item/order writes fire on `mockTx`);
 *   - entityType=ORDER, entityId = the ExternalOrder cuid (FIRST cuid entity in
 *     the system) — the cuid passes `normalizeEntityId` UNTOUCHED;
 *   - companyId is threaded from the loaded order (company-scoped assertion);
 *   - ONE batchId per request is shared by the event AND echoed into
 *     details.batchId so the audit row and its ledger rows are joinable.
 *
 * change-tracking is NOT mocked here — we drive the real payload builder so the
 * entityId-normalization and companyId-assertion CONTRACTS are exercised for
 * real, not stubbed.
 */

jest.mock('@/lib/api-utils', () => ({
  ...jest.requireActual('@/lib/api-utils'),
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(),
  requireCompanyMembership: jest.fn(),
  requireCSRF: jest.fn(),
}));

jest.mock('@/lib/rateLimit', () => ({
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((r: any) => r),
}));

// The deduction ledger writer — mocked so tx.inventory_logs isn't exercised.
jest.mock('@/lib/inventory', () => ({
  createInventoryLog: jest.fn(async () => ({ id: 100 })),
}));

// Best-effort external side-effects — never reached on the happy path, mocked
// defensively so nothing hits the network / real prisma.
jest.mock('@/lib/external-orders/stock-sync', () => ({
  pushStockForProducts: jest.fn(async () => undefined),
}));
jest.mock('@/lib/external-orders/shared', () => ({
  pushOrderStatusToExternal: jest.fn(async () => ({ success: true })),
}));

// Module-level prisma: the route preloads companyId + drives $transaction here.
jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    externalOrder: { findUnique: jest.fn() },
    integration: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}));

import { NextRequest } from 'next/server';
import { POST as FULFILL } from '@/app/api/orders/[orderId]/fulfill/route';
import { POST as UNFULFILL } from '@/app/api/orders/[orderId]/unfulfill/route';
import {
  requireApproved,
  requireCompanyMembership,
  requireCSRF,
} from '@/lib/api-utils';
import { recordChange, normalizeEntityId } from '@/lib/change-tracking';
import prisma from '@/lib/prisma';

// A real cuid — the FIRST cuid entity type (ORDER). Numeric-coercion of this id
// would have yielded NaN under the pre-migration entityId contract; it MUST flow
// through as-is now.
const ORDER_CUID = 'cmdq7f3k80001s6h4p2n9wxyz';
const COMPANY_ID = 'company-abc';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const db = prisma as unknown as {
  externalOrder: { findUnique: jest.Mock };
  integration: { findUnique: jest.Mock };
  $transaction: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({
    user: { id: 7, isAdmin: false, isApproved: true },
  });
  (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
  (requireCSRF as jest.Mock).mockResolvedValue(undefined);
  // companyId preload (both routes) — the loaded order carries the companyId.
  db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID });
  db.integration.findUnique.mockResolvedValue({ fulfillmentPushEnabled: false });
});

function reqWith(body: unknown, path: string) {
  return new NextRequest(`http://x${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// FULFILL — event lands in lib/fulfillment.ts's deduction tx via the `record`
// callback (the only same-tx seam; a route-level wrap would spawn a nested tx).
// ---------------------------------------------------------------------------

function makeFulfillTx() {
  const order = {
    id: ORDER_CUID,
    externalId: 'ext-1',
    integrationId: 'int-1',
    internalStatus: 'pending',
    fulfilledAt: null,
    fulfilledBy: null,
    integration: { id: 'int-1', platform: 'WOOCOMMERCE', fulfillmentPushEnabled: false },
    items: [
      {
        id: 'item-1',
        orderId: ORDER_CUID,
        quantity: 2,
        fulfilledQty: 0,
        name: 'Widget A',
        sku: 'WA-001',
        isMapped: true,
        productLink: {
          internalProduct: { id: 10, name: 'Widget A' },
          isBundle: false,
          bundleComponents: [],
        },
      },
    ],
  };
  return {
    externalOrder: {
      findUnique: jest.fn().mockResolvedValue(order),
      update: jest.fn().mockResolvedValue({}),
    },
    product: { findUnique: jest.fn().mockResolvedValue({ name: 'Widget A' }) },
    externalOrderItem: {
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([{ quantity: 2, fulfilledQty: 2 }]),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    // W2S-1: fulfillment brackets each item's writes in a SAVEPOINT, issued
    // through $executeRawUnsafe. This stand-in only ever takes the happy path,
    // so the statements are accepted and ignored — the savepoint's own semantics
    // are pinned in fulfillment.item-savepoint.test.ts against a store that
    // actually models them.
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    auditLog: { create: jest.fn().mockResolvedValue({ id: 1 }) },
  };
}

test('FULFILL records an ORDER change on the SAME tx as the deduction (cuid + companyId + shared batchId)', async () => {
  const tx = makeFulfillTx();
  db.$transaction.mockImplementation(async (cb: any) => cb(tx));

  const res = await FULFILL(
    reqWith({ locationId: 5, items: [{ itemId: 'item-1', quantity: 2 }] }, `/api/orders/${ORDER_CUID}/fulfill`),
    { params: { orderId: ORDER_CUID } } as any
  );

  expect(res.status).toBe(200);

  // Same-tx: both the stock mutation AND the audit write fired on `tx`.
  expect(tx.externalOrderItem.update).toHaveBeenCalled();
  expect(tx.externalOrder.update).toHaveBeenCalled();
  expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  expect(db.$transaction).toHaveBeenCalledTimes(1);

  const data = tx.auditLog.create.mock.calls[0][0].data;
  expect(data.entityType).toBe('ORDER');
  // cuid passes normalizeEntityId untouched — the whole point of the migration.
  expect(data.entityId).toBe(ORDER_CUID);
  expect(data.companyId).toBe(COMPANY_ID);
  expect(data.actionType).toBe('EXTERNAL_ORDER_FULFILLMENT');
  expect(data.affectedCount).toBe(1);

  // ONE batchId shared by the event row and echoed into its details.
  expect(typeof data.batchId).toBe('string');
  expect(data.batchId).toMatch(UUID_RE);
  expect(data.details.batchId).toBe(data.batchId);
});

test('FULFILL emits the PARTIAL actionType when only some requested items fulfill', async () => {
  const tx = makeFulfillTx();
  // Two items requested; only item-1 exists in the order, so item-2 fails ->
  // fulfilledCount (1) < requested items (2) -> partial.
  db.$transaction.mockImplementation(async (cb: any) => cb(tx));

  const res = await FULFILL(
    reqWith(
      {
        locationId: 5,
        items: [
          { itemId: 'item-1', quantity: 2 },
          { itemId: 'missing', quantity: 1 },
        ],
      },
      `/api/orders/${ORDER_CUID}/fulfill`
    ),
    { params: { orderId: ORDER_CUID } } as any
  );

  expect(res.status).toBe(200);
  const data = tx.auditLog.create.mock.calls[0][0].data;
  expect(data.actionType).toBe('EXTERNAL_ORDER_PARTIAL_FULFILLMENT');
  expect(data.entityType).toBe('ORDER');
  expect(data.entityId).toBe(ORDER_CUID);
});

// ---------------------------------------------------------------------------
// UNFULFILL — event lands in the route's own route-level tx.
// ---------------------------------------------------------------------------

function makeUnfulfillTx() {
  const order = {
    id: ORDER_CUID,
    externalId: 'ext-1',
    integrationId: 'int-1',
    internalStatus: 'processing',
    stockedOut: true,
    stockedOutAt: new Date(),
    stockedOutBy: 1,
    fulfilledAt: null,
    fulfilledBy: null,
    companyId: COMPANY_ID,
    integration: { id: 'int-1', fulfillmentPushEnabled: false },
    items: [
      {
        id: 'item-1',
        quantity: 1,
        fulfilledQty: 1,
        isMapped: true,
        bundleComponentSnapshot: null,
        productLink: { internalProductId: 10, isBundle: false, bundleComponents: [] },
      },
    ],
  };
  return {
    externalOrder: {
      findUnique: jest.fn().mockResolvedValue(order),
      update: jest.fn().mockResolvedValue({}),
    },
    product: { findUnique: jest.fn().mockResolvedValue({ id: 10, deletedAt: null }) },
    externalOrderItem: {
      findMany: jest.fn().mockResolvedValue([{ quantity: 1, fulfilledQty: 0 }]),
    },
    product_locations: { create: jest.fn().mockResolvedValue({}) },
    $executeRaw: jest.fn().mockResolvedValue(1),
    auditLog: { create: jest.fn().mockResolvedValue({ id: 2 }) },
  };
}

test('UNFULFILL records an ORDER change on the route tx (cuid + companyId + shared batchId)', async () => {
  const tx = makeUnfulfillTx();
  db.$transaction.mockImplementation(async (cb: any) => cb(tx));

  const res = await UNFULFILL(
    reqWith(
      { items: [{ itemId: 'item-1', productId: 10, quantity: 1, locationId: 5 }] },
      `/api/orders/${ORDER_CUID}/unfulfill`
    ),
    { params: { orderId: ORDER_CUID } } as any
  );

  expect(res.status).toBe(200);

  // Same-tx: the restoration write AND the audit write fired on `tx`.
  expect(tx.externalOrder.update).toHaveBeenCalled();
  expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  expect(db.$transaction).toHaveBeenCalledTimes(1);

  const data = tx.auditLog.create.mock.calls[0][0].data;
  expect(data.entityType).toBe('ORDER');
  expect(data.entityId).toBe(ORDER_CUID);
  expect(data.companyId).toBe(COMPANY_ID);
  expect(data.actionType).toBe('EXTERNAL_ORDER_UNFULFILLMENT');
  expect(data.affectedCount).toBe(1);

  expect(typeof data.batchId).toBe('string');
  expect(data.batchId).toMatch(UUID_RE);
  expect(data.details.batchId).toBe(data.batchId);
});

// ---------------------------------------------------------------------------
// R-D8 company-scoped ORDER contract (exercised against the REAL recordChange).
// ---------------------------------------------------------------------------

describe('R-D8: ORDER is company-scoped — recordChange asserts companyId', () => {
  test('throws (test env) when an ORDER event omits companyId — the contract working', async () => {
    const tx = { auditLog: { create: jest.fn() } } as any;
    await expect(
      recordChange(tx, {
        actor: { userId: 1 },
        actionType: 'EXTERNAL_ORDER_FULFILLMENT',
        entityType: 'ORDER',
        entityId: ORDER_CUID,
        action: 'fulfill without companyId',
      })
    ).rejects.toThrow(/companyId is required/i);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  test('persists with companyId; the cuid entityId is stored untouched', async () => {
    const tx = { auditLog: { create: jest.fn().mockResolvedValue({}) } } as any;
    await recordChange(tx, {
      actor: { userId: 1 },
      actionType: 'EXTERNAL_ORDER_FULFILLMENT',
      entityType: 'ORDER',
      entityId: ORDER_CUID,
      companyId: COMPANY_ID,
      action: 'fulfill',
    });
    const data = tx.auditLog.create.mock.calls[0][0].data;
    expect(data.companyId).toBe(COMPANY_ID);
    expect(data.entityId).toBe(ORDER_CUID);
    // Direct proof: the cuid survives normalization verbatim.
    expect(normalizeEntityId(ORDER_CUID)).toBe(ORDER_CUID);
  });
});
