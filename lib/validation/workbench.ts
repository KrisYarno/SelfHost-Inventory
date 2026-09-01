import { z } from 'zod';
import { WORKBENCH_INTENTS } from '@/lib/inventory/intent';
import { MAX_SIMPLE_DEDUCT_ITEMS, capMessage } from '@/lib/inventory/request-limits';

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
  // Reconciliation Part 2 (pack CB1b.5): the request-size maximum. Every item
  // here becomes a prelocked `product_locations` key, and the prelock's own cap
  // is a LIB BACKSTOP whose RangeError would reach the wire as a bare 500. The
  // bound belongs on the request, where it is an ordinary 400.
  items: z
    .array(WorkbenchItemSchema)
    .min(1, 'At least one item is required')
    .max(MAX_SIMPLE_DEDUCT_ITEMS, capMessage(MAX_SIMPLE_DEDUCT_ITEMS, 'items')),
  orderReference: z.string().trim().max(255).optional(),
  notes: z.string().trim().max(1000).optional(),
  // Phase 0b-2 (spec REV-2 / OC-1): the external order the packer had selected,
  // accrued into the audit event's details so a manual deduction can later be
  // attributed to its order. Bounded by external_orders.id's native shape
  // (String @id @default(cuid()) => VarChar(191)). The SCHEMA only bounds it —
  // the route resolves it and enforces company membership before recording,
  // because a client-supplied id is not evidence of anything on its own.
  selectedExternalOrderId: z.string().trim().min(1).max(191).optional(),
  // W2-1 (pack REV-11 T7, [ADJ] per PLG1-1): the intent chip — TWO values on
  // this surface. `damage-loss` is absent from WORKBENCH_INTENTS by contract,
  // so a client that sends it is REFUSED here rather than silently downgraded:
  // this route books SALE rows, and a SALE carrying reasonCode DAMAGE would sit
  // outside getShrinkageSummary's ADJUSTMENT/CORRECTION domain forever — a loss
  // recorded where the loss report cannot see it.
  intent: z.enum(WORKBENCH_INTENTS).optional(),
});

export type DeductInventoryInput = z.infer<typeof DeductInventorySchema>;
export type SimpleDeductInput = z.infer<typeof SimpleDeductSchema>;
