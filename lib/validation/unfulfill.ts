import { z } from 'zod';
import { MAX_UNFULFILL_ITEMS, capMessage } from '@/lib/inventory/request-limits';

/** The INT32 ceiling every id column here sits under — see the fulfilment schema's note. */
const INT32_MAX = 2147483647;

/**
 * Schema for a single unfulfillment item
 */
export const UnfulfillItemSchema = z.object({
  itemId: z.string().min(1, 'Item ID is required'),
  productId: z.number().int().positive('Product ID must be a positive integer').max(INT32_MAX),
  quantity: z.number().int().positive('Quantity must be positive'),
  locationId: z.number().int().positive('Location ID must be a positive integer').max(INT32_MAX),
});

/**
 * Schema for unfulfillment request
 */
export const UnfulfillRequestSchema = z.object({
  // Reconciliation Part 2 (pack CB1b.5): the request-size maximum. A bundle
  // item restores one key per COMPONENT, so this bound alone does not keep the
  // prelock's key count under its cap — the route's own TOO_MANY_KEYS guard
  // covers the multiplication. Both refusals are 400s.
  items: z
    .array(UnfulfillItemSchema)
    .min(1, 'At least one item is required')
    .max(MAX_UNFULFILL_ITEMS, capMessage(MAX_UNFULFILL_ITEMS, 'items')),
  notes: z.string().trim().max(1000).optional(),
});

/**
 * Type exports
 */
export type UnfulfillItem = z.infer<typeof UnfulfillItemSchema>;
export type UnfulfillRequest = z.infer<typeof UnfulfillRequestSchema>;
