/**
 * @jest-environment node
 *
 * Unit tests for the pre-staging Zod schemas (lib/validation/staging.ts).
 * Pure schema validation — no Prisma, no mocks.
 */

import { z } from 'zod';
import {
  CreateStagingSchema,
  PatchStagingSchema,
  GraduateSchema,
  CountStagingSchema,
  assertStagingPatchOmitsCount,
  assertStagingCostPreconditionPaired,
  assertGraduateOmitsCount,
  assertGraduateOverridePair,
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

  // W1-2b (pack REV-3 T2): countedQuantity LEFT this schema. Counting is a
  // physical act with an actor and a timestamp, so it lives at
  // POST /api/staging-items/[id]/count and nowhere else.
  it('no longer declares countedQuantity', () => {
    expect(Object.keys(PatchStagingSchema.shape)).not.toContain('countedQuantity');
  });

  it('assertStagingPatchOmitsCount throws on a body that still carries it', () => {
    expect(() => assertStagingPatchOmitsCount({ countedQuantity: 12 })).toThrow(z.ZodError);
    // ...including an explicit null: clearing a count is still counting.
    expect(() => assertStagingPatchOmitsCount({ countedQuantity: null })).toThrow(z.ZodError);
    // The message names the endpoint that CAN do it.
    try {
      assertStagingPatchOmitsCount({ countedQuantity: 12 });
    } catch (err) {
      expect((err as z.ZodError).errors[0].message).toMatch(/\/count/);
      expect((err as z.ZodError).errors[0].path).toEqual(['countedQuantity']);
    }
  });

  it('assertStagingPatchOmitsCount passes anything else through (incl. junk bodies)', () => {
    expect(() => assertStagingPatchOmitsCount({ notes: 'pallet 3' })).not.toThrow();
    expect(() => assertStagingPatchOmitsCount({})).not.toThrow();
    expect(() => assertStagingPatchOmitsCount(null)).not.toThrow();
    expect(() => assertStagingPatchOmitsCount('nonsense')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FD2-2 (fix round 3) — `ifUnitCostCents`, the cost PRECONDITION.
//
// The freight panel's drift check was client-side only, so the window between
// "the panel looked" and "the server wrote" was unguarded: a third party could
// revert a written line to EXACTLY the frozen base (the panel's own-write-or-
// frozen-base test passes, the retry skips the line, and the bill "completes"
// with that line's freight silently missing), or change an unwritten line and
// have the allocation overwrite it. The check has to BE the WHERE.
//
// Absence and explicit null are DIFFERENT requests here — absent means "write
// unconditionally" (the manual per-line save), `null` means "only if this line
// is still unpriced" — so the schema keeps them distinguishable.
// ---------------------------------------------------------------------------

describe('PatchStagingSchema — ifUnitCostCents (FD2-2)', () => {
  it('declares the field', () => {
    expect(Object.keys(PatchStagingSchema.shape)).toContain('ifUnitCostCents');
  });

  it('accepts a cents precondition alongside the write', () => {
    const parsed = PatchStagingSchema.safeParse({ unitCostCents: 200, ifUnitCostCents: 100 });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.ifUnitCostCents).toBe(100);
  });

  it('accepts an explicit NULL precondition ("only if it is still unpriced")', () => {
    const parsed = PatchStagingSchema.safeParse({ unitCostCents: 200, ifUnitCostCents: null });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.ifUnitCostCents).toBeNull();
  });

  it('keeps ABSENT distinguishable from explicit null', () => {
    const absent = PatchStagingSchema.parse({ unitCostCents: 200 });
    expect('ifUnitCostCents' in absent).toBe(false);
    expect(absent.ifUnitCostCents).toBeUndefined();
  });

  it('rejects a fractional / negative precondition (cents are whole)', () => {
    expect(PatchStagingSchema.safeParse({ unitCostCents: 1, ifUnitCostCents: 1.5 }).success).toBe(
      false,
    );
    expect(PatchStagingSchema.safeParse({ unitCostCents: 1, ifUnitCostCents: -1 }).success).toBe(
      false,
    );
  });

  it('stays a plain ZodObject (the MCP adapter reads .shape — no .refine)', () => {
    expect(PatchStagingSchema).toBeInstanceOf(z.ZodObject);
  });
});

describe('assertStagingCostPreconditionPaired (FD2-2)', () => {
  it('accepts the precondition when it guards an actual cost write', () => {
    expect(() =>
      assertStagingCostPreconditionPaired({ unitCostCents: 200, ifUnitCostCents: 100 }),
    ).not.toThrow();
    expect(() =>
      assertStagingCostPreconditionPaired({ unitCostCents: null, ifUnitCostCents: 100 }),
    ).not.toThrow();
  });

  it('REFUSES a precondition with no cost write — it would guard nothing', () => {
    expect(() => assertStagingCostPreconditionPaired({ ifUnitCostCents: 100 })).toThrow(
      z.ZodError,
    );
    expect(() =>
      assertStagingCostPreconditionPaired({ notes: 'x', ifUnitCostCents: null }),
    ).toThrow(z.ZodError);
    try {
      assertStagingCostPreconditionPaired({ ifUnitCostCents: 100 });
    } catch (err) {
      expect((err as z.ZodError).errors[0].path).toEqual(['unitCostCents']);
    }
  });

  it('leaves every ordinary body alone', () => {
    expect(() => assertStagingCostPreconditionPaired({})).not.toThrow();
    expect(() => assertStagingCostPreconditionPaired({ unitCostCents: 200 })).not.toThrow();
    expect(() => assertStagingCostPreconditionPaired({ notes: 'pallet 3' })).not.toThrow();
  });
});

describe('CountStagingSchema', () => {
  it('accepts a count of 0 (an empty box is a fact; the 422 is graduation-side)', () => {
    expect(CountStagingSchema.safeParse({ countedQuantity: 0 }).success).toBe(true);
  });

  it('rejects a negative, fractional, or missing count', () => {
    expect(CountStagingSchema.safeParse({ countedQuantity: -1 }).success).toBe(false);
    expect(CountStagingSchema.safeParse({ countedQuantity: 1.5 }).success).toBe(false);
    expect(CountStagingSchema.safeParse({}).success).toBe(false);
  });

  it('caps at the house 1,000,000 ceiling', () => {
    expect(CountStagingSchema.safeParse({ countedQuantity: 1_000_000 }).success).toBe(true);
    expect(CountStagingSchema.safeParse({ countedQuantity: 1_000_001 }).success).toBe(false);
  });
});

describe('GraduateSchema (W1-3a — the request no longer carries a quantity)', () => {
  it('DROPS countedQuantity: the parsed body has no such key even when one is sent', () => {
    // The defect this kills: the dialog pre-filled counted from EXPECTED and the
    // server booked whatever the request said (count 46, confirm, book 50). Zod
    // strips the unknown key, so the parsed value cannot carry a quantity at all.
    const parsed = GraduateSchema.parse({
      mode: 'existing',
      productId: 7,
      countedQuantity: 50,
      locationId: 1,
    });
    expect(parsed).not.toHaveProperty('countedQuantity');
  });

  it('requires productId for mode=existing', () => {
    expect(GraduateSchema.safeParse({ mode: 'existing', locationId: 1 }).success).toBe(false);
  });

  it('requires productFields for mode=new', () => {
    expect(GraduateSchema.safeParse({ mode: 'new', locationId: 1 }).success).toBe(false);
  });

  it('accepts a valid mode=existing graduate (mode + productId + locationId)', () => {
    expect(
      GraduateSchema.safeParse({ mode: 'existing', productId: 7, locationId: 1 }).success
    ).toBe(true);
  });

  it('accepts a valid mode=new graduate', () => {
    expect(
      GraduateSchema.safeParse({
        mode: 'new',
        productFields: validProductFields,
        locationId: 1,
      }).success
    ).toBe(true);
  });

  it('rejects an unknown mode', () => {
    expect(GraduateSchema.safeParse({ mode: 'bogus', locationId: 1 }).success).toBe(false);
  });

  it('rejects mode=new when productFields are invalid (empty baseName)', () => {
    expect(
      GraduateSchema.safeParse({
        mode: 'new',
        productFields: { ...validProductFields, baseName: '' },
        locationId: 1,
      }).success
    ).toBe(false);
  });
});

describe('GraduateSchema — the override pair', () => {
  const base = { mode: 'existing' as const, productId: 7, locationId: 1 };

  it('accepts the pair', () => {
    expect(
      GraduateSchema.safeParse({
        ...base,
        overrideQuantity: 3,
        overrideReason: 'two vials broken in transit',
      }).success
    ).toBe(true);
  });

  it('rejects overrideQuantity < 1 and a non-integer', () => {
    expect(GraduateSchema.safeParse({ ...base, overrideQuantity: 0 }).success).toBe(false);
    expect(GraduateSchema.safeParse({ ...base, overrideQuantity: 1.5 }).success).toBe(false);
  });

  it('rejects an empty reason and one over 500 chars', () => {
    expect(GraduateSchema.safeParse({ ...base, overrideReason: '' }).success).toBe(false);
    expect(
      GraduateSchema.safeParse({ ...base, overrideReason: 'x'.repeat(501) }).success
    ).toBe(false);
    expect(
      GraduateSchema.safeParse({ ...base, overrideReason: 'x'.repeat(500) }).success
    ).toBe(true);
  });

  it('the pair survives the mode=new branch too', () => {
    const parsed = GraduateSchema.parse({
      mode: 'new',
      productFields: validProductFields,
      locationId: 1,
      overrideQuantity: 9,
      overrideReason: 'supplier shorted the box',
    });
    expect(parsed).toMatchObject({ overrideQuantity: 9, overrideReason: 'supplier shorted the box' });
  });
});

describe('assertGraduateOmitsCount (the count-46-book-50 regression guard)', () => {
  it('throws a ZodError (-> 400) when the RAW body still carries countedQuantity', () => {
    expect(() =>
      assertGraduateOmitsCount({ mode: 'existing', productId: 7, locationId: 1, countedQuantity: 50 })
    ).toThrow(z.ZodError);
  });

  it('names the field and points at the count endpoint', () => {
    try {
      assertGraduateOmitsCount({ countedQuantity: 50 });
      throw new Error('expected a ZodError');
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      const issue = (err as z.ZodError).errors[0];
      expect(issue.path).toEqual(['countedQuantity']);
      expect(issue.message).toMatch(/count/i);
    }
  });

  it('refuses even a countedQuantity of null / undefined (the KEY is the tell)', () => {
    expect(() => assertGraduateOmitsCount({ countedQuantity: null })).toThrow(z.ZodError);
    expect(() => assertGraduateOmitsCount({ countedQuantity: undefined })).toThrow(z.ZodError);
  });

  it('passes a clean body, a null body and a non-object body', () => {
    expect(() => assertGraduateOmitsCount({ mode: 'existing', productId: 7, locationId: 1 })).not.toThrow();
    expect(() => assertGraduateOmitsCount(null)).not.toThrow();
    expect(() => assertGraduateOmitsCount('nope')).not.toThrow();
  });
});

describe('assertGraduateOverridePair (both-or-neither)', () => {
  const base = { mode: 'existing' as const, productId: 7, locationId: 1 };

  it('accepts neither', () => {
    expect(() => assertGraduateOverridePair(base as never)).not.toThrow();
  });

  it('accepts both', () => {
    expect(() =>
      assertGraduateOverridePair({ ...base, overrideQuantity: 3, overrideReason: 'damaged' } as never)
    ).not.toThrow();
  });

  it('rejects a quantity without a reason', () => {
    expect(() =>
      assertGraduateOverridePair({ ...base, overrideQuantity: 3 } as never)
    ).toThrow(z.ZodError);
  });

  it('rejects a reason without a quantity', () => {
    expect(() =>
      assertGraduateOverridePair({ ...base, overrideReason: 'damaged' } as never)
    ).toThrow(z.ZodError);
  });

  it('names overrideReason as the missing half when only the quantity was sent', () => {
    try {
      assertGraduateOverridePair({ ...base, overrideQuantity: 3 } as never);
      throw new Error('expected a ZodError');
    } catch (err) {
      expect(err).toBeInstanceOf(z.ZodError);
      expect((err as z.ZodError).errors[0].path).toEqual(['overrideReason']);
    }
  });
});
