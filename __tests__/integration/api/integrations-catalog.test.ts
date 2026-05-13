// @jest-environment node
import { NextRequest } from 'next/server';

jest.mock('@/lib/api-utils', () => ({
  apiHandler: (fn: any) => fn,
  requireAdmin: jest.fn(),
  requireCompanyMembership: jest.fn(),
}));
jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    integration: { findUnique: jest.fn() },
    productLink: { findMany: jest.fn() },
  },
}));
jest.mock('@/lib/rateLimit', () => ({
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((resp: any) => resp),
}));
jest.mock('@/lib/external-orders/shared', () => ({
  decryptOrNull: jest.fn((v: string) => v),
  hostFromStoreUrl: jest.fn((u: string) => u.replace(/^https?:\/\//, '')),
}));
jest.mock('@/lib/platforms/woocommerce/fetch-catalog', () => ({
  fetchWooCatalog: jest.fn(),
}));

import { GET } from '@/app/api/integrations/[id]/catalog/route';
import { requireAdmin, requireCompanyMembership } from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { fetchWooCatalog } from '@/lib/platforms/woocommerce/fetch-catalog';

describe('GET /api/integrations/[id]/catalog', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    // Restore the identity implementations that the module-factory set up.
    // jest.resetAllMocks() clears implementations created in the factory; we
    // re-install them here so each test starts with a working mock.
    const { decryptOrNull } = require('@/lib/external-orders/shared');
    (decryptOrNull as jest.Mock).mockImplementation((v: string) => v);
    const { applyRateLimitHeaders } = require('@/lib/rateLimit');
    (applyRateLimitHeaders as jest.Mock).mockImplementation((resp: any) => resp);
  });

  it('returns 404 when the integration does not exist', async () => {
    (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: '1', isAdmin: true } });
    (prisma.integration.findUnique as jest.Mock).mockResolvedValue(null);

    const req = new NextRequest('http://t/api/integrations/x/catalog');
    const resp = await GET(req, { params: { id: 'x' } });
    expect(resp.status).toBe(404);
  });

  it('returns 400 when the integration is inactive', async () => {
    (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: '1', isAdmin: true } });
    (prisma.integration.findUnique as jest.Mock).mockResolvedValue({
      id: 'x', isActive: false, companyId: 'co', platform: 'WOOCOMMERCE',
      storeUrl: 'https://s', name: 'S', encryptedApiKey: 'k', encryptedApiSecret: 's',
    });

    const req = new NextRequest('http://t/api/integrations/x/catalog');
    const resp = await GET(req, { params: { id: 'x' } });
    expect(resp.status).toBe(400);
  });

  it('returns a flattened catalog with alreadyMapped joined in', async () => {
    (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: '1', isAdmin: true } });
    (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
    (prisma.integration.findUnique as jest.Mock).mockResolvedValue({
      id: 'x', isActive: true, companyId: 'co', platform: 'WOOCOMMERCE',
      storeUrl: 'https://s', name: 'Main', encryptedApiKey: 'k', encryptedApiSecret: 's',
    });
    (fetchWooCatalog as jest.Mock).mockResolvedValue({
      rows: [
        { externalProductId: '1', externalVariantId: null, parentTitle: 'Mug', variantTitle: null, sku: 'MUG', type: 'simple', attributes: [], alreadyMapped: false },
        { externalProductId: '10', externalVariantId: '101', parentTitle: 'Coffee', variantTitle: '1 lb', sku: 'CB1', type: 'variation', attributes: [], alreadyMapped: false },
      ],
      warnings: [],
    });
    (prisma.productLink.findMany as jest.Mock).mockResolvedValue([
      { id: 'l1', integrationId: 'x', externalProductId: '1', externalVariantId: null, internalProductId: 7, internalProduct: { name: 'Mug Internal' } },
    ]);

    const req = new NextRequest('http://t/api/integrations/x/catalog');
    const resp = await GET(req, { params: { id: 'x' } });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.integration.id).toBe('x');
    expect(body.rows).toHaveLength(2);
    const mug = body.rows.find((r: any) => r.externalProductId === '1');
    expect(mug.alreadyMapped).toBe(true);
    expect(mug.existingMapping.linkId).toBe('l1');
    const coffee = body.rows.find((r: any) => r.externalProductId === '10');
    expect(coffee.alreadyMapped).toBe(false);
  });

  it('rejects non-WooCommerce platforms with NotImplemented', async () => {
    (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: '1', isAdmin: true } });
    (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
    (prisma.integration.findUnique as jest.Mock).mockResolvedValue({
      id: 'x', isActive: true, companyId: 'co', platform: 'SHOPIFY',
      storeUrl: 'https://shop', name: 'S', encryptedApiKey: 'k', encryptedApiSecret: null,
    });
    const req = new NextRequest('http://t/api/integrations/x/catalog');
    const resp = await GET(req, { params: { id: 'x' } });
    expect([400, 501]).toContain(resp.status);
  });

  it('returns 500 when credentials cannot be decrypted', async () => {
    (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: '1', isAdmin: true } });
    (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
    (prisma.integration.findUnique as jest.Mock).mockResolvedValue({
      id: 'x', isActive: true, companyId: 'co', platform: 'WOOCOMMERCE',
      storeUrl: 'https://s', name: 'Main', encryptedApiKey: 'k', encryptedApiSecret: 's',
    });
    const { decryptOrNull } = require('@/lib/external-orders/shared');
    (decryptOrNull as jest.Mock).mockReturnValue(null);

    const req = new NextRequest('http://t/api/integrations/x/catalog');
    const resp = await GET(req, { params: { id: 'x' } });
    expect(resp.status).toBe(500);
    const body = await resp.json();
    expect(body.error).toMatch(/credentials could not be decrypted/i);
  });

  it('returns 502 when fetchWooCatalog throws', async () => {
    (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: '1', isAdmin: true } });
    (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
    (prisma.integration.findUnique as jest.Mock).mockResolvedValue({
      id: 'x', isActive: true, companyId: 'co', platform: 'WOOCOMMERCE',
      storeUrl: 'https://s', name: 'Main', encryptedApiKey: 'k', encryptedApiSecret: 's',
    });
    (fetchWooCatalog as jest.Mock).mockRejectedValue(new Error('WC 500: upstream down'));

    const req = new NextRequest('http://t/api/integrations/x/catalog');
    const resp = await GET(req, { params: { id: 'x' } });
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error).toMatch(/Store fetch failed/);
  });
});
