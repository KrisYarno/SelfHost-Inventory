import { z } from 'zod';

const positiveInt = z.number().int().positive();

export const WorkbenchItemSchema = z.object({
  productId: positiveInt,
  quantity: z.number().int().positive(),
});

export const DeductInventorySchema = z.object({
  orderReference: z.string().trim().min(1, 'Order reference is required').max(255),
  items: z.array(WorkbenchItemSchema).min(1, 'At least one item is required'),
  notes: z.string().trim().max(1000).optional(),
});

export const SimpleDeductSchema = z.object({
  locationId: positiveInt,
  items: z.array(WorkbenchItemSchema).min(1, 'At least one item is required'),
  orderReference: z.string().trim().max(255).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export type DeductInventoryInput = z.infer<typeof DeductInventorySchema>;
export type SimpleDeductInput = z.infer<typeof SimpleDeductSchema>;
