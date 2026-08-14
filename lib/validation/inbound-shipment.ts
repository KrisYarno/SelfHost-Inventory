import { z } from 'zod';
import { InboundShipmentStatus } from '@prisma/client';

/**
 * Zod schemas for the receiving header (contract pack REV-2 T4, W1-2a).
 *
 * - CreateInboundShipmentSchema: POST /api/inbound-shipments.
 * - PatchInboundShipmentSchema:  PATCH /api/inbound-shipments/[id] — field
 *     edits (notes / supplierRef, legal only while OPEN) and the two status
 *     transitions of the T4 state matrix.
 * - AllocateShipmentCostsSchema: POST /api/inbound-shipments/[id]/costs — a
 *     WHOLE freight bill, written atomically (FD3-1).
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

/**
 * ONE FREIGHT BILL (FD3-1, fix round 4; basis widened by FD4-1, fix round 6).
 *
 * The freight calculator used to fan its Accept out into one staging PATCH per
 * line. Three review rounds of partial-commit hazards later, the fan-out itself
 * was adjudicated the defect: a bill that lands on some lines and not others
 * leaves the operator with a recovery ("re-enter the full freight") that
 * DOUBLE-APPLIES it onto the bases that already absorbed a share. So a bill is
 * one request and one transaction, and this is its shape.
 *
 * A BILL IS ITS WHOLE BASIS (FD4-1). The split is computed from every line's
 * cost AND quantity — including the lines it decides not to write — so a request
 * carrying only the writes hands the server most of its premise unchecked. Two
 * live holes came from that: an excluded line (a no-op, a withheld inexact
 * split, an unpriced line) could be repriced after the last render with nothing
 * to notice, and no line carried a quantity precondition at all, so a recount
 * landing mid-Accept let per-unit costs computed over the old units be written
 * over the new ones. Every line of the frozen session therefore travels, and
 * what a line MEANS is read off its shape:
 *
 *   `id`               the staging line;
 *   `qtySource`+`qty`  the quantity the share was divided by, and where that
 *                      number came from — the server builds a different WHERE
 *                      for each source, because "still 10 counted" and "still
 *                      uncounted, still expecting 10" are different questions;
 *   `ifUnitCostCents`  the cost the row must STILL hold. `null` is legal and
 *                      means "only if it is still unpriced" — the same
 *                      unknown-is-not-zero distinction the column itself keeps;
 *   `unitCostCents`    PRESENT: write this landed cost. Never null — un-pricing
 *                      a line is the manual per-line save's job, not a bill's.
 *                      ABSENT: the line is VERIFY-ONLY — claimed and checked as
 *                      part of the basis, never written.
 *
 * The array is non-empty because a write request that writes nothing is a client
 * bug, not a 200. Uniqueness of the ids and "at least one write line" are
 * CROSS-LINE rules, so they live in the post-parse `assert*` helpers below
 * (house rule: request schemas stay plain ZodObjects — the MCP adapter reads
 * `.shape` — and never carry `.refine`).
 */
export const AllocateShipmentCostsSchema = z.object({
  lines: z
    .array(
      z.object({
        id: z.number().int().positive(),
        qtySource: z.enum(['counted', 'expected', 'none']),
        qty: z.number().int().min(0),
        ifUnitCostCents: z.number().int().min(0).max(100_000_000).nullable(),
        unitCostCents: z.number().int().min(0).max(100_000_000).optional(),
      }),
    )
    .min(1),
});

/** The `?status=` list filter. Absent = every status. */
export const ShipmentStatusFilterSchema = z.enum([
  InboundShipmentStatus.OPEN,
  InboundShipmentStatus.CLOSED,
  InboundShipmentStatus.CANCELLED,
]);

export type CreateInboundShipmentInput = z.infer<typeof CreateInboundShipmentSchema>;
export type PatchInboundShipmentInput = z.infer<typeof PatchInboundShipmentSchema>;
export type AllocateShipmentCostsInput = z.infer<typeof AllocateShipmentCostsSchema>;

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
 * One line, one answer (FD3-1).
 *
 * The batch claims ascending by id and each line's claim is guarded on the basis
 * the row must still hold, so a repeated id would be two claims whose order
 * decides the outcome — the second guarded on a value the first just replaced.
 * (A write line repeated as a verify-only one is the same trap wearing a hat.)
 * There is no reading of that request worth guessing at: refuse it.
 *
 * Post-parse `assert*` helper (house rule), naming the repeated line so the
 * client can point at it.
 */
export function assertAllocationLineIdsUnique(body: AllocateShipmentCostsInput): void {
  const seen = new Set<number>();
  for (const line of body.lines) {
    if (seen.has(line.id)) {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: ['lines'],
          message: `line ${line.id} appears twice in this bill — every line takes exactly one cost`,
        },
      ]);
    }
    seen.add(line.id);
  }
}

/**
 * A BILL WRITES SOMETHING (FD4-1).
 *
 * Every line of the frozen session travels now, so "the request has lines" no
 * longer means "the request writes". A payload of pure basis is a verification
 * request, and this route does not offer one: it would spend a transaction
 * taking a row lock per line to check numbers nobody is about to use, and it
 * would silently 200 a bill the panel thought it had written.
 *
 * The panel keeps the same promise on its own side (QA-12 disables Accept when
 * every writable line would restate what is already stored); this is the
 * server's version of it, which is the one that holds against a stale client.
 */
export function assertAllocationHasWriteLine(body: AllocateShipmentCostsInput): void {
  if (body.lines.some((line) => line.unitCostCents !== undefined)) return;
  throw new z.ZodError([
    {
      code: z.ZodIssueCode.custom,
      path: ['lines'],
      message:
        'this bill writes nothing — at least one line must carry a unitCostCents to write',
    },
  ]);
}

/**
 * Parse the list filter. Reader-tolerant validation is NOT wanted here (Lane 3
 * R-L7): a typo'd status must be a clean 400 rather than a silent "everything".
 */
export function parseShipmentStatusFilter(raw: string | null): InboundShipmentStatus | undefined {
  if (raw === null || raw === '') return undefined;
  return ShipmentStatusFilterSchema.parse(raw);
}
