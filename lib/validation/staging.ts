import { z } from 'zod';
import { ProductCreateUISchema } from '@/lib/validation/product';

/**
 * Zod schemas for the pre-staging intake flow.
 *
 * - CreateStagingSchema: POST /api/staging-items (log a box).
 * - PatchStagingSchema:  PATCH /api/staging-items/[id] (label / count / edit).
 *     `countedQuantity` is tentative here (>= 0 allowed); the >= 1 rule is only
 *     enforced at graduation, per the spec (API surface / error-handling table).
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
  // tentative; >= 1 enforced only at graduate
  countedQuantity: z.number().int().min(0).max(1_000_000).optional(),
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

export type CreateStagingInput = z.infer<typeof CreateStagingSchema>;
export type PatchStagingInput = z.infer<typeof PatchStagingSchema>;
export type GraduateInput = z.infer<typeof GraduateSchema>;
