// @jest-environment node
import {
  BundleComponentInputSchema,
  BundleComponentSnapshotSchema,
  BundleComponentSnapshotArraySchema,
  CreateBundleLinkSchema,
  UpdateBundleLinkSchema,
} from '@/lib/validation/bundle-links';

describe('BundleComponentInputSchema bounds', () => {
  it('rejects quantity > 9999 (prevents INT overflow + float precision risk)', () => {
    const result = BundleComponentInputSchema.safeParse({
      internalProductId: 1,
      quantity: 10_000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects zero or negative internalProductId', () => {
    expect(
      BundleComponentInputSchema.safeParse({ internalProductId: 0, quantity: 1 }).success,
    ).toBe(false);
    expect(
      BundleComponentInputSchema.safeParse({ internalProductId: -5, quantity: 1 }).success,
    ).toBe(false);
  });

  it('accepts quantity at the 9999 boundary', () => {
    const result = BundleComponentInputSchema.safeParse({
      internalProductId: 1,
      quantity: 9999,
    });
    expect(result.success).toBe(true);
  });
});

describe('CreateBundleLinkSchema bounds', () => {
  const validComponent = { internalProductId: 1, quantity: 1 };

  it('rejects externalTitle > 500 chars (DB VarChar(500))', () => {
    const result = CreateBundleLinkSchema.safeParse({
      integrationId: 'int_123',
      externalProductId: '42',
      externalTitle: 'x'.repeat(501),
      components: [validComponent],
    });
    expect(result.success).toBe(false);
  });

  it('rejects externalProductId > 255 chars (DB VarChar(255))', () => {
    const result = CreateBundleLinkSchema.safeParse({
      integrationId: 'int_123',
      externalProductId: 'x'.repeat(256),
      components: [validComponent],
    });
    expect(result.success).toBe(false);
  });

  it('rejects components array of length > 50', () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => ({
      internalProductId: i + 1,
      quantity: 1,
    }));
    const result = CreateBundleLinkSchema.safeParse({
      integrationId: 'int_123',
      externalProductId: '42',
      components: tooMany,
    });
    expect(result.success).toBe(false);
  });

  it('rejects integrationId > 64 chars', () => {
    const result = CreateBundleLinkSchema.safeParse({
      integrationId: 'x'.repeat(65),
      externalProductId: '42',
      components: [validComponent],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a fully valid payload at boundary lengths', () => {
    const result = CreateBundleLinkSchema.safeParse({
      integrationId: 'x'.repeat(64),
      externalProductId: 'x'.repeat(255),
      externalVariantId: 'x'.repeat(255),
      externalSku: 'x'.repeat(255),
      externalTitle: 'x'.repeat(500),
      components: Array.from({ length: 50 }, (_, i) => ({
        internalProductId: i + 1,
        quantity: 9999,
      })),
    });
    expect(result.success).toBe(true);
  });
});

describe('UpdateBundleLinkSchema bounds', () => {
  it('rejects components array > 50', () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => ({
      internalProductId: i + 1,
      quantity: 1,
    }));
    const result = UpdateBundleLinkSchema.safeParse({ components: tooMany });
    expect(result.success).toBe(false);
  });
});

describe('BundleComponentSnapshotSchema bounds', () => {
  it('rejects snapshot quantity overflow (> 9999)', () => {
    const result = BundleComponentSnapshotSchema.safeParse({
      internalProductId: 1,
      quantity: 1_000_000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects internalProductName > 255 chars', () => {
    const result = BundleComponentSnapshotSchema.safeParse({
      internalProductId: 1,
      internalProductName: 'x'.repeat(256),
      quantity: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects snapshot array > 50 entries', () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => ({
      internalProductId: i + 1,
      quantity: 1,
    }));
    const result = BundleComponentSnapshotArraySchema.safeParse(tooMany);
    expect(result.success).toBe(false);
  });
});
