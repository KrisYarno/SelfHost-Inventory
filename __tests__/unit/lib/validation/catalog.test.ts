// @jest-environment node
import {
  CatalogRowSchema,
  CatalogResponseSchema,
} from '@/lib/validation/catalog';

describe('CatalogRowSchema', () => {
  it('accepts a minimal simple-product row', () => {
    const ok = CatalogRowSchema.safeParse({
      externalProductId: '42',
      externalVariantId: null,
      parentTitle: 'Coffee Beans',
      variantTitle: null,
      sku: null,
      type: 'simple',
      attributes: [],
      alreadyMapped: false,
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a variation row with existingMapping', () => {
    const ok = CatalogRowSchema.safeParse({
      externalProductId: '42',
      externalVariantId: '99',
      parentTitle: 'Coffee Beans',
      variantTitle: '1 lb',
      sku: 'CB-1LB',
      type: 'variation',
      attributes: [{ name: 'Size', option: '1lb' }],
      alreadyMapped: true,
      existingMapping: {
        linkId: 'clp123',
        internalProductId: 7,
        internalProductName: 'Coffee Beans 1 lb',
        isBundle: false,
        componentCount: null,
      },
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a row with type variation but no externalVariantId', () => {
    const bad = CatalogRowSchema.safeParse({
      externalProductId: '42',
      externalVariantId: null,
      parentTitle: 'Coffee Beans',
      variantTitle: '1 lb',
      sku: null,
      type: 'variation',
      attributes: [],
      alreadyMapped: false,
    });
    expect(bad.success).toBe(false);
  });
});

describe('CatalogResponseSchema', () => {
  it('parses a full response', () => {
    const ok = CatalogResponseSchema.safeParse({
      integration: {
        id: 'int1',
        name: 'Main Store',
        platform: 'WOOCOMMERCE',
        storeUrl: 'https://store.example.com',
      },
      rows: [],
      fetchedAt: new Date().toISOString(),
      warnings: [],
    });
    expect(ok.success).toBe(true);
  });
});
