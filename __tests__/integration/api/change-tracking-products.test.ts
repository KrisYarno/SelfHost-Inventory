// @jest-environment node
/**
 * Change-tracking characterization test — Task 9 (products group).
 *
 * Proves each migrated products route records its change through the REAL
 * @/lib/change-tracking.recordChange path, and — crucially (plan recipe step 4) —
 * that the audit row is written on the SAME transaction-client instance as the
 * mutation. The prisma mock exposes one fixed `tx` object under `__tx`; both the
 * business mutation (`tx.product.*`) and the audit write (`tx.auditLog.create`)
 * must land on THAT identical object.
 *
 * recordChange is left UNMOCKED so entityId string-normalization and the
 * details.changes merge are exercised for real; only next/headers is stubbed
 * (no request scope in the node env).
 */
import { NextRequest } from 'next/server';

// Keep the REAL apiHandler (central ZodError/AppError -> status mapping) and the
// REAL requireCSRF (it calls validateCSRFToken, mocked to true); stub the auth
// guards + company-membership check.
jest.mock('@/lib/api-utils', () => {
  const actual = jest.requireActual('@/lib/api-utils');
  return {
    __esModule: true,
    ...actual,
    requireApproved: jest.fn(),
    requireAdmin: jest.fn(),
    requireCompanyMembership: jest.fn(async () => undefined),
  };
});

// One fixed tx object, shared by the top-level client and by $transaction's
// callback (spread), so "same tx instance" is provable via __tx.
jest.mock('@/lib/prisma', () => {
  const tx: any = {
    product: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    // DELETE now snapshots held stock (D8) via tx.product_locations.findMany.
    product_locations: { findMany: jest.fn(async () => []) },
    productLink: { findUnique: jest.fn() },
    location: { findUnique: jest.fn() },
    auditLog: { create: jest.fn(async () => ({ id: 1 })) },
    // W1-3b: approve/decline resolve `pending-with-stock` on the same tx as the
    // product write. Stubbed so the routes RUN; the resolution itself is owned
    // by __tests__/integration/api/product-approval-exceptions.test.ts.
    inventoryException: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(),
      update: jest.fn(),
    },
    // Receiving/Labeling overhaul (pack C2b.3 / PK-11): the writer's read is now a
    // LOCKING `SELECT ... FOR UPDATE` rather than a `findUnique`. The stub answers
    // from the same `findUnique` mock these cases already configure, so the
    // register's row shape stays set up in exactly one place.
    $queryRaw: jest.fn(async () => {
      const row = await tx.inventoryException.findUnique({});
      return row ? [row] : [];
    }),
  };
  return {
    __esModule: true,
    default: {
      ...tx,
      __tx: tx,
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    },
  };
});

jest.mock('@/lib/csrf', () => ({
  validateCSRFToken: jest.fn(async () => true),
}));

jest.mock('@/lib/rateLimit', () => ({
  __esModule: true,
  RateLimitError: jest.requireActual('@/lib/rateLimit').RateLimitError,
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((resp: any) => resp),
}));

// Pure product helpers — stub so tests focus on the record path, not naming.
jest.mock('@/lib/products', () => ({
  getProductsWithQuantities: jest.fn(),
  isProductUnique: jest.fn(async () => true),
  formatProductName: jest.fn(({ baseName, variant }: any) =>
    `${baseName ?? ''}${variant ? ' ' + variant : ''}`.trim()
  ),
}));

// PUT/GET sibling pulls getCurrentQuantity; keep the real OptimisticLockError.
jest.mock('@/lib/inventory', () => ({
  __esModule: true,
  OptimisticLockError: jest.requireActual('@/lib/inventory').OptimisticLockError,
  getCurrentQuantity: jest.fn(async () => 0),
  // Receiving/Labeling overhaul (pack C2b.3): the approve route now wraps its
  // transaction in the house deadlock retry. Run the fn once — the retry
  // BEHAVIOUR is pinned in product-approval-exceptions.test.ts.
  withDeadlockRetry: (fn: () => Promise<unknown>) => fn(),
}));

// declineProduct owns its own (retried) transaction — unit-tested separately.
jest.mock('@/lib/products/decline', () => ({
  declineProduct: jest.fn(),
}));

// price-source's external price fetch is a network call (kept OUTSIDE the tx).
jest.mock('@/lib/external-orders/price-sync', () => ({
  fetchExternalProductPrice: jest.fn(async () => ({ regularPrice: null, error: undefined })),
}));

// No request scope in node → recordChange's headers() lookup must degrade to {}.
jest.mock('next/headers', () => ({
  headers: jest.fn(async () => ({ get: () => null })),
}));

import { POST as createPOST } from '@/app/api/products/route';
import { PUT as updatePUT, DELETE as deleteDELETE } from '@/app/api/products/[id]/route';
import { POST as priceSourcePOST } from '@/app/api/products/[id]/price-source/route';
import { POST as approvePOST } from '@/app/api/admin/products/[id]/approve/route';
import { POST as declinePOST } from '@/app/api/admin/products/[id]/decline/route';
import { requireApproved, requireAdmin } from '@/lib/api-utils';
import { validateCSRFToken } from '@/lib/csrf';
import { declineProduct } from '@/lib/products/decline';
import { fetchExternalProductPrice } from '@/lib/external-orders/price-sync';
import prisma from '@/lib/prisma';

const db: any = prisma as any;
const tx: any = db.__tx;
const mockValidateCSRF = validateCSRFToken as jest.Mock;

const ADMIN_USER = { id: 9, isAdmin: true, isApproved: true };

function setApproved(user: any) {
  (requireApproved as jest.Mock).mockResolvedValue({ user });
}
function setAdmin(user: any = ADMIN_USER) {
  (requireAdmin as jest.Mock).mockResolvedValue({ user });
}
function mkReq(url: string, method: string, body?: any) {
  return new NextRequest(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
  });
}
function lastAuditData() {
  return tx.auditLog.create.mock.calls[0][0].data;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockValidateCSRF.mockResolvedValue(true);
  db.location.findUnique.mockResolvedValue({ id: 1, name: 'Main' });
  (fetchExternalProductPrice as jest.Mock).mockResolvedValue({
    regularPrice: null,
    error: undefined,
  });
});

describe('POST /api/products — PRODUCT_CREATE', () => {
  it('records PRODUCT_CREATE on the SAME tx as product.create (entityId normalized to string)', async () => {
    setApproved(ADMIN_USER);
    tx.product.create.mockResolvedValue({ id: 50, name: 'BPC 5mg' });

    const resp = await createPOST(
      mkReq('http://t/api/products', 'POST', { baseName: 'BPC', variant: '5mg', locationId: 1 })
    );

    expect(resp.status).toBe(201);
    // same-tx proof: both writes landed on the identical injected tx instance.
    expect(tx.product.create).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const data = lastAuditData();
    expect(data.actionType).toBe('PRODUCT_CREATE');
    expect(data.entityType).toBe('PRODUCT');
    expect(data.entityId).toBe('50'); // number id -> string
    expect(data.userId).toBe(ADMIN_USER.id);
    expect(data.action).toBe('Created product "BPC 5mg"');
    expect(data.details).toMatchObject({ productName: 'BPC 5mg' });
  });
});

describe('PUT /api/products/[id] — PRODUCT_UPDATE', () => {
  it('routes the pre-built {from,to} diff through recordChange on the mutation tx', async () => {
    setApproved(ADMIN_USER);
    db.product.findUnique
      .mockResolvedValueOnce({ createdBy: 999, approvalStatus: 'APPROVED', deletedAt: null })
      .mockResolvedValueOnce({
        id: 5,
        baseName: 'BPC',
        variant: '5mg',
        unit: null,
        numericValue: null,
        lowStockThreshold: 10,
        costPrice: 0,
        retailPrice: 0,
      });
    tx.product.update.mockResolvedValue({ id: 5, name: 'BPC 5mg' });

    const resp = await updatePUT(
      mkReq('http://t/api/products/5', 'PUT', { retailPrice: 99 }),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(200);
    expect(tx.product.update).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const data = lastAuditData();
    expect(data.actionType).toBe('PRODUCT_UPDATE');
    expect(data.entityId).toBe('5');
    // pre-built diff flows verbatim under details.changes
    expect(data.details.changes).toEqual({ retailPrice: { from: 0, to: 99 } });
    expect(data.details.productName).toBe('BPC 5mg');
  });
});

describe('DELETE /api/products/[id] — PRODUCT_DELETE', () => {
  it('records PRODUCT_DELETE on the soft-delete tx', async () => {
    setAdmin();
    db.product.findUnique.mockResolvedValue({ id: 5, name: 'BPC 5mg', deletedAt: null });
    tx.product.update.mockResolvedValue({ id: 5, name: 'BPC 5mg' });

    const resp = await deleteDELETE(
      mkReq('http://t/api/products/5', 'DELETE'),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(200);
    expect(tx.product.update).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const data = lastAuditData();
    expect(data.actionType).toBe('PRODUCT_DELETE');
    expect(data.entityId).toBe('5');
    expect(data.action).toBe('Deleted product "BPC 5mg"');
  });
});

describe('POST /api/products/[id]/price-source — BUG FIX (PRODUCT_UPDATE + real diff)', () => {
  it('clear-source emits PRODUCT_UPDATE with {priceSourceLinkId:{from,to:null}} on the tx', async () => {
    setAdmin();
    db.product.findFirst.mockResolvedValue({
      id: 10,
      name: 'P',
      priceSourceLinkId: 'old-link',
      retailPrice: 5,
    });
    tx.product.update.mockResolvedValue({ id: 10 });

    const resp = await priceSourcePOST(
      mkReq('http://t/api/products/10/price-source', 'POST', { linkId: null }),
      { params: { id: '10' } }
    );

    expect(resp.status).toBe(200);
    expect(tx.product.update).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const data = lastAuditData();
    expect(data.actionType).toBe('PRODUCT_UPDATE'); // NOT "ProductUpdate"
    expect(data.entityId).toBe('10');
    expect(data.details.changes).toEqual({
      priceSourceLinkId: { from: 'old-link', to: null },
    });
  });

  it('set-source emits PRODUCT_UPDATE with {priceSourceLinkId:{from,to:linkId}} (no sync)', async () => {
    setAdmin();
    db.product.findFirst.mockResolvedValue({
      id: 10,
      name: 'P',
      priceSourceLinkId: null,
      retailPrice: 5,
    });
    db.productLink.findUnique.mockResolvedValue({
      id: 'link-1',
      internalProductId: 10,
      externalProductId: 'ext-1',
      externalVariantId: null,
      externalTitle: 'Ext Title',
      integration: { id: 1, companyId: 'c1', name: 'Shopify', platform: 'shopify' },
    });
    tx.product.update.mockResolvedValue({ id: 10 });

    const resp = await priceSourcePOST(
      mkReq('http://t/api/products/10/price-source', 'POST', { linkId: 'link-1', syncNow: false }),
      { params: { id: '10' } }
    );

    expect(resp.status).toBe(200);
    expect(fetchExternalProductPrice).not.toHaveBeenCalled();
    expect(tx.product.update).toHaveBeenCalledTimes(1); // only priceSourceLinkId
    const data = lastAuditData();
    expect(data.actionType).toBe('PRODUCT_UPDATE');
    expect(data.details.changes).toEqual({
      priceSourceLinkId: { from: null, to: 'link-1' },
    });
  });

  it('set-source with syncNow fetches price OUTSIDE the tx then updates retail INSIDE it', async () => {
    setAdmin();
    db.product.findFirst.mockResolvedValue({
      id: 10,
      name: 'P',
      priceSourceLinkId: null,
      retailPrice: 5,
    });
    db.productLink.findUnique.mockResolvedValue({
      id: 'link-1',
      internalProductId: 10,
      externalProductId: 'ext-1',
      externalVariantId: null,
      externalTitle: 'Ext Title',
      integration: { id: 1, companyId: 'c1', name: 'Shopify', platform: 'shopify' },
    });
    (fetchExternalProductPrice as jest.Mock).mockResolvedValue({
      regularPrice: 99,
      error: undefined,
    });
    tx.product.update.mockResolvedValue({ id: 10 });

    const resp = await priceSourcePOST(
      mkReq('http://t/api/products/10/price-source', 'POST', { linkId: 'link-1', syncNow: true }),
      { params: { id: '10' } }
    );

    expect(resp.status).toBe(200);
    expect(fetchExternalProductPrice).toHaveBeenCalledTimes(1);
    // priceSourceLinkId update + retailPrice update, both in the tx
    expect(tx.product.update).toHaveBeenCalledTimes(2);
    const data = lastAuditData();
    expect(data.actionType).toBe('PRODUCT_UPDATE');
    expect(data.details.newRetailPrice).toBe(99);
    expect(data.details.changes).toEqual({
      priceSourceLinkId: { from: null, to: 'link-1' },
    });
  });
});

describe('POST /api/admin/products/[id]/approve — PRODUCT_APPROVE', () => {
  it('records PRODUCT_APPROVE on the approval tx', async () => {
    setAdmin();
    tx.product.update.mockResolvedValue({ id: 5, approvalStatus: 'APPROVED' });

    const resp = await approvePOST(
      mkReq('http://t/api/admin/products/5/approve', 'POST'),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(200);
    expect(tx.product.update).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const data = lastAuditData();
    expect(data.actionType).toBe('PRODUCT_APPROVE');
    expect(data.entityId).toBe('5');
    expect(data.userId).toBe(ADMIN_USER.id);
  });
});

describe('POST /api/admin/products/[id]/decline — PRODUCT_DECLINE (seam fix)', () => {
  it('hands declineProduct an in-tx record callback + shared batchId; the callback records PRODUCT_DECLINE', async () => {
    setAdmin();
    (declineProduct as jest.Mock).mockResolvedValue({ reversed: true, alreadyDeclined: false });

    const resp = await declinePOST(
      mkReq('http://t/api/admin/products/7/decline', 'POST'),
      { params: { id: '7' } }
    );

    expect(resp.status).toBe(200);

    // Phase C seam fix: the route no longer records in its OWN separate tx — it
    // passes declineProduct an in-tx record callback + a shared batchId so the
    // audit row is atomic with the stock reversal. declineProduct is mocked here,
    // so the callback has not fired yet.
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    const [pid, admin, opts] = (declineProduct as jest.Mock).mock.calls[0];
    expect(pid).toBe(7);
    expect(admin).toEqual({ id: ADMIN_USER.id });
    expect(typeof opts.record).toBe('function');
    // one batchId spans the flow (uuid v4, 36 chars) so the event correlates with
    // the stock-reversal ledger rows declineProduct writes for this request.
    expect(typeof opts.batchId).toBe('string');
    expect(opts.batchId).toHaveLength(36);

    // Drive the captured callback the way declineProduct's tx would: the
    // PRODUCT_DECLINE event lands with the shared batchId + the DeclineResult ctx.
    await opts.record(tx, { reversed: true, alreadyDeclined: false });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const data = lastAuditData();
    expect(data.actionType).toBe('PRODUCT_DECLINE');
    expect(data.entityType).toBe('PRODUCT');
    expect(data.entityId).toBe('7');
    expect(data.batchId).toBe(opts.batchId);
    expect(data.details).toMatchObject({ reversed: true, alreadyDeclined: false });
  });
});
