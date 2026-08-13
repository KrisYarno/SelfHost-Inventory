import { z } from 'zod';
import { ProductCreateUISchema } from '@/lib/validation/product';

/**
 * Zod schemas for the pre-staging intake flow.
 *
 * - CreateStagingSchema: POST /api/staging-items (log a box).
 * - PatchStagingSchema:  PATCH /api/staging-items/[id] (label / edit).
 *     `countedQuantity` is NOT here: W1-2b (pack REV-3 T2) moved counting onto
 *     its own endpoint, because a count is a physical act that must stamp WHO
 *     counted and WHEN and must always be audited. A body that still carries
 *     the field is refused by `assertStagingPatchOmitsCount` rather than
 *     silently stripped by Zod — a caller that believes it counted something is
 *     worse than one that got an error.
 * - CountStagingSchema:  POST /api/staging-items/[id]/count.
 * - GraduateSchema:      POST /api/staging-items/[id]/graduate.
 *     A discriminated union on `mode`:
 *       - "existing": restock an existing product (requires `productId`).
 *       - "new":      create a provisional product (requires `productFields`,
 *                     reusing the same ProductCreateUISchema as the Add Product form).
 *     W1-3a (pack REV-3 T2) DROPPED `countedQuantity` from this request: the
 *     quantity is read from the staging ROW inside the graduation transaction.
 *     The request may only ask to book a DIFFERENT number, and only by naming
 *     it and explaining it — the `overrideQuantity`/`overrideReason` pair.
 */

export const CreateStagingSchema = z.object({
  description: z.string().min(1).max(255),
  expectedQuantity: z.number().int().min(0).max(1_000_000).optional(),
  resolvedProductId: z.number().int().positive().optional(),
  vendor: z.string().max(255).optional(),
  reference: z.string().max(255).optional(),
  notes: z.string().max(5000).optional(),
  locationId: z.number().int().positive(),
});

export const PatchStagingSchema = CreateStagingSchema.partial().extend({
  // Inventory-accuracy lane (pack REV-2 T4): link this line to a receiving
  // header, or `null` to unlink it. PATCH-only — a box is logged first and
  // attributed to a shipment afterwards. Absent = untouched; `null` = clear.
  // The state matrix (item RECEIVED, both shipments OPEN) is enforced at the
  // route, not here.
  shipmentId: z.string().min(1).max(30).nullable().optional(),
});

/**
 * The audited override (pack REV-3 T2), shared by both `mode` branches.
 *
 * BOTH-OR-NEITHER, enforced post-parse by `assertGraduateOverridePair` rather
 * than by `.refine`: the house rule keeps every request schema a plain
 * ZodObject (the MCP adapter reads `.shape`), and a discriminated union cannot
 * carry a cross-field refinement on its members anyway.
 *
 * A quantity without a reason is exactly the silent-divergence this lane
 * exists to end, so the reason is not optional COPY — it is the price of
 * booking a number the dock did not produce. The 1,000,000 ceiling mirrors the
 * house bound the count endpoint uses.
 */
const GRADUATE_OVERRIDE_FIELDS = {
  overrideQuantity: z.number().int().min(1).max(1_000_000).optional(),
  overrideReason: z.string().min(1).max(500).optional(),
};

export const GraduateSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('existing'),
    productId: z.number().int().positive(),
    locationId: z.number().int().positive(),
    ...GRADUATE_OVERRIDE_FIELDS,
  }),
  z.object({
    mode: z.literal('new'),
    productFields: ProductCreateUISchema,
    locationId: z.number().int().positive(),
    ...GRADUATE_OVERRIDE_FIELDS,
  }),
]);

/**
 * The count endpoint's whole request (pack REV-3 T2, W1-2b).
 *
 * ZERO IS LEGAL: "the box was empty" is a fact about the dock, and refusing to
 * record it would push the user back to guessing. The >= 1 rule belongs to
 * GRADUATION ("a zero count is a Discard, not a stock-in") and lives there.
 */
export const CountStagingSchema = z.object({
  countedQuantity: z.number().int().min(0).max(1_000_000),
});

export type CreateStagingInput = z.infer<typeof CreateStagingSchema>;
export type PatchStagingInput = z.infer<typeof PatchStagingSchema>;
export type GraduateInput = z.infer<typeof GraduateSchema>;
export type CountStagingInput = z.infer<typeof CountStagingSchema>;

/**
 * Refuse a PATCH body that still carries `countedQuantity` (pack REV-3 T2).
 *
 * Runs on the RAW body, BEFORE PatchStagingSchema.parse — Zod strips unknown
 * keys, so without this the field would vanish silently and the caller would
 * believe a count was recorded. House idiom: a post/pre-parse `assert*` helper
 * that throws a ZodError (-> apiHandler 400), so the schema itself stays a
 * plain ZodObject.
 */
export function assertStagingPatchOmitsCount(raw: unknown): void {
  if (raw !== null && typeof raw === 'object' && 'countedQuantity' in raw) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ['countedQuantity'],
        message:
          'countedQuantity is not editable here — count the item via POST /api/staging-items/[id]/count',
      },
    ]);
  }
}

/**
 * Refuse a GRADUATE body that still carries `countedQuantity` (pack REV-3 T2).
 *
 * THE COUNT-46-BOOK-50 GUARD. The old contract let the request name the booked
 * quantity, and the dialog filled that field from the EXPECTED quantity — so an
 * operator who counted 46 and pressed Confirm booked 50, with an audit line that
 * agreed with the request. Zod alone would strip the key silently; a caller that
 * believes it just booked its own number deserves an error, not a surprise.
 *
 * Runs on the RAW body, BEFORE GraduateSchema.parse. Same shape as
 * `assertStagingPatchOmitsCount` — the KEY is the tell, so a `countedQuantity`
 * of null or undefined is refused too.
 */
export function assertGraduateOmitsCount(raw: unknown): void {
  if (raw !== null && typeof raw === 'object' && 'countedQuantity' in raw) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ['countedQuantity'],
        message:
          'countedQuantity is not accepted here — graduation books the count on the staging row; count the item via POST /api/staging-items/[id]/count',
      },
    ]);
  }
}

/**
 * Enforce the override pair's both-or-neither rule (pack REV-3 T2).
 *
 * Runs POST-parse (it reads validated values). The issue is addressed to the
 * MISSING half, so the client can highlight the field it actually forgot.
 */
export function assertGraduateOverridePair(input: GraduateInput): void {
  const hasQuantity = input.overrideQuantity !== undefined;
  const hasReason = input.overrideReason !== undefined;
  if (hasQuantity === hasReason) return;

  throw new z.ZodError([
    {
      code: z.ZodIssueCode.custom,
      path: [hasQuantity ? 'overrideReason' : 'overrideQuantity'],
      message: hasQuantity
        ? 'overrideReason is required when overrideQuantity is set — booking a quantity the dock did not produce has to be explained'
        : 'overrideQuantity is required when overrideReason is set',
    },
  ]);
}
