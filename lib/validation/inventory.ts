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

// Transfer inventory between locations
export const TransferSchema = z
  .object({
    productId: positiveInt,
    fromLocationId: positiveInt,
    toLocationId: positiveInt,
    quantity: z.number().int().positive(),
    expectedFromVersion: z.number().int().min(0).optional(),
    expectedToVersion: z.number().int().min(0).optional(),
  })
  .refine((data) => data.fromLocationId !== data.toLocationId, {
    path: ['toLocationId'],
    message: 'Destination location must be different from source location',
  });

// Batch transfer for Stock In feature (multiple sources -> single destination)
export const BatchTransferSchema = z.object({
  productId: positiveInt,
  toLocationId: positiveInt,
  transfers: z
    .array(
      z.object({
        fromLocationId: positiveInt,
        quantity: z.number().int().positive(),
        expectedVersion: z.number().int().min(0).optional(),
      })
    )
    .min(1, "At least one transfer is required"),
});

export type InventoryAdjustmentInput = z.infer<typeof InventoryAdjustmentSchema>;
export type BatchInventoryAdjustmentInput = z.infer<typeof BatchInventoryAdjustmentSchema>;
export type StockInInput = z.infer<typeof StockInSchema>;
export type TransferInput = z.infer<typeof TransferSchema>;
export type BatchTransferInput = z.infer<typeof BatchTransferSchema>;
