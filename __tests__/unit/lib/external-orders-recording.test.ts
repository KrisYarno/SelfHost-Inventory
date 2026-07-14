/**
 * @jest-environment node
 *
 * Task 8 (change-tracking Phase B) — external-orders R-D4 ingestion recording.
 *
 * Three layers, one file:
 *   A. `upsertOrderWithItems` R-D4 gate matrix (real fn, mockDeep client) — the
 *      gate is `summary.changed`, computed from a MATERIAL FIELD-SET diff + the
 *      item set (P-B3), normalized per ER-B1 (Decimal/Date via String()).
 *   B. Webhook route (real upsert on the module-mocked prisma; REAL
 *      recordIngestion): change writes ONE ORDER audit row (actorKind WEBHOOK +
 *      companyId); no-change replay writes NONE; ER-B3 survival (ingestion
 *      failure AFTER recordWebhookSuccess still ends failureCount=1); ER-B4
 *      delete branch (delete → EXTERNAL_ORDER_DELETE + snapshot; protected /
 *      not-found → nothing).
 *   C. Recheck route (USER tier, onRecorded joins the upsert tx; record failure
 *      aborts the upsert) + cron sync (per-run lastSyncError write / clear).
 *
 * change-tracking is NOT mocked — the real payload builder + gate run so the
 * companyId assertion and normalization contracts are exercised for real.
 */

import { mockDeep } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { NormalizedOrder } from '@/lib/platforms/core/types';

// deriveExternalOrderMeta — fixed values so the upsert payload is deterministic.
jest.mock('@/lib/external-orders/meta', () => ({
  deriveExternalOrderMeta: jest.fn(() => ({
    platformStatusRaw: { status: 'processing' },
    externalStatusHash: 'hash123',
    externalOrderUrl: 'https://store.test/admin/orders/ext-1',
    externalUpdatedAt: new Date('2025-01-15T00:00:00Z'),
    lastSeenAt: new Date('2025-06-01T00:00:00Z'),
  })),
}));

// Module-level prisma — configurable manual mock. Used by the routes, sync, and
// the REAL recordChange/recordIngestion (auditLog.create). Block A passes its
// OWN mockDeep client to upsertOrderWithItems and never touches this.
jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    integration: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    externalOrder: { findUnique: jest.fn() },
    userCompany: { findFirst: jest.fn() },
    auditLog: { create: jest.fn() },
    // Lane 5 S2: the webhook route now takes a dedup claim; the manual mock must
    // expose webhookDelivery or every pre-existing webhook case fails at the claim.
    webhookDelivery: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

// Route auth — passthrough handler + stubbed guards.
jest.mock('@/lib/api-utils', () => ({
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(),
  requireCSRF: jest.fn(),
  requireCompanyMembership: jest.fn(),
}));

// Platform adapter — controllable fake (webhook + recheck + sync).
jest.mock('@/lib/platforms/core/registry', () => ({
  getPlatformAdapter: jest.fn(),
}));

import { NextRequest } from 'next/server';
import prisma from '@/lib/prisma';
import { getPlatformAdapter } from '@/lib/platforms/core/registry';
import { requireApproved, requireCSRF, requireCompanyMembership } from '@/lib/api-utils';
import { AppError } from '@/lib/error-handling';
import { upsertOrderWithItems } from '@/lib/external-orders/shared';
import { POST as WEBHOOK_POST } from '@/app/api/webhooks/[integrationId]/route';
import { POST as RECHECK_POST } from '@/app/api/orders/external/[orderId]/recheck/route';
import { syncIntegrationOrders } from '@/lib/external-orders/sync';

const db = prisma as unknown as {
  integration: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
  externalOrder: { findUnique: jest.Mock };
  userCompany: { findFirst: jest.Mock };
  auditLog: { create: jest.Mock };
  webhookDelivery: {
    create: jest.Mock;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
    findMany: jest.Mock;
    deleteMany: jest.Mock;
  };
  $transaction: jest.Mock;
};

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const COMPANY_ID = 'comp-1';
const ORDER_ID = 'order-1';

function buildNormalized(overrides: Partial<NormalizedOrder> = {}): NormalizedOrder {
  return {
    externalId: 'ext-1',
    externalOrderNumber: '#1001',
    platform: 'WOOCOMMERCE',
    nativeStatus: 'processing',
    financialStatus: null,
    fulfillmentStatus: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    customer: { email: 'test@example.com', name: 'Test User' },
    lineItems: [
      {
        externalId: 'item-1',
        externalProductId: 'prod-1',
        externalVariantId: null,
        name: 'Widget',
        variantName: null,
        sku: 'WDG-001',
        quantity: 2,
        unitPrice: 10,
      },
    ],
    currency: 'USD',
    total: 99.99,
    rawPayload: { id: 'ext-1' },
    ...overrides,
  };
}

/** A before-image row matching buildNormalized() exactly (no diff). Prices are
 *  plain numbers unless `decimal` is set (ER-B1 Decimal-typed variant). */
function matchingBefore(opts: { decimal?: boolean } = {}) {
  const price = opts.decimal ? new Prisma.Decimal('10.00') : 10;
  const total = opts.decimal ? new Prisma.Decimal('99.99') : 99.99;
  return {
    nativeStatus: 'processing',
    financialStatus: null,
    fulfillmentStatus: null,
    internalStatus: 'processing',
    total,
    currency: 'USD',
    customerEmail: 'test@example.com',
    customerName: 'Test User',
    orderNumber: '#1001',
    items: [{ externalItemId: 'item-1', quantity: 2, price, name: 'Widget' }],
  };
}

/** After-image item rows as returned by the post-write findMany. */
function afterItemRows(rows?: any[]) {
  return rows ?? [{ externalItemId: 'item-1', quantity: 2, price: 10, name: 'Widget' }];
}

/**
 * Build a mockDeep tx wired for the upsert path. The two externalOrderItem
 * findMany calls resolve in order: 1st = pruned rows (before deleteMany),
 * 2nd = the after-write item set.
 */
function makeUpsertTx(cfg: {
  before?: any;
  after?: any[];
  pruned?: any[];
  upsertReturn?: any;
  auditThrows?: boolean;
}) {
  const tx = mockDeep<PrismaClient>();
  tx.externalOrder.findUnique.mockResolvedValue(cfg.before ?? null);
  tx.externalOrder.upsert.mockResolvedValue(
    cfg.upsertReturn ?? ({ id: ORDER_ID, orderNumber: '#1001' } as any)
  );
  tx.productLink.findFirst.mockResolvedValue(null);
  tx.externalOrderItem.upsert.mockResolvedValue({} as any);
  tx.externalOrderItem.create.mockResolvedValue({} as any);
  tx.externalOrderItem.findFirst.mockResolvedValue(null);
  tx.externalOrderItem.deleteMany.mockResolvedValue({ count: 0 } as any);
  tx.externalOrderItem.findMany
    .mockResolvedValueOnce((cfg.pruned ?? []) as any)
    .mockResolvedValueOnce(afterItemRows(cfg.after) as any);
  if (cfg.auditThrows) {
    tx.auditLog.create.mockRejectedValue(new Error('audit write failed'));
  } else {
    tx.auditLog.create.mockResolvedValue({ id: 1 } as any);
  }
  return tx;
}

function fetchResponse(jsonBody: unknown, link: string | null = null) {
  return {
    ok: true,
    status: 200,
    json: async () => jsonBody,
    text: async () => JSON.stringify(jsonBody),
    headers: { get: (k: string) => (k.toLowerCase() === 'link' ? link : null) },
  } as any;
}

let fakeAdapter: any;

beforeEach(() => {
  jest.clearAllMocks();
  fakeAdapter = {
    platform: 'WOOCOMMERCE',
    extractWebhookHeaders: jest.fn(() => ({
      topic: 'order.updated',
      signature: 'sig',
      source: undefined,
    })),
    verifyWebhook: jest.fn(() => ({ isValid: true })),
    parseOrderWebhook: jest.fn(() => buildNormalized()),
    updateOrderStatus: jest.fn(async () => ({ success: true })),
  };
  (getPlatformAdapter as jest.Mock).mockReturnValue(fakeAdapter);
  db.integration.update.mockResolvedValue({});
  db.integration.updateMany.mockResolvedValue({ count: 1 });
  db.auditLog.create.mockResolvedValue({ id: 1 });
  // S2 default: the claim succeeds (id 1 => no prune), finalization updates 1 row.
  db.webhookDelivery.create.mockResolvedValue({ id: 1, claimedAt: new Date() });
  db.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
  db.webhookDelivery.findMany.mockResolvedValue([]);
  db.webhookDelivery.deleteMany.mockResolvedValue({ count: 0 });
});

// ===========================================================================
// A. upsertOrderWithItems — R-D4 gate matrix (P-B3 + ER-B1)
// ===========================================================================

describe('upsertOrderWithItems — R-D4 gate', () => {
  function runUpsert(
    cfg: Parameters<typeof makeUpsertTx>[0] & { __normalized?: NormalizedOrder },
    onRecorded?: jest.Mock
  ) {
    const tx = makeUpsertTx(cfg);
    const client = mockDeep<PrismaClient>();
    client.$transaction.mockImplementation(async (cb: any) => cb(tx));
    return {
      tx,
      promise: upsertOrderWithItems(client, {
        integrationId: 'int-1',
        companyId: COMPANY_ID,
        storeUrl: 'https://store.test',
        normalized: cfg.__normalized ?? buildNormalized(),
        status: { statusMode: 'compute', platform: 'WOOCOMMERCE' },
        onRecorded,
      } as any),
    };
  }

  it('identical re-delivery → changed:false, onRecorded NOT called', async () => {
    const onRecorded = jest.fn();
    const { promise } = runUpsert({ before: matchingBefore() }, onRecorded);
    const summary = await promise;
    expect(summary.created).toBe(false);
    expect(summary.changed).toBe(false);
    expect(Object.keys(summary.changes)).toHaveLength(0);
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it('ER-B1: exact replay with Decimal-typed before-image → changed:false', async () => {
    // Prisma Decimal ("99.99"/"10.00") must normalize equal to the parsed
    // numbers via String() — otherwise every Woo/Shopify re-delivery spams.
    const { promise } = runUpsert({
      before: matchingBefore({ decimal: true }),
      after: [
        { externalItemId: 'item-1', quantity: 2, price: new Prisma.Decimal('10.00'), name: 'Widget' },
      ],
    });
    const summary = await promise;
    expect(summary.changed).toBe(false);
    expect(Object.keys(summary.changes)).toHaveLength(0);
  });

  it('status-only change → changes carries exactly that field', async () => {
    const before = { ...matchingBefore(), financialStatus: 'pending' };
    const { promise } = runUpsert({
      before,
      __normalized: buildNormalized({ financialStatus: 'paid' }),
    } as any);
    const summary = await promise;
    expect(summary.changed).toBe(true);
    expect(summary.created).toBe(false);
    expect(Object.keys(summary.changes)).toEqual(['financialStatus']);
    expect(summary.changes.financialStatus).toEqual({ from: 'pending', to: 'paid' });
  });

  it('item quantity change → items pseudo-field', async () => {
    const { promise } = runUpsert({
      before: matchingBefore(),
      after: [{ externalItemId: 'item-1', quantity: 5, price: 10, name: 'Widget' }],
    });
    const summary = await promise;
    expect(summary.changed).toBe(true);
    expect(summary.changes.items).toBeDefined();
    expect((summary.changes.items!.to as any[])[0].quantity).toBe(5);
    expect((summary.changes.items!.from as any[])[0].quantity).toBe(2);
  });

  it('pruned item → captured in prunedItems + changed:true', async () => {
    const before = {
      ...matchingBefore(),
      items: [
        { externalItemId: 'item-1', quantity: 2, price: 10, name: 'Widget' },
        { externalItemId: 'item-2', quantity: 1, price: 5, name: 'Gadget' },
      ],
    };
    const { promise } = runUpsert({
      before,
      after: [{ externalItemId: 'item-1', quantity: 2, price: 10, name: 'Widget' }],
      pruned: [{ id: 'i2', externalItemId: 'item-2', productLinkId: null }],
    });
    const summary = await promise;
    expect(summary.changed).toBe(true);
    expect(summary.prunedItems).toEqual([
      { id: 'i2', externalItemId: 'item-2', productLinkId: null },
    ]);
    expect(summary.changes.items).toBeDefined();
  });

  it('created → created:true + changed:true + onRecorded invoked', async () => {
    const onRecorded = jest.fn();
    const { tx, promise } = runUpsert({ before: null }, onRecorded);
    const summary = await promise;
    expect(summary.created).toBe(true);
    expect(summary.changed).toBe(true);
    expect(onRecorded).toHaveBeenCalledTimes(1);
    // onRecorded joins the SAME tx as the write (mock identity).
    expect(onRecorded.mock.calls[0][0]).toBe(tx);
  });
});

// ===========================================================================
// B. Webhook route — machine ingestion (WEBHOOK actor, best-effort)
// ===========================================================================

function webhookRequest(body: unknown) {
  return new NextRequest('http://x/api/webhooks/int-1', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function wooIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-1',
    companyId: COMPANY_ID,
    isActive: true,
    platform: 'WOOCOMMERCE',
    storeUrl: 'https://store.test',
    webhookSecret: 'shh',
    encryptedApiSecret: null,
    company: { id: COMPANY_ID },
    ...overrides,
  };
}

describe('webhook route — R-D4 create/update ingestion', () => {
  it('effective change writes ONE ORDER audit row (actorKind WEBHOOK + companyId)', async () => {
    db.integration.findUnique.mockResolvedValue(wooIntegration());
    fakeAdapter.parseOrderWebhook.mockReturnValue(buildNormalized({ financialStatus: 'paid' }));
    const tx = makeUpsertTx({ before: { ...matchingBefore(), financialStatus: 'pending' } });
    db.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const res = await WEBHOOK_POST(webhookRequest({ id: 'ext-1' }), {
      params: { integrationId: 'int-1' },
    } as any);

    expect(res.status).toBe(200);
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    const data = db.auditLog.create.mock.calls[0][0].data;
    expect(data.actorKind).toBe('WEBHOOK');
    expect(data.entityType).toBe('ORDER');
    expect(data.entityId).toBe(ORDER_ID);
    expect(data.companyId).toBe(COMPANY_ID);
    expect(data.actionType).toBe('EXTERNAL_ORDER_UPDATE');
    // recordWebhookSuccess ran BEFORE the ingestion record (ER-B3 order).
    expect(db.integration.update).toHaveBeenCalled();
  });

  it('no-change replay writes NO audit row (R-D4 gate)', async () => {
    db.integration.findUnique.mockResolvedValue(wooIntegration());
    fakeAdapter.parseOrderWebhook.mockReturnValue(buildNormalized());
    const tx = makeUpsertTx({ before: matchingBefore() });
    db.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const res = await WEBHOOK_POST(webhookRequest({ id: 'ext-1' }), {
      params: { integrationId: 'int-1' },
    } as any);

    expect(res.status).toBe(200);
    expect(db.auditLog.create).not.toHaveBeenCalled();
    // Health still recorded even with no change event.
    expect(db.integration.update).toHaveBeenCalled();
  });

  it('ER-B3: ingestion failure AFTER recordWebhookSuccess → failureCount ends 1, 200', async () => {
    db.integration.findUnique.mockResolvedValue(wooIntegration());
    fakeAdapter.parseOrderWebhook.mockReturnValue(buildNormalized({ financialStatus: 'paid' }));
    const tx = makeUpsertTx({ before: { ...matchingBefore(), financialStatus: 'pending' } });
    db.$transaction.mockImplementation(async (cb: any) => cb(tx));
    // The ingestion audit row (module prisma) fails.
    db.auditLog.create.mockRejectedValue(new Error('audit down'));

    const res = await WEBHOOK_POST(webhookRequest({ id: 'ext-1' }), {
      params: { integrationId: 'int-1' },
    } as any);

    expect(res.status).toBe(200); // recordIngestion never throws
    // update[0] = recordWebhookSuccess (reset to 0); update[1] = onFailure bump.
    const calls = db.integration.update.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0][0].data.webhookFailureCount).toBe(0);
    const failCall = calls[calls.length - 1][0].data;
    expect(failCall.webhookFailureCount).toEqual({ increment: 1 });
    expect(failCall.lastWebhookError).toBe('change-tracking write failed');
  });
});

describe('webhook route — ER-B4 delete branch', () => {
  function deleteTx(existing: any) {
    const tx = mockDeep<PrismaClient>();
    tx.externalOrder.findUnique.mockResolvedValue(existing);
    tx.externalOrderItem.deleteMany.mockResolvedValue({ count: 1 } as any);
    tx.externalOrder.delete.mockResolvedValue({} as any);
    return tx;
  }

  beforeEach(() => {
    db.integration.findUnique.mockResolvedValue(wooIntegration());
    fakeAdapter.extractWebhookHeaders.mockReturnValue({
      topic: 'order.deleted',
      signature: 'sig',
      source: undefined,
    });
  });

  it('platform delete → EXTERNAL_ORDER_DELETE with full order+items snapshot', async () => {
    const existing = {
      id: ORDER_ID,
      orderNumber: '#1001',
      stockedOut: false,
      nativeStatus: 'trash',
      total: new Prisma.Decimal('99.99'),
      items: [{ id: 'i1', externalItemId: 'item-1', quantity: 2 }],
    };
    db.$transaction.mockImplementation(async (cb: any) => cb(deleteTx(existing)));

    const res = await WEBHOOK_POST(webhookRequest({ id: 'ext-1' }), {
      params: { integrationId: 'int-1' },
    } as any);

    expect(res.status).toBe(200);
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    const data = db.auditLog.create.mock.calls[0][0].data;
    expect(data.actionType).toBe('EXTERNAL_ORDER_DELETE');
    expect(data.entityType).toBe('ORDER');
    expect(data.entityId).toBe(ORDER_ID);
    expect(data.companyId).toBe(COMPANY_ID);
    expect(data.details.snapshot.id).toBe(ORDER_ID);
    expect(data.details.snapshot.items).toHaveLength(1);
  });

  it('stockedOut-protected refusal → NO event', async () => {
    const existing = { id: ORDER_ID, orderNumber: '#1001', stockedOut: true, items: [] };
    const tx = deleteTx(existing);
    db.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const res = await WEBHOOK_POST(webhookRequest({ id: 'ext-1' }), {
      params: { integrationId: 'int-1' },
    } as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.protected).toBe(true);
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(tx.externalOrder.delete).not.toHaveBeenCalled();
  });

  it('missing order no-op → NO event', async () => {
    db.$transaction.mockImplementation(async (cb: any) => cb(deleteTx(null)));

    const res = await WEBHOOK_POST(webhookRequest({ id: 'ext-1' }), {
      params: { integrationId: 'int-1' },
    } as any);

    expect(res.status).toBe(200);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// C. Recheck route (USER tier) + cron sync (SYSTEM tier / lastSyncError)
// ===========================================================================

function recheckRequest() {
  return new NextRequest('http://x/api/orders/external/order-1/recheck', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
}

function recheckOrder() {
  return {
    id: ORDER_ID,
    companyId: COMPANY_ID,
    externalId: 'ext-1',
    integration: {
      id: 'int-1',
      platform: 'WOOCOMMERCE',
      storeUrl: 'https://store.test',
      companyId: COMPANY_ID,
      encryptedApiKey: 'key',
      encryptedApiSecret: 'secret',
    },
  };
}

describe('recheck route — USER-tier onRecorded joins the upsert tx', () => {
  beforeEach(() => {
    (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 7, isAdmin: true } });
    (requireCSRF as jest.Mock).mockResolvedValue(undefined);
    (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
    global.fetch = jest.fn().mockResolvedValue(fetchResponse({ id: 'ext-1' }));
    fakeAdapter.parseOrderWebhook.mockReturnValue(buildNormalized({ financialStatus: 'paid' }));
  });

  it('S6: non-member (membership guard throws) → AppError 404, no remote fetch, no upsert', async () => {
    (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 7, isAdmin: false } });
    db.externalOrder.findUnique.mockResolvedValue(recheckOrder());
    (requireCompanyMembership as jest.Mock).mockRejectedValue(
      new AppError('Resource not found', 'NOT_FOUND', 404)
    );

    await expect(
      RECHECK_POST(recheckRequest(), { params: { orderId: ORDER_ID } } as any)
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('records EXTERNAL_ORDER_UPDATE on the SAME tx as the upsert (mock identity)', async () => {
    db.externalOrder.findUnique.mockResolvedValue(recheckOrder());
    const tx = makeUpsertTx({ before: { ...matchingBefore(), financialStatus: 'pending' } });
    db.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const res = await RECHECK_POST(recheckRequest(), { params: { orderId: ORDER_ID } } as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    // Response contract preserved (ER): itemsProcessed / itemsMapped present.
    expect(body).toHaveProperty('itemsProcessed');
    expect(body).toHaveProperty('itemsMapped');
    // Same-tx: the audit write AND the upsert fired on the SAME tx object.
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.externalOrder.upsert).toHaveBeenCalled();
    const data = tx.auditLog.create.mock.calls[0][0].data as any;
    expect(data.actorKind).toBe('USER');
    expect(data.userId).toBe(7);
    expect(data.actionType).toBe('EXTERNAL_ORDER_UPDATE');
    expect(data.entityType).toBe('ORDER');
    expect(data.companyId).toBe(COMPANY_ID);
    expect(data.details.trigger).toBe('recheck');
  });

  it('record failure aborts the upsert (rejects — user change must not commit)', async () => {
    db.externalOrder.findUnique.mockResolvedValue(recheckOrder());
    const tx = makeUpsertTx({
      before: { ...matchingBefore(), financialStatus: 'pending' },
      auditThrows: true,
    });
    db.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await expect(
      RECHECK_POST(recheckRequest(), { params: { orderId: ORDER_ID } } as any)
    ).rejects.toThrow(/audit write failed/);
  });
});

describe('cron sync — run-level lastSyncError (R-D2)', () => {
  function shopifyIntegration() {
    return {
      id: 'int-1',
      companyId: COMPANY_ID,
      isActive: true,
      platform: 'SHOPIFY',
      storeUrl: 'https://shop.myshopify.com',
      lastSyncAt: new Date('2025-06-01T00:00:00Z'),
      encryptedApiKey: 'token',
      encryptedApiSecret: 'sec',
      company: { id: COMPANY_ID },
    };
  }

  beforeEach(() => {
    fakeAdapter.parseOrderWebhook.mockReturnValue(buildNormalized({ platform: 'SHOPIFY' }));
  });

  it('clean run clears lastSyncError and advances lastSyncAt', async () => {
    db.integration.findUnique.mockResolvedValue(shopifyIntegration());
    global.fetch = jest.fn().mockResolvedValue(fetchResponse({ orders: [{ id: 111 }] }));
    const tx = makeUpsertTx({ before: null }); // created → changed
    db.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await syncIntegrationOrders('int-1');

    // The run-level update (not the lock updateMany calls).
    expect(db.integration.update).toHaveBeenCalledTimes(1);
    const data = db.integration.update.mock.calls[0][0].data;
    expect(data.lastSyncError).toBeNull();
    expect(data.lastSyncAt).toBeInstanceOf(Date);
  });

  it('failing run writes a JSON lastSyncError and does NOT advance the cursor', async () => {
    db.integration.findUnique.mockResolvedValue(shopifyIntegration());
    global.fetch = jest.fn().mockResolvedValue(fetchResponse({ orders: [{ id: 111 }] }));
    // The order upsert throws → lands in errors[] → run is not clean.
    const tx = makeUpsertTx({ before: null });
    tx.externalOrder.upsert.mockRejectedValue(new Error('boom'));
    db.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await syncIntegrationOrders('int-1');

    expect(db.integration.update).toHaveBeenCalledTimes(1);
    const data = db.integration.update.mock.calls[0][0].data;
    expect(typeof data.lastSyncError).toBe('string');
    expect(data.lastSyncError).toContain('errorCount');
    expect(data.lastSyncAt).toBeUndefined();
  });

  it('lock-skip path writes lastSyncError (durable signal, not response-only)', async () => {
    db.integration.findUnique.mockResolvedValue(shopifyIntegration());
    db.integration.updateMany.mockResolvedValue({ count: 0 }); // lock held by another run

    const result = await syncIntegrationOrders('int-1');

    expect(result.errors[0].message).toMatch(/another run/i);
    expect(db.integration.update).toHaveBeenCalledTimes(1);
    const data = db.integration.update.mock.calls[0][0].data;
    expect(typeof data.lastSyncError).toBe('string');
    expect(data.lastSyncError).toContain('errorCount');
  });
});
