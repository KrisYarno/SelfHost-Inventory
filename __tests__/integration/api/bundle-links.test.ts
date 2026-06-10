// @jest-environment node
import { NextRequest } from 'next/server';

jest.mock('@/lib/api-utils', () => ({
  // Real module first: requireCSRF (driven by the mocked validateCSRFToken)
  // and the REAL apiHandler, so the invalid-CSRF tests still observe the
  // mapped 403 responses.
  ...jest.requireActual('@/lib/api-utils'),
  requireAdmin: jest.fn(),
  requireCompanyMembership: jest.fn(),
}));
jest.mock('@/lib/prisma', () => {
  const tx = {
    productLink: { findFirst: jest.fn(), create: jest.fn(), findUnique: jest.fn() },
    bundleComponent: { createMany: jest.fn(), deleteMany: jest.fn() },
    externalOrderItem: { updateMany: jest.fn() },
    product: { findMany: jest.fn() },
    integration: { findUnique: jest.fn() },
  };
  return {
    __esModule: true,
    default: {
      ...tx,
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    },
  };
});
jest.mock('@/lib/csrf', () => ({
  validateCSRFToken: jest.fn(async () => true),
}));
jest.mock('@/lib/rateLimit', () => ({
  // Real module first so RateLimitError (referenced by the real apiHandler's
  // error mapping) stays a real class.
  ...jest.requireActual('@/lib/rateLimit'),
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((resp: any) => resp),
}));

import { POST } from '@/app/api/products/bundle-links/route';
import { requireAdmin, requireCompanyMembership } from '@/lib/api-utils';
import prisma from '@/lib/prisma';

const tx: any = (prisma as any);

describe('POST /api/products/bundle-links', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (require('@/lib/csrf').validateCSRFToken as jest.Mock).mockResolvedValue(true);
    (require('@/lib/rateLimit').applyRateLimitHeaders as jest.Mock).mockImplementation((r: any) => r);
    (prisma as any).$transaction = jest.fn(async (fn: any) => fn(tx));
  });

  function mkReq(body: any) {
    return new NextRequest('http://t/api/products/bundle-links', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
    });
  }

  function setupAdminCompany(integrationId = 'int1') {
    (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
    (tx.integration.findUnique as jest.Mock).mockResolvedValue({
      id: integrationId, companyId: 'co', isActive: true,
    });
    (tx.product.findMany as jest.Mock).mockResolvedValue([
      { id: 1, name: 'BPC-157', deletedAt: null },
      { id: 2, name: 'TB-500', deletedAt: null },
    ]);
  }

  it('creates bundle ProductLink + components in a transaction', async () => {
    setupAdminCompany();
    (tx.productLink.findFirst as jest.Mock).mockResolvedValue(null);
    (tx.productLink.create as jest.Mock).mockResolvedValue({
      id: 'bl1', isBundle: true, integrationId: 'int1',
      externalProductId: '100', externalVariantId: null,
      internalProductId: null, externalSku: null, externalTitle: null, createdAt: new Date(),
    });
    (tx.bundleComponent.createMany as jest.Mock).mockResolvedValue({ count: 2 });
    (tx.externalOrderItem.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    const resp = await POST(mkReq({
      integrationId: 'int1',
      externalProductId: '100',
      components: [
        { internalProductId: 1, quantity: 1 },
        { internalProductId: 2, quantity: 1 },
      ],
    }));

    expect(resp.status).toBe(201);
    const body = await resp.json();
    expect(body.id).toBe('bl1');
    expect(body.isBundle).toBe(true);
    expect(body.backfilledCount).toBe(0);
    expect(tx.bundleComponent.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ internalProductId: 1, quantity: 1 }),
        expect.objectContaining({ internalProductId: 2, quantity: 1 }),
      ]),
    });
  });

  it('rejects empty components with 400', async () => {
    setupAdminCompany();
    const resp = await POST(mkReq({
      integrationId: 'int1',
      externalProductId: '100',
      components: [],
    }));
    expect(resp.status).toBe(400);
  });

  it('rejects duplicate components with 400', async () => {
    setupAdminCompany();
    const resp = await POST(mkReq({
      integrationId: 'int1',
      externalProductId: '100',
      components: [
        { internalProductId: 1, quantity: 1 },
        { internalProductId: 1, quantity: 2 },
      ],
    }));
    expect(resp.status).toBe(400);
  });

  it('rejects soft-deleted internal products with 400', async () => {
    setupAdminCompany();
    (tx.product.findMany as jest.Mock).mockResolvedValue([
      { id: 1, name: 'BPC-157', deletedAt: null },
      { id: 2, name: 'TB-500', deletedAt: new Date() },
    ]);
    const resp = await POST(mkReq({
      integrationId: 'int1',
      externalProductId: '100',
      components: [
        { internalProductId: 1, quantity: 1 },
        { internalProductId: 2, quantity: 1 },
      ],
    }));
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/deleted/i);
  });

  it('returns 409 when external is already mapped', async () => {
    setupAdminCompany();
    (tx.productLink.findFirst as jest.Mock).mockResolvedValue({ id: 'existing-link' });
    const resp = await POST(mkReq({
      integrationId: 'int1',
      externalProductId: '100',
      components: [{ internalProductId: 1, quantity: 1 }],
    }));
    expect(resp.status).toBe(409);
  });

  it('backfills pre-existing unmapped order items with snapshot (D5 + D7)', async () => {
    setupAdminCompany();
    (tx.productLink.findFirst as jest.Mock).mockResolvedValue(null);
    (tx.productLink.create as jest.Mock).mockResolvedValue({
      id: 'bl2', isBundle: true, integrationId: 'int1',
      externalProductId: '200', externalVariantId: null,
      internalProductId: null, externalSku: null, externalTitle: null, createdAt: new Date(),
    });
    (tx.bundleComponent.createMany as jest.Mock).mockResolvedValue({ count: 1 });
    (tx.externalOrderItem.updateMany as jest.Mock).mockResolvedValue({ count: 3 });

    const resp = await POST(mkReq({
      integrationId: 'int1',
      externalProductId: '200',
      components: [{ internalProductId: 1, quantity: 2 }],
    }));

    expect(resp.status).toBe(201);
    const body = await resp.json();
    expect(body.backfilledCount).toBe(3);
    const updateCall = (tx.externalOrderItem.updateMany as jest.Mock).mock.calls[0][0];
    expect(updateCall.data.productLinkId).toBe('bl2');
    expect(updateCall.data.isMapped).toBe(true);
    expect(updateCall.data.bundleComponentSnapshot).toBeDefined();
  });

  it('backfill skips already-fulfilled items (P0 #3 — ghost snapshot guard)', async () => {
    // Items with fulfilledQty > 0 were deducted before the bundle existed and
    // have no snapshot to restore from. A later unfulfill would credit phantom
    // stock for components that were never deducted. The WHERE clause must
    // require fulfilledQty: 0.
    setupAdminCompany();
    (tx.productLink.findFirst as jest.Mock).mockResolvedValue(null);
    (tx.productLink.create as jest.Mock).mockResolvedValue({
      id: 'bl3', isBundle: true, integrationId: 'int1',
      externalProductId: '300', externalVariantId: null,
      internalProductId: null, externalSku: null, externalTitle: null, createdAt: new Date(),
    });
    (tx.bundleComponent.createMany as jest.Mock).mockResolvedValue({ count: 1 });
    (tx.externalOrderItem.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    await POST(mkReq({
      integrationId: 'int1',
      externalProductId: '300',
      components: [{ internalProductId: 1, quantity: 1 }],
    }));

    const updateCall = (tx.externalOrderItem.updateMany as jest.Mock).mock.calls[0][0];
    expect(updateCall.where.fulfilledQty).toBe(0);
    expect(updateCall.where.productLinkId).toBeNull();
  });

  it('returns explicit projection (no spread of full ProductLink model) [P1 shape parity]', async () => {
    // POST and PATCH must return identical field sets. Asserting specific fields
    // (not deep equality) catches accidental scalar additions to ProductLink leaking
    // into the response.
    setupAdminCompany();
    (tx.productLink.findFirst as jest.Mock).mockResolvedValue(null);
    const createdAt = new Date('2025-01-01T00:00:00Z');
    (tx.productLink.create as jest.Mock).mockResolvedValue({
      id: 'bl-shape', isBundle: true, integrationId: 'int1',
      externalProductId: '900', externalVariantId: null,
      internalProductId: null, externalSku: 'SKU-X', externalTitle: 'Title-X',
      createdAt,
    });
    (tx.bundleComponent.createMany as jest.Mock).mockResolvedValue({ count: 1 });
    (tx.externalOrderItem.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    const resp = await POST(mkReq({
      integrationId: 'int1',
      externalProductId: '900',
      components: [{ internalProductId: 1, quantity: 1 }],
    }));

    expect(resp.status).toBe(201);
    const body = await resp.json();
    expect(Object.keys(body).sort()).toEqual([
      'backfilledCount',
      'components',
      'createdAt',
      'externalProductId',
      'externalSku',
      'externalTitle',
      'externalVariantId',
      'id',
      'integrationId',
      'internalProductId',
      'isBundle',
    ]);
  });

  it('returns 409 (not 500) when a concurrent create races past the pre-check (P2002)', async () => {
    // Simulate TOCTOU: pre-check finds nothing, but the transaction hits a P2002
    // unique-constraint violation from a concurrent insert.
    setupAdminCompany();
    (tx.productLink.findFirst as jest.Mock).mockResolvedValue(null); // pre-check passes

    const { Prisma: PrismaNamespace } = require('@prisma/client');
    const p2002 = new PrismaNamespace.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`integrationId`,`externalProductId`,`externalVariantId`)',
      { code: 'P2002', clientVersion: '5.0.0' },
    );
    (prisma as any).$transaction = jest.fn().mockRejectedValue(p2002);

    const resp = await POST(mkReq({
      integrationId: 'int1',
      externalProductId: '300',
      components: [{ internalProductId: 1, quantity: 1 }],
    }));

    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.error).toMatch(/already exists/i);
  });

  it('returns 403 when CSRF token is invalid', async () => {
    (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    (require('@/lib/csrf').validateCSRFToken as jest.Mock).mockResolvedValue(false);

    const resp = await POST(mkReq({
      integrationId: 'int1',
      externalProductId: '100',
      components: [{ internalProductId: 1, quantity: 1 }],
    }));

    expect(resp.status).toBe(403);
    const body = await resp.json();
    expect(body.error).toMatch(/CSRF/i);

    // No transaction or DB writes should have happened
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
    expect(tx.productLink.create).not.toHaveBeenCalled();
  });
});

import { PATCH } from '@/app/api/products/bundle-links/[linkId]/route';

describe('PATCH /api/products/bundle-links/[linkId]', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (require('@/lib/csrf').validateCSRFToken as jest.Mock).mockResolvedValue(true);
    (require('@/lib/rateLimit').applyRateLimitHeaders as jest.Mock).mockImplementation((r: any) => r);
    (prisma as any).$transaction = jest.fn(async (fn: any) => fn(tx));
  });

  function mkPatchReq(body: any) {
    return new NextRequest('http://t/api/products/bundle-links/bl1', {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
    });
  }

  it('replaces components atomically', async () => {
    (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
    // First call: link lookup (before transaction)
    // Second call: post-transaction read with bundleComponents
    (tx.productLink.findUnique as jest.Mock)
      .mockResolvedValueOnce({
        id: 'bl1', isBundle: true, integrationId: 'int1',
        integration: { companyId: 'co' },
      })
      .mockResolvedValueOnce({
        id: 'bl1', isBundle: true, integrationId: 'int1',
        internalProductId: null, externalProductId: '100', externalVariantId: null,
        externalSku: null, externalTitle: null,
        bundleComponents: [
          { internalProductId: 3, quantity: 1, sortOrder: 0, internalProduct: { name: 'New Component' } },
        ],
      });
    (tx.bundleComponent.deleteMany as jest.Mock).mockResolvedValue({ count: 2 });
    (tx.bundleComponent.createMany as jest.Mock).mockResolvedValue({ count: 1 });
    (tx.product.findMany as jest.Mock).mockResolvedValue([
      { id: 3, name: 'New Component', deletedAt: null },
    ]);

    const resp = await PATCH(
      mkPatchReq({ components: [{ internalProductId: 3, quantity: 1 }] }),
      { params: { linkId: 'bl1' } },
    );

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.components).toHaveLength(1);
    expect(body.components[0].internalProductId).toBe(3);
    // bundleComponents should NOT appear in the response (raw relation excluded)
    expect(body.bundleComponents).toBeUndefined();
    expect(tx.bundleComponent.deleteMany).toHaveBeenCalledWith({
      where: { productLinkId: 'bl1' },
    });
    expect(tx.bundleComponent.createMany).toHaveBeenCalled();
  });

  it('rejects with 400 when link is not a bundle', async () => {
    (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
    (tx.productLink.findUnique as jest.Mock).mockResolvedValue({
      id: 'bl1', isBundle: false, integration: { companyId: 'co' },
    });

    const resp = await PATCH(
      mkPatchReq({ components: [{ internalProductId: 3, quantity: 1 }] }),
      { params: { linkId: 'bl1' } },
    );

    expect(resp.status).toBe(400);
  });

  it('returns 404 when link does not exist', async () => {
    (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    (tx.productLink.findUnique as jest.Mock).mockResolvedValue(null);

    const resp = await PATCH(
      mkPatchReq({ components: [{ internalProductId: 3, quantity: 1 }] }),
      { params: { linkId: 'missing' } },
    );

    expect(resp.status).toBe(404);
  });

  it('returns same explicit field set as POST (minus backfilledCount) [P1 shape parity]', async () => {
    (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
    const createdAt = new Date('2025-02-02T00:00:00Z');
    (tx.productLink.findUnique as jest.Mock)
      .mockResolvedValueOnce({
        id: 'bl-shape', isBundle: true, integrationId: 'int1',
        integration: { companyId: 'co' },
      })
      .mockResolvedValueOnce({
        id: 'bl-shape', isBundle: true, integrationId: 'int1',
        internalProductId: null, externalProductId: '900', externalVariantId: null,
        externalSku: 'SKU-X', externalTitle: 'Title-X', createdAt,
        bundleComponents: [
          { internalProductId: 3, quantity: 1, sortOrder: 0, internalProduct: { name: 'X' } },
        ],
      });
    (tx.bundleComponent.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
    (tx.bundleComponent.createMany as jest.Mock).mockResolvedValue({ count: 1 });
    (tx.product.findMany as jest.Mock).mockResolvedValue([
      { id: 3, name: 'X', deletedAt: null },
    ]);

    const resp = await PATCH(
      mkPatchReq({ components: [{ internalProductId: 3, quantity: 1 }] }),
      { params: { linkId: 'bl-shape' } },
    );

    expect(resp.status).toBe(200);
    const body = await resp.json();
    // Same fields as POST, minus backfilledCount.
    expect(Object.keys(body).sort()).toEqual([
      'components',
      'createdAt',
      'externalProductId',
      'externalSku',
      'externalTitle',
      'externalVariantId',
      'id',
      'integrationId',
      'internalProductId',
      'isBundle',
    ]);
    // Sanity: no raw bundleComponents relation leaking.
    expect((body as Record<string, unknown>).bundleComponents).toBeUndefined();
  });

  it('PATCH does NOT touch existing ExternalOrderItem.bundleComponentSnapshot (D7)', async () => {
    (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
    (tx.productLink.findUnique as jest.Mock)
      .mockResolvedValueOnce({ id: 'bl1', isBundle: true, integration: { companyId: 'co' } })
      .mockResolvedValueOnce({
        id: 'bl1', isBundle: true, integrationId: 'int1',
        internalProductId: null, externalProductId: '100', externalVariantId: null,
        externalSku: null, externalTitle: null,
        bundleComponents: [
          { internalProductId: 5, quantity: 1, sortOrder: 0, internalProduct: { name: 'X' } },
        ],
      });
    (tx.bundleComponent.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
    (tx.bundleComponent.createMany as jest.Mock).mockResolvedValue({ count: 1 });
    (tx.product.findMany as jest.Mock).mockResolvedValue([
      { id: 5, name: 'X', deletedAt: null },
    ]);
    (tx.externalOrderItem.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    await PATCH(
      mkPatchReq({ components: [{ internalProductId: 5, quantity: 1 }] }),
      { params: { linkId: 'bl1' } },
    );

    // PATCH must NOT call externalOrderItem.updateMany — only POST does on create
    expect(tx.externalOrderItem.updateMany).not.toHaveBeenCalled();
  });

  it('returns 403 when CSRF token is invalid', async () => {
    (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    (require('@/lib/csrf').validateCSRFToken as jest.Mock).mockResolvedValue(false);

    const resp = await PATCH(
      mkPatchReq({ components: [{ internalProductId: 3, quantity: 1 }] }),
      { params: { linkId: 'bl1' } },
    );

    expect(resp.status).toBe(403);
    const body = await resp.json();
    expect(body.error).toMatch(/CSRF/i);

    // CSRF check must fail before any link lookup or DB write
    expect(tx.productLink.findUnique).not.toHaveBeenCalled();
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
  });

  it('returns 400 when a component references a soft-deleted internal product', async () => {
    (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
    (tx.productLink.findUnique as jest.Mock).mockResolvedValue({
      id: 'bl1', isBundle: true, integrationId: 'int1',
      integration: { companyId: 'co' },
    });
    (tx.product.findMany as jest.Mock).mockResolvedValue([
      { id: 3, name: 'Soft Deleted', deletedAt: new Date() },
    ]);

    const resp = await PATCH(
      mkPatchReq({ components: [{ internalProductId: 3, quantity: 1 }] }),
      { params: { linkId: 'bl1' } },
    );

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/deleted/i);

    // No write should occur on validation failure
    expect(tx.bundleComponent.deleteMany).not.toHaveBeenCalled();
    expect(tx.bundleComponent.createMany).not.toHaveBeenCalled();
  });

  it('returns 400 when a component references a non-existent internal product', async () => {
    (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
    (tx.productLink.findUnique as jest.Mock).mockResolvedValue({
      id: 'bl1', isBundle: true, integrationId: 'int1',
      integration: { companyId: 'co' },
    });
    (tx.product.findMany as jest.Mock).mockResolvedValue([]);

    const resp = await PATCH(
      mkPatchReq({ components: [{ internalProductId: 999, quantity: 1 }] }),
      { params: { linkId: 'bl1' } },
    );

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/not found/i);

    // No write should occur on validation failure
    expect(tx.bundleComponent.deleteMany).not.toHaveBeenCalled();
    expect(tx.bundleComponent.createMany).not.toHaveBeenCalled();
  });

  it('returns 400 when components array is empty (Zod min(1))', async () => {
    (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: 'u1', isAdmin: true } });

    const resp = await PATCH(
      mkPatchReq({ components: [] }),
      { params: { linkId: 'bl1' } },
    );

    expect(resp.status).toBe(400);

    // Zod rejection happens before link lookup
    expect(tx.productLink.findUnique).not.toHaveBeenCalled();
  });
});
