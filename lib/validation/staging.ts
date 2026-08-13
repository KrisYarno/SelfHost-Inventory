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
 *     `countedQuantity` must be >= 1 at graduation.
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

export const GraduateSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('existing'),
    productId: z.number().int().positive(),
    countedQuantity: z.number().int().min(1).max(1_000_000),
    locationId: z.number().int().positive(),
  }),
  z.object({
    mode: z.literal('new'),
    productFields: ProductCreateUISchema,
    countedQuantity: z.number().int().min(1).max(1_000_000),
    locationId: z.number().int().positive(),
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
