import { z } from 'zod';

/**
 * Schema for a single unfulfillment item
 */
export const UnfulfillItemSchema = z.object({
  itemId: z.string().min(1, 'Item ID is required'),
  productId: z.number().int().positive('Product ID must be a positive integer'),
  quantity: z.number().int().positive('Quantity must be positive'),
  locationId: z.number().int().positive('Location ID must be a positive integer'),
});

/**
 * Schema for unfulfillment request
 */
export const UnfulfillRequestSchema = z.object({
  items: z.array(UnfulfillItemSchema).min(1, 'At least one item is required'),
  notes: z.string().trim().max(1000).optional(),
});

/**
 * Type exports
 */
export type UnfulfillItem = z.infer<typeof UnfulfillItemSchema>;
export type UnfulfillRequest = z.infer<typeof UnfulfillRequestSchema>;
