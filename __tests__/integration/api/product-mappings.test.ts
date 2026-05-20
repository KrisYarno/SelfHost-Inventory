// @jest-environment node
import { NextRequest } from 'next/server';

jest.mock('@/lib/api-utils', () => ({
  apiHandler: (fn: unknown) => fn,
  requireAdmin: jest.fn(),
  requireCompanyMembership: jest.fn(),
}));
jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    integration: { findUnique: jest.fn() },
    userCompany: { findMany: jest.fn() },
    productLink: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));
jest.mock('@/lib/csrf', () => ({
  validateCSRFToken: jest.fn(async () => true),
}));

import { GET } from '@/app/api/admin/product-mappings/route';
import { requireAdmin, requireCompanyMembership } from '@/lib/api-utils';
import prisma from '@/lib/prisma';

describe('GET /api/admin/product-mappings (P2 — componentCount projection)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns componentCount for bundles, undefined for single mappings', async () => {
    (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: 'u1', isAdmin: true } });
    (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
    (prisma.integration.findUnique as jest.Mock).mockResolvedValue({ companyId: 'co' });
    (prisma.productLink.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'single-1',
        isBundle: false,
        externalProductId: '100',
        internalProductId: 7,
        internalProduct: { id: 7, name: 'Single Product' },
        integration: { id: 'int1', name: 'Main', platform: 'WOOCOMMERCE', storeUrl: 'https://s' },
        bundleComponents: [],
      },
      {
        id: 'bundle-1',
        isBundle: true,
        externalProductId: '200',
        internalProductId: null,
        internalProduct: null,
        integration: { id: 'int1', name: 'Main', platform: 'WOOCOMMERCE', storeUrl: 'https://s' },
        bundleComponents: [
          { id: 'bc1', internalProductId: 1, internalProduct: { id: 1, name: 'A' } },
          { id: 'bc2', internalProductId: 2, internalProduct: { id: 2, name: 'B' } },
          { id: 'bc3', internalProductId: 3, internalProduct: { id: 3, name: 'C' } },
        ],
      },
    ]);
    (prisma.productLink.count as jest.Mock).mockResolvedValue(2);

    const req = new NextRequest('http://t/api/admin/product-mappings?integrationId=int1');
    const resp = await GET(req);
    expect(resp.status).toBe(200);
    const body = await resp.json();

    const single = body.mappings.find((m: any) => m.id === 'single-1');
    expect(single.componentCount).toBeUndefined();
    // bundleComponents must be omitted (undefined → drops in JSON serialization)
    expect(single.bundleComponents).toBeUndefined();

    const bundle = body.mappings.find((m: any) => m.id === 'bundle-1');
    expect(bundle.componentCount).toBe(3);
    expect(bundle.bundleComponents).toHaveLength(3);
  });
});
