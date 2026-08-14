/**
 * FD3-1 (fix round 4) — the batch cost bill's REQUEST SHAPE.
 *
 * `AllocateShipmentCostsSchema` is what the freight panel's Accept now sends:
 * the WHOLE bill, every line carrying both the cost to write and the cost the
 * row must still hold. Round 3 put that precondition on the per-line staging
 * PATCH (`ifUnitCostCents`); the fan-out it guarded is gone, so the rule lives
 * here — on the only request that can still write a bill.
 *
 * House rule, unchanged: plain `z.object` with no `.refine` (the MCP adapter
 * reads `.shape`), cross-field rules as post-parse `assert*` helpers.
 */

import { z } from 'zod';
import {
  AllocateShipmentCostsSchema,
  assertAllocationLineIdsUnique,
} from '@/lib/validation/inbound-shipment';

const line = (over: Record<string, unknown> = {}) => ({
  id: 11,
  unitCostCents: 600,
  ifUnitCostCents: 500,
  ...over,
});

describe('AllocateShipmentCostsSchema', () => {
  it('accepts a bill of one or more fully-specified lines', () => {
    const parsed = AllocateShipmentCostsSchema.safeParse({
      lines: [line(), line({ id: 12, unitCostCents: 240, ifUnitCostCents: null })],
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.lines).toHaveLength(2);
  });

  it('REFUSES an empty bill — a write request that writes nothing is a bug', () => {
    expect(AllocateShipmentCostsSchema.safeParse({ lines: [] }).success).toBe(false);
    expect(AllocateShipmentCostsSchema.safeParse({}).success).toBe(false);
  });

  it('requires EVERY field on every line (no implicit unconditional write)', () => {
    expect(
      AllocateShipmentCostsSchema.safeParse({ lines: [{ id: 11, unitCostCents: 600 }] }).success,
    ).toBe(false);
    expect(
      AllocateShipmentCostsSchema.safeParse({ lines: [{ id: 11, ifUnitCostCents: 500 }] }).success,
    ).toBe(false);
    expect(
      AllocateShipmentCostsSchema.safeParse({ lines: [{ unitCostCents: 600, ifUnitCostCents: 500 }] })
        .success,
    ).toBe(false);
  });

  it('keeps NULL legal on the PRECONDITION ("still unpriced") and illegal on the write', () => {
    // A bill prices lines; un-pricing one is the manual per-line save's job.
    expect(
      AllocateShipmentCostsSchema.safeParse({ lines: [line({ ifUnitCostCents: null })] }).success,
    ).toBe(true);
    expect(
      AllocateShipmentCostsSchema.safeParse({ lines: [line({ unitCostCents: null })] }).success,
    ).toBe(false);
  });

  it('rejects fractional, negative and out-of-range cents on both halves', () => {
    expect(
      AllocateShipmentCostsSchema.safeParse({ lines: [line({ unitCostCents: 6.5 })] }).success,
    ).toBe(false);
    expect(
      AllocateShipmentCostsSchema.safeParse({ lines: [line({ unitCostCents: -1 })] }).success,
    ).toBe(false);
    expect(
      AllocateShipmentCostsSchema.safeParse({ lines: [line({ ifUnitCostCents: 1.5 })] }).success,
    ).toBe(false);
    expect(
      AllocateShipmentCostsSchema.safeParse({ lines: [line({ ifUnitCostCents: -1 })] }).success,
    ).toBe(false);
  });

  it('rejects a non-positive line id', () => {
    expect(AllocateShipmentCostsSchema.safeParse({ lines: [line({ id: 0 })] }).success).toBe(false);
    expect(AllocateShipmentCostsSchema.safeParse({ lines: [line({ id: -3 })] }).success).toBe(false);
  });

  it('stays a plain ZodObject (the MCP adapter reads .shape — no .refine)', () => {
    expect(AllocateShipmentCostsSchema).toBeInstanceOf(z.ZodObject);
    expect(Object.keys(AllocateShipmentCostsSchema.shape)).toEqual(['lines']);
  });
});

describe('assertAllocationLineIdsUnique', () => {
  it('passes a bill whose lines are all different', () => {
    expect(() =>
      assertAllocationLineIdsUnique({ lines: [line(), line({ id: 12 })] }),
    ).not.toThrow();
  });

  it('REFUSES a repeated line — two costs for one line have no single answer', () => {
    expect(() =>
      assertAllocationLineIdsUnique({ lines: [line(), line({ unitCostCents: 700 })] }),
    ).toThrow(z.ZodError);
  });

  it('names the repeated line, so the client can point at it', () => {
    try {
      assertAllocationLineIdsUnique({ lines: [line(), line()] });
      throw new Error('expected a ZodError');
    } catch (error) {
      expect(error).toBeInstanceOf(z.ZodError);
      expect((error as z.ZodError).errors[0].message).toMatch(/11/);
    }
  });
});
