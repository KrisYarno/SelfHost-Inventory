// @jest-environment node
import { NextRequest } from 'next/server';

jest.mock('@/lib/api-utils', () => ({
  apiHandler: (fn: unknown) => fn,
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
});
