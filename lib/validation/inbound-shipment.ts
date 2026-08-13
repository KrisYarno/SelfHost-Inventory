import { z } from 'zod';
import { InboundShipmentStatus } from '@prisma/client';

/**
 * Zod schemas for the receiving header (contract pack REV-2 T4, W1-2a).
 *
 * - CreateInboundShipmentSchema: POST /api/inbound-shipments.
 * - PatchInboundShipmentSchema:  PATCH /api/inbound-shipments/[id] — field
 *     edits (notes / supplierRef, legal only while OPEN) and the two status
 *     transitions of the T4 state matrix.
 *
 * House rule: plain `z.object` with no `.refine`; cross-field rules are
 * post-parse `assert*` helpers that throw a ZodError (-> apiHandler 400).
 *
 * `status: "OPEN"` is deliberately NOT accepted: the matrix has no reopen
 * transition, so asking for one is a malformed request (400), not a state
 * conflict (409).
 */

export const CreateInboundShipmentSchema = z.object({
  supplierRef: z.string().max(255).optional(),
  notes: z.string().max(5000).optional(),
});

export const PatchInboundShipmentSchema = z.object({
  supplierRef: z.string().max(255).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  status: z.enum([InboundShipmentStatus.CLOSED, InboundShipmentStatus.CANCELLED]).optional(),
});

/** The `?status=` list filter. Absent = every status. */
export const ShipmentStatusFilterSchema = z.enum([
  InboundShipmentStatus.OPEN,
  InboundShipmentStatus.CLOSED,
  InboundShipmentStatus.CANCELLED,
]);

export type CreateInboundShipmentInput = z.infer<typeof CreateInboundShipmentSchema>;
export type PatchInboundShipmentInput = z.infer<typeof PatchInboundShipmentSchema>;

/**
 * A PATCH that asks for nothing is a client bug, not a silent no-op write.
 * Enforced OUTSIDE the object schema so the schema stays a plain ZodObject.
 */
export function assertShipmentPatchNotEmpty(body: PatchInboundShipmentInput): void {
  if (
    body.supplierRef === undefined &&
    body.notes === undefined &&
    body.status === undefined
  ) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'provide at least one of supplierRef, notes or status',
      },
    ]);
  }
}

/**
 * Parse the list filter. Reader-tolerant validation is NOT wanted here (Lane 3
 * R-L7): a typo'd status must be a clean 400 rather than a silent "everything".
 */
export function parseShipmentStatusFilter(raw: string | null): InboundShipmentStatus | undefined {
  if (raw === null || raw === '') return undefined;
  return ShipmentStatusFilterSchema.parse(raw);
}
