import { z } from 'zod';
import { inventory_logs_logType } from '@prisma/client';
import { DEDUCTION_INTENTS } from '@/lib/inventory/intent';

const positiveInt = z.number().int().positive();

/**
 * W2-1 (pack REV-11 T7): the intent chip's closed vocabulary, shared by both
 * surfaces' request schemas so neither can drift from lib/inventory/intent.ts.
 * `recount` / `receiving` are NOT here and never were — see that module.
 */
export const DeductionIntentSchema = z.enum(DEDUCTION_INTENTS);

/**
 * An external order id, bounded by external_orders.id's native shape
 * (String @id @default(cuid()) => VarChar(191)). The SCHEMA only bounds it — the
 * ROUTE resolves it through lib/orders/resolve-selected-order.ts and enforces
 * company membership before anything is written, because a client-supplied id is
 * not evidence of anything on its own.
 */
export const selectedExternalOrderId = z.string().trim().min(1).max(191);

// Phase C (P-C5): closed set of coded adjustment reasons. Kept alongside the
// free-text reason so the ledger row carries a machine-filterable reasonCode while
// the audit event keeps the operator's own words.
export const REASON_CODES = ['COUNT', 'DAMAGE', 'THEFT', 'EXPIRY', 'CORRECTION'] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const InventoryAdjustmentSchema = z.object({
  productId: positiveInt,
  locationId: positiveInt,
  delta: z
    .number()
    .int()
    .refine((value) => value !== 0, { message: 'Delta must not be zero' }),
  // Phase C (P-C2): logType is PINNED to ADJUSTMENT here (and, by reuse, in
  // BatchInventoryAdjustmentSchema below). SALE / STOCK_IN / CORRECTION are set
  // server-side only, so a client cannot forge a flow logType through the public
  // adjust / batch-adjust API.
  logType: z.literal(inventory_logs_logType.ADJUSTMENT).optional(),
  expectedVersion: z.number().int().min(0).optional(),
  // Phase C (P-C5): optional coded reason + the free-text reason / notes that
  // finally persist (the audit event previously stripped them). reason / notes are
  // OPTIONAL server-side — transfer auto-add, workbench undo, and journal all POST
  // here without them; quick-adjust keeps its own client-side required gate on the
  // free-text reason.
  reasonCode: z.enum(REASON_CODES).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
  notes: z.string().trim().max(2000).optional(),
});

/**
 * W2-1 (pack REV-11 T7): what POST /api/inventory/adjust parses — the shared
 * adjustment shape PLUS the intent chip and the order id the chip's `order`
 * value resolves against.
 *
 * A SEPARATE schema rather than fields on InventoryAdjustmentSchema, because
 * that schema is also the item shape for batch-adjust (the journal), and zod
 * strips unknown keys: an `intent` sent to batch-adjust would be silently
 * dropped, which is precisely the kind of quiet no-op the truthful-data rule
 * exists to prevent. The journal's route does not implement the chip, so its
 * schema does not advertise it.
 *
 * `reasonCode` is still INHERITED here and that is deliberate: the adjust route
 * REFUSES it explicitly (400) before parsing, so the refusal is a stated
 * outcome rather than zod's silent strip. Pinned at the route, per the pack.
 */
export const AdjustWithIntentSchema = InventoryAdjustmentSchema.extend({
  intent: DeductionIntentSchema.optional(),
  selectedExternalOrderId: selectedExternalOrderId.optional(),
});

export const BatchInventoryAdjustmentSchema = z.object({
  adjustments: z.array(InventoryAdjustmentSchema).min(1, 'At least one adjustment is required'),
  type: z.string().trim().optional(),
});

export const StockInSchema = z.object({
  productId: positiveInt,
  locationId: positiveInt,
  quantity: z.number().int().positive(),
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
export type AdjustWithIntentInput = z.infer<typeof AdjustWithIntentSchema>;
export type BatchInventoryAdjustmentInput = z.infer<typeof BatchInventoryAdjustmentSchema>;
export type StockInInput = z.infer<typeof StockInSchema>;
export type TransferInput = z.infer<typeof TransferSchema>;
export type BatchTransferInput = z.infer<typeof BatchTransferSchema>;
export type MassUpdateChangeInput = z.infer<typeof MassUpdateChangeSchema>;
export type MassUpdateInput = z.infer<typeof MassUpdateSchema>;
