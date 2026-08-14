import { z } from 'zod';
import { WORKBENCH_INTENTS } from '@/lib/inventory/intent';

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
