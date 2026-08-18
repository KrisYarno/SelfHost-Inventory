/**
 * @jest-environment node
 *
 * Unit tests for `lib/validation/supply-orders.ts` (contract pack C2a.4).
 *
 * Two house rules are on trial here, not just the field bounds:
 *
 *   PLAIN ZodObject — every exported request schema must be a plain `z.object`
 *   with a readable `.shape`, because the MCP adapter reads `.shape` off them.
 *   A `.refine`/`.superRefine` anywhere at the object level turns the schema
 *   into a ZodEffects and `.shape` disappears. Cross-field rules are therefore
 *   post-parse `assert*` helpers that throw a ZodError (-> apiHandler 400).
 *
 *   COST NEVER TRAVELS (premise 1) — a product created from a supply-order line
 *   gets NO costPrice. Zod strips unknown keys silently, so "the schema does not
 *   declare it" is NOT enough: an injected `costPrice` would vanish and the
 *   caller would think it was honoured. The raw body is therefore checked BEFORE
 *   the parse, with hasOwnProperty semantics.
 */

import { z } from 'zod';
import * as supplyOrders from '@/lib/validation/supply-orders';
import {
  CreateSupplyOrderSchema,
  LineInputSchema,
  ProductCreateFromOrderSchema,
  ProductCreateFromOrderShape,
  AddArrivedLineSchema,
  PatchLineSchema,
  VerifyLineSchema,
  StockInSchema,
  DiscardRemainingSchema,
  DiscardLineSchema,
  ResolveSchema,
  PatchSupplyOrderSchema,
  LabelingQueueQuerySchema,
  SupplyOrdersAnalyticsQuerySchema,
  assertProductCreateOmitsCostPrice,
  assertProductSizePair,
  assertRealCalendarDate,
  assertAnalyticsWindow,
  assertPatchNotEmpty,
  assertLinePatchNotEmpty,
} from '@/lib/validation/supply-orders';
import { RESOLUTIONS } from '@/lib/exceptions/kinds';

const EXISTING_PRODUCT = { mode: 'existing' as const, productId: 7 };

function line(overrides: Record<string, unknown> = {}) {
  return {
    product: EXISTING_PRODUCT,
    orderedQuantity: 10,
    lineTotalCents: 125_000,
    ...overrides,
  };
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    orderedAt: '2026-08-18',
    lines: [line()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The house rule the MCP adapter depends on
// ---------------------------------------------------------------------------

describe('every exported schema is a plain ZodObject with a readable .shape', () => {
  it('exports no ZodEffects (no .refine / .superRefine at the object level)', () => {
    const schemas = Object.entries(supplyOrders).filter(
      ([, value]) => value instanceof z.ZodType,
    ) as [string, z.ZodType][];

    // Self-check: if the filter stops finding schemas the assertion below is vacuous.
    expect(schemas.length).toBeGreaterThanOrEqual(12);

    const offenders = schemas
      .filter(([, schema]) => !(schema instanceof z.ZodObject))
      .map(([name]) => name);
    expect(offenders).toEqual([]);

    for (const [name, schema] of schemas) {
      expect(typeof (schema as z.ZodObject<z.ZodRawShape>).shape).toBe('object');
      expect(name).not.toBe('');
    }
  });
});

// ---------------------------------------------------------------------------
// PK-8 — the product schema, minus cost
// ---------------------------------------------------------------------------

describe('ProductCreateFromOrder — the UI product shape MINUS costPrice (PK-8)', () => {
  it('removes costPrice and NOTHING else (locationId + reorderConfig stay)', () => {
    expect(Object.keys(ProductCreateFromOrderShape)).not.toContain('costPrice');
    expect(Object.keys(ProductCreateFromOrderSchema.shape)).not.toContain('costPrice');
    // PK2-3: the resolver mirrors POST /api/products, which honours both.
    expect(Object.keys(ProductCreateFromOrderShape)).toEqual(
      expect.arrayContaining([
        'baseName',
        'variant',
        'unit',
        'numericValue',
        'lowStockThreshold',
        'retailPrice',
        'locationId',
        'reorderConfig',
      ]),
    );
  });

  it('parses a full product payload, reorderConfig and location included', () => {
    const parsed = ProductCreateFromOrderSchema.parse({
      baseName: 'Peptide X',
      variant: '10mg',
      unit: 'mg',
      numericValue: 10,
      lowStockThreshold: null,
      retailPrice: 99.5,
      locationId: 3,
      reorderConfig: { leadTimeDays: 14, minOrderQuantity: 5 },
    });
    expect(parsed.locationId).toBe(3);
    expect(parsed.reorderConfig).toEqual({ leadTimeDays: 14, minOrderQuantity: 5 });
  });

  it('SILENTLY STRIPS an injected costPrice — which is why the raw check exists', () => {
    const parsed = ProductCreateFromOrderSchema.parse({
      baseName: 'Peptide X',
      variant: '10mg',
      costPrice: 42,
    }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('costPrice');
  });

  it('assertProductCreateOmitsCostPrice refuses a PRESENT key, whatever its value', () => {
    // hasOwnProperty semantics: undefined and null are PRESENT, and a client
    // that sent either believed it was setting a cost.
    for (const raw of [{ costPrice: 42 }, { costPrice: undefined }, { costPrice: null }]) {
      expect(() => assertProductCreateOmitsCostPrice(raw)).toThrow(z.ZodError);
    }
  });

  it('assertProductCreateOmitsCostPrice passes when the key is genuinely absent', () => {
    expect(() => assertProductCreateOmitsCostPrice({ baseName: 'X' })).not.toThrow();
    expect(() => assertProductCreateOmitsCostPrice(undefined)).not.toThrow();
    expect(() => assertProductCreateOmitsCostPrice(null)).not.toThrow();
  });

  it('assertProductCreateOmitsCostPrice ignores an INHERITED costPrice', () => {
    const raw = Object.create({ costPrice: 42 }) as Record<string, unknown>;
    raw.baseName = 'X';
    expect(() => assertProductCreateOmitsCostPrice(raw)).not.toThrow();
  });

  it('assertProductSizePair keeps the unit/value pairing the superRefine enforced', () => {
    expect(() => assertProductSizePair({ unit: 'mg', numericValue: 10 })).not.toThrow();
    expect(() => assertProductSizePair({})).not.toThrow();
    expect(() => assertProductSizePair({ numericValue: 10 })).toThrow(z.ZodError);
    expect(() => assertProductSizePair({ unit: 'mg' })).toThrow(z.ZodError);
    // An explicit null numericValue is "no size", not "a size of 0".
    expect(() => assertProductSizePair({ numericValue: null })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CreateSupplyOrderSchema
// ---------------------------------------------------------------------------

describe('CreateSupplyOrderSchema', () => {
  it('accepts the minimum order: a date and one line', () => {
    const parsed = CreateSupplyOrderSchema.parse(order());
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.orderedAt).toBe('2026-08-18');
  });

  it('defaults feesCents to 0 — fees NOT ENTERED means zero, not unknown (G1s-12)', () => {
    expect(CreateSupplyOrderSchema.parse(order()).feesCents).toBe(0);
    expect(CreateSupplyOrderSchema.parse(order({ feesCents: 4500 })).feesCents).toBe(4500);
  });

  it('defaults labelingRequired to true (the bench is the normal path)', () => {
    expect(CreateSupplyOrderSchema.parse(order()).lines[0].labelingRequired).toBe(true);
    expect(
      CreateSupplyOrderSchema.parse(order({ lines: [line({ labelingRequired: false })] }))
        .lines[0].labelingRequired,
    ).toBe(false);
  });

  it('requires 1..50 lines — a header with no lines is not an order any more', () => {
    expect(() => CreateSupplyOrderSchema.parse(order({ lines: [] }))).toThrow(z.ZodError);
    expect(() =>
      CreateSupplyOrderSchema.parse(order({ lines: Array.from({ length: 51 }, () => line()) })),
    ).toThrow(z.ZodError);
    expect(
      CreateSupplyOrderSchema.parse(order({ lines: Array.from({ length: 50 }, () => line()) }))
        .lines,
    ).toHaveLength(50);
  });

  it('parses orderedAt LEXICALLY — the calendar day, never an instant', () => {
    for (const bad of [
      '2026-8-18',
      '18-08-2026',
      '08/18/2026',
      '2026-08-18T00:00:00.000Z',
      '2026-08-18 ',
      '',
    ]) {
      expect(() => CreateSupplyOrderSchema.parse(order({ orderedAt: bad }))).toThrow(z.ZodError);
    }
    expect(() => CreateSupplyOrderSchema.parse(order({ orderedAt: undefined }))).toThrow(
      z.ZodError,
    );
  });

  it('bounds the free text (supplier/supplierRef/feesNote 255, notes 5000)', () => {
    expect(() =>
      CreateSupplyOrderSchema.parse(order({ supplier: 'x'.repeat(256) })),
    ).toThrow(z.ZodError);
    expect(() =>
      CreateSupplyOrderSchema.parse(order({ supplierRef: 'x'.repeat(256) })),
    ).toThrow(z.ZodError);
    expect(() =>
      CreateSupplyOrderSchema.parse(order({ feesNote: 'x'.repeat(256) })),
    ).toThrow(z.ZodError);
    expect(() => CreateSupplyOrderSchema.parse(order({ notes: 'x'.repeat(5001) }))).toThrow(
      z.ZodError,
    );
    expect(
      CreateSupplyOrderSchema.parse(
        order({ supplier: 'x'.repeat(255), notes: 'y'.repeat(5000) }),
      ).supplier,
    ).toHaveLength(255);
  });

  it('refuses negative money', () => {
    expect(() => CreateSupplyOrderSchema.parse(order({ feesCents: -1 }))).toThrow(z.ZodError);
    expect(() =>
      CreateSupplyOrderSchema.parse(order({ lines: [line({ lineTotalCents: -1 })] })),
    ).toThrow(z.ZodError);
  });
});

describe('LineInputSchema — the ordered line', () => {
  it('accepts both product modes', () => {
    expect(LineInputSchema.parse(line()).product).toEqual(EXISTING_PRODUCT);
    const created = LineInputSchema.parse(
      line({ product: { mode: 'new', productFields: { baseName: 'A', variant: 'B' } } }),
    );
    expect(created.product.mode).toBe('new');
  });

  it('refuses an unknown product mode (no third way to name a product)', () => {
    expect(() => LineInputSchema.parse(line({ product: { mode: 'guess', productId: 1 } }))).toThrow(
      z.ZodError,
    );
  });

  it('orders at least ONE unit — a zero-unit order line is a client bug', () => {
    expect(() => LineInputSchema.parse(line({ orderedQuantity: 0 }))).toThrow(z.ZodError);
    expect(() => LineInputSchema.parse(line({ orderedQuantity: 1.5 }))).toThrow(z.ZodError);
    expect(LineInputSchema.parse(line({ orderedQuantity: 1 })).orderedQuantity).toBe(1);
  });

  it('accepts a lineTotalCents of 0 — "free" is a real price (unit cost goes NULL)', () => {
    expect(LineInputSchema.parse(line({ lineTotalCents: 0 })).lineTotalCents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Delivery + labeling requests
// ---------------------------------------------------------------------------

describe('AddArrivedLineSchema — the unordered arrival (§4.2.5)', () => {
  it('takes a VERIFIED count (0 legal) and an OPTIONAL, nullable total', () => {
    const parsed = AddArrivedLineSchema.parse({
      product: EXISTING_PRODUCT,
      verifiedQuantity: 0,
    });
    expect(parsed.verifiedQuantity).toBe(0);
    expect(
      AddArrivedLineSchema.parse({
        product: EXISTING_PRODUCT,
        verifiedQuantity: 4,
        lineTotalCents: null,
      }).lineTotalCents,
    ).toBeNull();
    expect(
      AddArrivedLineSchema.parse({
        product: EXISTING_PRODUCT,
        verifiedQuantity: 4,
        lineTotalCents: 1000,
      }).lineTotalCents,
    ).toBe(1000);
  });

  it('carries no orderedQuantity — an unordered line stays unordered', () => {
    expect(Object.keys(AddArrivedLineSchema.shape)).not.toContain('orderedQuantity');
  });

  it('refuses a negative count', () => {
    expect(() =>
      AddArrivedLineSchema.parse({ product: EXISTING_PRODUCT, verifiedQuantity: -1 }),
    ).toThrow(z.ZodError);
  });
});

describe('PatchLineSchema + assertLinePatchNotEmpty', () => {
  it('accepts a single-field edit', () => {
    expect(PatchLineSchema.parse({ orderedQuantity: 12 }).orderedQuantity).toBe(12);
    expect(PatchLineSchema.parse({ labelingRequired: false }).labelingRequired).toBe(false);
  });

  it('refuses a PATCH that asks for nothing (a no-op write is a client bug)', () => {
    expect(() => assertLinePatchNotEmpty(PatchLineSchema.parse({}))).toThrow(z.ZodError);
    expect(() =>
      assertLinePatchNotEmpty(PatchLineSchema.parse({ notes: 'x' })),
    ).not.toThrow();
  });
});

describe('VerifyLineSchema', () => {
  it('accepts a count of 0 — VERIFIED(0) is a real outcome, not a discard', () => {
    expect(VerifyLineSchema.parse({ verifiedQuantity: 0 }).verifiedQuantity).toBe(0);
  });

  it('bounds the note at 500 and refuses a negative count', () => {
    expect(() => VerifyLineSchema.parse({ verifiedQuantity: -1 })).toThrow(z.ZodError);
    expect(() =>
      VerifyLineSchema.parse({ verifiedQuantity: 1, note: 'x'.repeat(501) }),
    ).toThrow(z.ZodError);
  });

  it('optionally re-points the line at the product that ACTUALLY arrived', () => {
    expect(
      VerifyLineSchema.parse({ verifiedQuantity: 3, deliveredProduct: EXISTING_PRODUCT })
        .deliveredProduct,
    ).toEqual(EXISTING_PRODUCT);
    expect(
      VerifyLineSchema.parse({
        verifiedQuantity: 3,
        deliveredProduct: { mode: 'new', productFields: { baseName: 'A', variant: 'B' } },
      }).deliveredProduct?.mode,
    ).toBe('new');
  });
});

describe('StockInSchema — one labeled batch', () => {
  it('requires a uuid bookingKey (the idempotency identity)', () => {
    const good = {
      bookingKey: '3f1d5b0e-9d1c-4a6b-8f2e-7c1a0b5d9e42',
      quantity: 5,
      locationId: 2,
    };
    expect(StockInSchema.parse(good).bookingKey).toBe(good.bookingKey);
    for (const bad of ['', 'not-a-uuid', '3f1d5b0e9d1c4a6b8f2e7c1a0b5d9e42']) {
      expect(() => StockInSchema.parse({ ...good, bookingKey: bad })).toThrow(z.ZodError);
    }
  });

  it('books at least one unit into a real location', () => {
    const good = {
      bookingKey: '3f1d5b0e-9d1c-4a6b-8f2e-7c1a0b5d9e42',
      quantity: 5,
      locationId: 2,
    };
    expect(() => StockInSchema.parse({ ...good, quantity: 0 })).toThrow(z.ZodError);
    expect(() => StockInSchema.parse({ ...good, locationId: 0 })).toThrow(z.ZodError);
    expect(() => StockInSchema.parse({ ...good, note: 'x'.repeat(501) })).toThrow(z.ZodError);
  });
});

describe('DiscardRemainingSchema / DiscardLineSchema', () => {
  it('discarding the REMAINDER demands a reason (money is being written off)', () => {
    expect(DiscardRemainingSchema.parse({ reason: 'damaged in the labeler' }).reason).toBe(
      'damaged in the labeler',
    );
    expect(() => DiscardRemainingSchema.parse({ reason: '' })).toThrow(z.ZodError);
    expect(() => DiscardRemainingSchema.parse({})).toThrow(z.ZodError);
    expect(() => DiscardRemainingSchema.parse({ reason: 'x'.repeat(501) })).toThrow(z.ZodError);
  });

  it('discarding a whole LINE takes an optional reason', () => {
    expect(DiscardLineSchema.parse({}).reason).toBeUndefined();
    expect(DiscardLineSchema.parse({ reason: 'ordered by mistake' }).reason).toBe(
      'ordered by mistake',
    );
    expect(() => DiscardLineSchema.parse({ reason: 'x'.repeat(501) })).toThrow(z.ZodError);
  });
});

describe('ResolveSchema — settling an exception (§6)', () => {
  const good = { exceptionKey: 'recv-discrepancy:5', resolution: 'accepted-loss' };

  it('accepts every member of the CLOSED resolution vocabulary', () => {
    for (const resolution of RESOLUTIONS) {
      expect(ResolveSchema.parse({ ...good, resolution }).resolution).toBe(resolution);
    }
  });

  it('refuses an unlisted resolution (the vocabulary is closed)', () => {
    expect(() => ResolveSchema.parse({ ...good, resolution: 'sorted-it-out' })).toThrow(
      z.ZodError,
    );
  });

  it('bounds the key at the column width (191) and refuses an empty one', () => {
    expect(() => ResolveSchema.parse({ ...good, exceptionKey: '' })).toThrow(z.ZodError);
    expect(() => ResolveSchema.parse({ ...good, exceptionKey: 'x'.repeat(192) })).toThrow(
      z.ZodError,
    );
    expect(ResolveSchema.parse({ ...good, exceptionKey: 'x'.repeat(191) }).exceptionKey).toHaveLength(
      191,
    );
  });

  it('carries the settlement refs the vocabulary needs', () => {
    const parsed = ResolveSchema.parse({
      ...good,
      resolution: 'supplier-credited',
      creditRef: 'CR-9',
      relatedShipmentId: 'ship_abc',
      note: 'credited in full',
    });
    expect(parsed.creditRef).toBe('CR-9');
    expect(parsed.relatedShipmentId).toBe('ship_abc');
    expect(() => ResolveSchema.parse({ ...good, relatedShipmentId: 'x'.repeat(31) })).toThrow(
      z.ZodError,
    );
    expect(() => ResolveSchema.parse({ ...good, creditRef: 'x'.repeat(101) })).toThrow(z.ZodError);
  });
});

describe('PatchSupplyOrderSchema + assertPatchNotEmpty', () => {
  it('CLEARS with an explicit null (undefined = untouched, null = erase)', () => {
    const parsed = PatchSupplyOrderSchema.parse({
      supplier: null,
      supplierRef: null,
      notes: null,
      feesCents: null,
      feesNote: null,
    });
    expect(parsed).toEqual({
      supplier: null,
      supplierRef: null,
      notes: null,
      feesCents: null,
      feesNote: null,
    });
  });

  it('refuses a NULL orderedAt — the date is the model discriminator', () => {
    // `orderedAt IS NULL` is what makes a header LEGACY. Clearing it would turn
    // a supply order into a W1 receipt behind the operator's back.
    expect(() => PatchSupplyOrderSchema.parse({ orderedAt: null })).toThrow(z.ZodError);
    expect(PatchSupplyOrderSchema.parse({ orderedAt: '2026-08-19' }).orderedAt).toBe('2026-08-19');
  });

  it('takes the two lifecycle actions and nothing else', () => {
    expect(PatchSupplyOrderSchema.parse({ action: 'close' }).action).toBe('close');
    expect(PatchSupplyOrderSchema.parse({ action: 'cancel' }).action).toBe('cancel');
    expect(() => PatchSupplyOrderSchema.parse({ action: 'reopen' })).toThrow(z.ZodError);
  });

  it('refuses a PATCH that asks for nothing', () => {
    expect(() => assertPatchNotEmpty(PatchSupplyOrderSchema.parse({}))).toThrow(z.ZodError);
    expect(() =>
      assertPatchNotEmpty(PatchSupplyOrderSchema.parse({ feesCents: null })),
    ).not.toThrow();
  });
});

describe('query schemas', () => {
  it('LabelingQueueQuerySchema takes an optional order id', () => {
    expect(LabelingQueueQuerySchema.parse({}).orderId).toBeUndefined();
    expect(LabelingQueueQuerySchema.parse({ orderId: 'ship_abc' }).orderId).toBe('ship_abc');
    expect(() => LabelingQueueQuerySchema.parse({ orderId: 'x'.repeat(31) })).toThrow(z.ZodError);
  });

  it('SupplyOrdersAnalyticsQuerySchema requires BOTH ends of the window, lexically', () => {
    expect(
      SupplyOrdersAnalyticsQuerySchema.parse({ from: '2026-08-01', to: '2026-08-31' }).from,
    ).toBe('2026-08-01');
    expect(() => SupplyOrdersAnalyticsQuerySchema.parse({ from: '2026-08-01' })).toThrow(
      z.ZodError,
    );
    expect(() =>
      SupplyOrdersAnalyticsQuerySchema.parse({ from: '2026-8-1', to: '2026-08-31' }),
    ).toThrow(z.ZodError);
  });
});

// ---------------------------------------------------------------------------
// Post-parse date rules (the schema is lexical; reality is checked here)
// ---------------------------------------------------------------------------

describe('assertRealCalendarDate — lexical is not enough', () => {
  it('accepts real days, including a leap day', () => {
    for (const good of ['2026-08-18', '2024-02-29', '2026-01-01', '2026-12-31']) {
      expect(() => assertRealCalendarDate(good, 'orderedAt')).not.toThrow();
    }
  });

  it('refuses days the calendar does not have (new Date would roll them over)', () => {
    // `new Date('2026-02-30')` silently becomes Mar 2 — accepting it would store
    // an order date the operator never typed.
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '2025-02-29']) {
      expect(() => assertRealCalendarDate(bad, 'orderedAt')).toThrow(z.ZodError);
    }
  });

  it('names the field it refused (the client can point at it)', () => {
    try {
      assertRealCalendarDate('2026-02-30', 'orderedAt');
      throw new Error('expected a ZodError');
    } catch (error) {
      expect(error).toBeInstanceOf(z.ZodError);
      expect((error as z.ZodError).issues[0].path).toEqual(['orderedAt']);
    }
  });
});

describe('assertAnalyticsWindow', () => {
  it('accepts a forward window, including a single day', () => {
    expect(() => assertAnalyticsWindow({ from: '2026-08-01', to: '2026-08-31' })).not.toThrow();
    expect(() => assertAnalyticsWindow({ from: '2026-08-01', to: '2026-08-01' })).not.toThrow();
  });

  it('refuses from > to, and refuses an impossible day at either end', () => {
    expect(() => assertAnalyticsWindow({ from: '2026-08-31', to: '2026-08-01' })).toThrow(
      z.ZodError,
    );
    expect(() => assertAnalyticsWindow({ from: '2026-02-30', to: '2026-08-01' })).toThrow(
      z.ZodError,
    );
    expect(() => assertAnalyticsWindow({ from: '2026-08-01', to: '2026-02-30' })).toThrow(
      z.ZodError,
    );
  });
});
