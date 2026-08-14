/**
 * FD3-1 (fix round 4) — the batch cost bill's REQUEST SHAPE.
 *
 * `AllocateShipmentCostsSchema` is what the freight panel's Accept now sends:
 * the WHOLE bill, every line carrying both the cost to write and the cost the
 * row must still hold. Round 3 put that precondition on the per-line staging
 * PATCH (`ifUnitCostCents`); the fan-out it guarded is gone, so the rule lives
 * here — on the only request that can still write a bill.
 *
 * FD4-1 (fix round 6) — THE BILL IS THE WHOLE BASIS, NOT JUST THE WRITES.
 *
 * A freight split is computed from every line's cost AND quantity, so a bill
 * that only names the lines it writes leaves the rest of its own basis
 * unchecked. Two live holes came out of that: a line the panel excluded (a
 * no-op, a withheld inexact split, an unpriced line) could have its cost change
 * after the last render — nothing on the server would notice — and no line
 * carried a QUANTITY precondition at all, so a recount landing mid-Accept let
 * per-unit costs computed over the old units be written over the new ones.
 *
 * So every line of the session travels, and the shape says which kind it is:
 *   WITH `unitCostCents`     a WRITE line;
 *   WITHOUT `unitCostCents`  a VERIFY-ONLY line — part of the basis, claimed and
 *                            checked, never written.
 * `qtySource` + `qty` are the frozen quantity that share was divided by.
 *
 * House rule, unchanged: plain `z.object` with no `.refine` (the MCP adapter
 * reads `.shape`), cross-field rules as post-parse `assert*` helpers.
 */

import { z } from 'zod';
import {
  AllocateShipmentCostsSchema,
  assertAllocationLineIdsUnique,
  assertAllocationHasWriteLine,
  type AllocateShipmentCostsInput,
} from '@/lib/validation/inbound-shipment';

type BillLine = AllocateShipmentCostsInput['lines'][number];

/** A well-formed WRITE line. */
const line = (over: Partial<BillLine> = {}): BillLine => ({
  id: 11,
  qtySource: 'counted',
  qty: 10,
  ifUnitCostCents: 500,
  unitCostCents: 600,
  ...over,
});

/** A well-formed VERIFY-ONLY line: basis, never a write. */
const verifyOnly = (over: Partial<BillLine> = {}): BillLine => {
  const { unitCostCents: _dropped, ...rest } = line(over);
  return rest;
};

/** Deliberately loose, so the malformed cases below can actually be malformed. */
const raw = (over: Record<string, unknown> = {}) => ({
  id: 11,
  qtySource: 'counted',
  qty: 10,
  ifUnitCostCents: 500,
  unitCostCents: 600,
  ...over,
});

describe('AllocateShipmentCostsSchema', () => {
  it('accepts a bill of one or more fully-specified lines', () => {
    const parsed = AllocateShipmentCostsSchema.safeParse({
      lines: [raw(), raw({ id: 12, unitCostCents: 240, ifUnitCostCents: null })],
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.lines).toHaveLength(2);
  });

  it('FD4-1: accepts a VERIFY-ONLY line — no unitCostCents, still part of the basis', () => {
    const parsed = AllocateShipmentCostsSchema.safeParse({
      lines: [raw(), verifyOnly({ id: 12 })],
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.lines[1].unitCostCents).toBeUndefined();
  });

  it('FD4-1: requires the frozen QUANTITY on every line, whole and non-negative', () => {
    expect(AllocateShipmentCostsSchema.safeParse({ lines: [raw({ qty: 0 })] }).success).toBe(
      true,
    );
    const missing = { ...raw() } as Record<string, unknown>;
    delete missing.qty;
    expect(AllocateShipmentCostsSchema.safeParse({ lines: [missing] }).success).toBe(false);
    expect(AllocateShipmentCostsSchema.safeParse({ lines: [raw({ qty: -1 })] }).success).toBe(
      false,
    );
    expect(AllocateShipmentCostsSchema.safeParse({ lines: [raw({ qty: 1.5 })] }).success).toBe(
      false,
    );
  });

  it('FD4-1: requires qtySource from the CLOSED vocabulary (the WHERE is built from it)', () => {
    for (const qtySource of ['counted', 'expected', 'none']) {
      expect(AllocateShipmentCostsSchema.safeParse({ lines: [raw({ qtySource })] }).success).toBe(
        true,
      );
    }
    expect(
      AllocateShipmentCostsSchema.safeParse({ lines: [raw({ qtySource: 'guessed' })] }).success,
    ).toBe(false);
    const missing = { ...raw() } as Record<string, unknown>;
    delete missing.qtySource;
    expect(AllocateShipmentCostsSchema.safeParse({ lines: [missing] }).success).toBe(false);
  });

  it('REFUSES an empty bill — a write request that writes nothing is a bug', () => {
    expect(AllocateShipmentCostsSchema.safeParse({ lines: [] }).success).toBe(false);
    expect(AllocateShipmentCostsSchema.safeParse({}).success).toBe(false);
  });

  it('requires the id and the PRECONDITION on every line (no implicit unconditional write)', () => {
    const noPrecondition = { ...raw() } as Record<string, unknown>;
    delete noPrecondition.ifUnitCostCents;
    expect(AllocateShipmentCostsSchema.safeParse({ lines: [noPrecondition] }).success).toBe(false);

    const noId = { ...raw() } as Record<string, unknown>;
    delete noId.id;
    expect(AllocateShipmentCostsSchema.safeParse({ lines: [noId] }).success).toBe(false);
  });

  it('keeps NULL legal on the PRECONDITION ("still unpriced") and illegal on the write', () => {
    // A bill prices lines; un-pricing one is the manual per-line save's job.
    expect(
      AllocateShipmentCostsSchema.safeParse({ lines: [raw({ ifUnitCostCents: null })] }).success,
    ).toBe(true);
    expect(
      AllocateShipmentCostsSchema.safeParse({ lines: [raw({ unitCostCents: null })] }).success,
    ).toBe(false);
  });

  it('rejects fractional, negative and out-of-range cents on both halves', () => {
    expect(
      AllocateShipmentCostsSchema.safeParse({ lines: [raw({ unitCostCents: 6.5 })] }).success,
    ).toBe(false);
    expect(
      AllocateShipmentCostsSchema.safeParse({ lines: [raw({ unitCostCents: -1 })] }).success,
    ).toBe(false);
    expect(
      AllocateShipmentCostsSchema.safeParse({ lines: [raw({ ifUnitCostCents: 1.5 })] }).success,
    ).toBe(false);
    expect(
      AllocateShipmentCostsSchema.safeParse({ lines: [raw({ ifUnitCostCents: -1 })] }).success,
    ).toBe(false);
  });

  it('rejects a non-positive line id', () => {
    expect(AllocateShipmentCostsSchema.safeParse({ lines: [raw({ id: 0 })] }).success).toBe(false);
    expect(AllocateShipmentCostsSchema.safeParse({ lines: [raw({ id: -3 })] }).success).toBe(false);
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

  it('REFUSES a repeat even when one of the two is verify-only', () => {
    expect(() => assertAllocationLineIdsUnique({ lines: [line(), verifyOnly()] })).toThrow(
      z.ZodError,
    );
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

// ---------------------------------------------------------------------------
// FD4-1 — a bill that writes nothing is still a client bug.
//
// The panel's own gate (QA-12) is that Accept stays disabled when every line
// would restate what is already stored. That gate is a CLIENT gate; the server
// keeps the same promise on its own terms, or a stale panel could spend a
// transaction taking row locks to verify a basis it has no intention of using.
// ---------------------------------------------------------------------------

describe('assertAllocationHasWriteLine', () => {
  it('passes a bill with at least one write line among the verify-only ones', () => {
    expect(() =>
      assertAllocationHasWriteLine({ lines: [verifyOnly({ id: 9 }), line()] }),
    ).not.toThrow();
  });

  it('REFUSES a bill of verify-only lines — nothing would be written', () => {
    expect(() =>
      assertAllocationHasWriteLine({ lines: [verifyOnly(), verifyOnly({ id: 12 })] }),
    ).toThrow(z.ZodError);
  });

  it('says what is missing, in the vocabulary of the request', () => {
    try {
      assertAllocationHasWriteLine({ lines: [verifyOnly()] });
      throw new Error('expected a ZodError');
    } catch (error) {
      expect(error).toBeInstanceOf(z.ZodError);
      expect((error as z.ZodError).errors[0].message).toMatch(/unitCostCents/);
    }
  });
});
