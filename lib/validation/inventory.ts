import { z } from 'zod';
import { inventory_logs_logType } from '@prisma/client';

const positiveInt = z.number().int().positive();

export const InventoryAdjustmentSchema = z.object({
  productId: positiveInt,
  locationId: positiveInt,
  delta: z
    .number()
    .int()
    .refine((value) => value !== 0, { message: 'Delta must not be zero' }),
  logType: z.nativeEnum(inventory_logs_logType).optional(),
  expectedVersion: z.number().int().min(0).optional(),
});

export const BatchInventoryAdjustmentSchema = z.object({
  adjustments: z.array(InventoryAdjustmentSchema).min(1, 'At least one adjustment is required'),
  type: z.string().trim().optional(),
});

export const StockInSchema = z.object({
  productId: positiveInt,
  locationId: positiveInt,
  quantity: z.number().int().positive(),
  logType: z.nativeEnum(inventory_logs_logType).optional(),
});

export type InventoryAdjustmentInput = z.infer<typeof InventoryAdjustmentSchema>;
export type BatchInventoryAdjustmentInput = z.infer<typeof BatchInventoryAdjustmentSchema>;
export type StockInInput = z.infer<typeof StockInSchema>;
