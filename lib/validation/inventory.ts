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

// Admin bulk mass-update (POST /api/admin/inventory/mass-update).
// Envelope-level validation only: the handler intentionally performs per-item
// business validation (negative / non-integer quantity, missing product/location)
// and reports each as a structured, per-row failure rather than rejecting the
// whole batch — so `newQuantity` is left unconstrained here (any number) and the
// handler recomputes the truthful delta itself. Shape mirrors MassUpdateChange
// in types/mass-update-errors.ts.
export const MassUpdateChangeSchema = z.object({
  productId: positiveInt,
  locationId: positiveInt,
  newQuantity: z.number(),
  delta: z.number(),
  productName: z.string().optional(),
  locationName: z.string().optional(),
});

export const MassUpdateSchema = z.object({
  changes: z.array(MassUpdateChangeSchema).min(1, 'No changes provided'),
  note: z.string().optional(),
  isRetry: z.boolean().optional(),
  allowPartial: z.boolean().optional(),
});

export type InventoryAdjustmentInput = z.infer<typeof InventoryAdjustmentSchema>;
export type BatchInventoryAdjustmentInput = z.infer<typeof BatchInventoryAdjustmentSchema>;
export type StockInInput = z.infer<typeof StockInSchema>;
export type TransferInput = z.infer<typeof TransferSchema>;
export type BatchTransferInput = z.infer<typeof BatchTransferSchema>;
export type MassUpdateChangeInput = z.infer<typeof MassUpdateChangeSchema>;
export type MassUpdateInput = z.infer<typeof MassUpdateSchema>;
