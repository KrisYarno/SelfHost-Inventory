import { z } from 'zod';

const positiveInt = z.number().int().positive();

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
  items: z.array(FulfillmentItemSchema).min(1, 'At least one item is required'),
  notes: z.string().trim().max(1000).optional(),
});

/**
 * Type exports
 */
export type FulfillmentItem = z.infer<typeof FulfillmentItemSchema>;
export type FulfillmentRequest = z.infer<typeof FulfillmentRequestSchema>;
