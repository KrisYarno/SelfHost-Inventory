import { z } from 'zod';
import { MAX_FULFILLMENT_ITEMS, capMessage } from '@/lib/inventory/request-limits';

/**
 * Reconciliation Part 2 (G2s-3): bounded to INT32, not merely positive. Every id
 * this schema carries lands in an INT column (`Product.id`, `Location.id`), and
 * an out-of-range override throws out of Prisma BEFORE the fulfil path's own
 * product/location guards can refuse it — a 500 for a 400-class input. Refused
 * here it is an ordinary ZodError through the existing ladder.
 */
const positiveInt = z.number().int().positive().max(2147483647);

/**
 * Schema for a single fulfillment item
 */
export const FulfillmentItemSchema = z.object({
  itemId: z.string().min(1, 'Item ID is required'),
  quantity: z.number().int().positive('Quantity must be positive'),
  productId: positiveInt.optional(), // Manual override for unmapped items
  skipUnmapped: z.boolean().optional(),
});

/**
 * Schema for fulfillment request
 */
export const FulfillmentRequestSchema = z.object({
  locationId: positiveInt,
  // Reconciliation Part 2 (pack CB1b.5): the request-size maximum — see the
  // note on SimpleDeductSchema.items. The simple path prelocks one key per
  // fulfillable item; the bound keeps that inside the prelock's backstop.
  items: z
    .array(FulfillmentItemSchema)
    .min(1, 'At least one item is required')
    .max(MAX_FULFILLMENT_ITEMS, capMessage(MAX_FULFILLMENT_ITEMS, 'items')),
  notes: z.string().trim().max(1000).optional(),
});

/**
 * Type exports
 */
export type FulfillmentItem = z.infer<typeof FulfillmentItemSchema>;
export type FulfillmentRequest = z.infer<typeof FulfillmentRequestSchema>;
