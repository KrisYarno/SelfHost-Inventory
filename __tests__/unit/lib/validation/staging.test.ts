/**
 * @jest-environment node
 *
 * Unit tests for the pre-staging Zod schemas (lib/validation/staging.ts).
 * Pure schema validation — no Prisma, no mocks.
 */

import {
  CreateStagingSchema,
  PatchStagingSchema,
  GraduateSchema,
} from '@/lib/validation/staging';

const validProductFields = {
  baseName: 'Test Peptide',
  variant: '10mg',
  unit: 'mg',
  numericValue: 10,
  lowStockThreshold: 5,
  costPrice: 1,
  retailPrice: 2,
  locationId: 1,
};

describe('CreateStagingSchema', () => {
  it('accepts a minimal valid create (description + locationId)', () => {
    expect(
      CreateStagingSchema.safeParse({ description: 'Box of vials', locationId: 1 })
        .success
    ).toBe(true);
  });

  it('accepts a full valid create', () => {
    expect(
      CreateStagingSchema.safeParse({
        description: 'Pallet of widgets',
        expectedQuantity: 100,
        resolvedProductId: 42,
        vendor: 'Acme',
        reference: 'PO-123',
        notes: 'left dock',
        locationId: 2,
      }).success
    ).toBe(true);
  });

  it('rejects an empty description', () => {
    expect(
      CreateStagingSchema.safeParse({ description: '', locationId: 1 }).success
    ).toBe(false);
  });

  it('rejects a missing locationId', () => {
    expect(
      CreateStagingSchema.safeParse({ description: 'Box' }).success
    ).toBe(false);
  });

  it('rejects a non-positive locationId', () => {
    expect(
      CreateStagingSchema.safeParse({ description: 'Box', locationId: 0 }).success
    ).toBe(false);
  });

  it('rejects a negative expectedQuantity', () => {
    expect(
      CreateStagingSchema.safeParse({
        description: 'Box',
        locationId: 1,
        expectedQuantity: -1,
      }).success
    ).toBe(false);
  });
});

describe('PatchStagingSchema', () => {
  it('accepts an empty patch (all fields optional)', () => {
    expect(PatchStagingSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a tentative countedQuantity of 0 (>= 1 enforced only at graduate)', () => {
    expect(PatchStagingSchema.safeParse({ countedQuantity: 0 }).success).toBe(true);
  });

  it('rejects a negative countedQuantity', () => {
    expect(PatchStagingSchema.safeParse({ countedQuantity: -1 }).success).toBe(false);
  });
});

describe('GraduateSchema', () => {
  it('rejects graduate with countedQuantity < 1', () => {
    expect(
      GraduateSchema.safeParse({
        mode: 'existing',
        productId: 1,
        countedQuantity: 0,
        locationId: 1,
      }).success
    ).toBe(false);
  });

  it('requires productId for mode=existing', () => {
    expect(
      GraduateSchema.safeParse({
        mode: 'existing',
        countedQuantity: 5,
        locationId: 1,
      }).success
    ).toBe(false);
  });

  it('requires productFields for mode=new', () => {
    expect(
      GraduateSchema.safeParse({
        mode: 'new',
        countedQuantity: 5,
        locationId: 1,
      }).success
    ).toBe(false);
  });

  it('accepts a valid mode=existing graduate', () => {
    expect(
      GraduateSchema.safeParse({
        mode: 'existing',
        productId: 7,
        countedQuantity: 5,
        locationId: 1,
      }).success
    ).toBe(true);
  });

  it('accepts a valid mode=new graduate', () => {
    expect(
      GraduateSchema.safeParse({
        mode: 'new',
        productFields: validProductFields,
        countedQuantity: 5,
        locationId: 1,
      }).success
    ).toBe(true);
  });

  it('rejects an unknown mode', () => {
    expect(
      GraduateSchema.safeParse({
        mode: 'bogus',
        countedQuantity: 5,
        locationId: 1,
      }).success
    ).toBe(false);
  });

  it('rejects mode=new when productFields are invalid (empty baseName)', () => {
    expect(
      GraduateSchema.safeParse({
        mode: 'new',
        productFields: { ...validProductFields, baseName: '' },
        countedQuantity: 5,
        locationId: 1,
      }).success
    ).toBe(false);
  });
});
