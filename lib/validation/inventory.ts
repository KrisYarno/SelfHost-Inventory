import { z } from 'zod';
import { inventory_logs_logType } from '@prisma/client';
import { ADJUST_REQUEST_INTENTS, type DeductionIntent } from '@/lib/inventory/intent';
import {
  MAX_BATCH_ADJUST_ITEMS,
  MAX_BATCH_TRANSFERS,
  capMessage,
} from '@/lib/inventory/request-limits';
import { BatchIdParamSchema } from '@/lib/validation/batches';
import { refuse } from '@/lib/validation/refuse';

const positiveInt = z.number().int().positive();

/**
 * The adjust ROUTE's intent vocabulary (reconciliation Part 2, pack CB3a-i.2):
 * the chip's three values (W2-1, pack REV-11 T7) plus the two request-only
 * intents `count` and `correction` — lib/inventory/intent.ts
 * `ADJUST_REQUEST_INTENTS`, so the wire cannot drift from that module. Its one
 * consumer is AdjustWithIntentSchema below; the workbench's schema reads
 * WORKBENCH_INTENTS. Accepting `count` / `correction` HERE means only that they
 * parse: `parseAdjustShape` runs their rows of the truth table and the route
 * then refuses them as not available yet. `recount` / `receiving` are NOT here
 * and never were — see that module.
 */
export const AdjustRequestIntentSchema = z.enum(ADJUST_REQUEST_INTENTS);

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
 *
 * `autoAddForTransfer` is PARSED here (CR-3). It used to be read straight off
 * the raw JSON, outside zod — an unvalidated, client-controlled flag on a
 * stock-writing route whose effects are an alternate audit actionType AND the
 * suppression of the live attribution attempt. The route enforces its one
 * cross-field rule (an auto-add is an ADD, so `delta > 0`) as an ordinary 400,
 * because a `.refine` at the object level would hide `.shape` from the MCP
 * adapter (house rule 1).
 *
 * Reconciliation Part 2 (pack CB3a-i.2): `delta` is OPTIONAL here — a count
 * sends a counted quantity, not a delta — and the non-zero refine survives on
 * the optional, so `delta: 0` still meets 'Delta must not be zero'. WHETHER a
 * field may or must be present is decided per request kind by
 * `parseAdjustShape` below, never here. BatchInventoryAdjustmentSchema reuses
 * the base schema, where `delta` stays required.
 */
export const AdjustWithIntentSchema = InventoryAdjustmentSchema.extend({
  delta: InventoryAdjustmentSchema.shape.delta.optional(),
  intent: AdjustRequestIntentSchema.optional(),
  selectedExternalOrderId: selectedExternalOrderId.optional(),
  // The order number an operator TYPED (the reference field). Free text until
  // the route's resolver decides whether it names exactly one order.
  orderReference: z.string().trim().min(1).max(40).optional(),
  countedQuantity: z.number().int().min(0).optional(),
  // A ledger batch id: the reverse/move routes' own guard, never re-spelled.
  reversesBatchId: BatchIdParamSchema.optional(),
  autoAddForTransfer: z.boolean().optional(),
});

/**
 * The adjust request truth table's FROZEN sentences (pack CB3a-i.2 + the
 * P2-B3-1 deltas). One owner: this file. Each is the whole 400 an operator or
 * an API caller reads, so a change to one is a wire change.
 */
export const ADJUST_SHAPE_SENTENCES = Object.freeze({
  countCarriesNoDelta: 'a count carries no delta — send countedQuantity',
  countNeedsQuantity: 'a count needs the counted quantity',
  countNeedsVersion: 'a count needs the row version it was read at',
  countReversesNothing: 'a count reverses nothing',
  countNotAttributed: 'a count is not attributed',
  countNotATransfer: 'a count is not a transfer',
  correctionNeedsUnits: 'a correction needs the units to put back',
  correctionDownwardIsCount: 'a downward fix is a count',
  correctionNotACount: 'a correction is not a count',
  correctionCarriesNoVersion: 'a correction carries no version — the batch lock is its guard',
  correctionAttributedByBatch: 'a correction is attributed by its batch, not a reference',
  correctionNotATransfer: 'a correction is not a transfer',
  deltaNeedsUnits: 'an adjustment needs the units to add or remove',
  deltaNoCountedQuantity: 'only a count carries a counted quantity',
  deltaNoReversal: 'only a correction reverses a batch',
  referenceNeedsOrderIntent: 'a reference needs the order intent',
  referenceOrPickNotBoth: 'pick the order or type the reference, not both',
  referenceOnlyForStockOut:
    'a reference attributes stock that left — put stock back with a correction',
} as const);

/**
 * What one adjust request IS, once its kind is known (seam S-B8). `kind` is a
 * SERVER-side derivation from `intent` — it never rides the wire (zod would
 * strip it). The optional keys are ABSENT when the request did not send them,
 * never `undefined`-valued.
 */
export type AdjustShape =
  | {
      kind: 'count';
      productId: number;
      locationId: number;
      countedQuantity: number;
      expectedVersion: number;
      reason?: string;
      notes?: string;
    }
  | {
      kind: 'correction';
      productId: number;
      locationId: number;
      delta: number;
      reversesBatchId?: string;
      reason?: string;
      notes?: string;
    }
  | {
      kind: 'delta';
      productId: number;
      locationId: number;
      delta: number;
      intent?: DeductionIntent;
      selectedExternalOrderId?: string;
      orderReference?: string;
      autoAddForTransfer?: boolean;
      reason?: string;
      notes?: string;
      expectedVersion?: number;
    };

/**
 * THE ADJUST REQUEST TRUTH TABLE, executable (pack CB3a-i.2; TOTAL).
 *
 * A post-parse PARSER, never a `.refine` (house rule 1: the MCP adapter reads
 * `.shape`). It runs on AdjustWithIntentSchema's OUTPUT, so "present" means
 * DEFINED on the parsed object: unknown keys are already stripped, and an
 * explicit `null` has already met zod's own message. Each broken cell is one
 * 400 through `refuse` — the field's path and the cell's frozen sentence.
 *
 * The kind comes from `intent`: `count` -> count, `correction` -> correction,
 * anything else (`order` / `damage-loss` / `other` / absent) -> delta.
 *
 * ONE BODY, SEVERAL BROKEN CELLS: the cells are checked in the table's column
 * order, left to right — delta, countedQuantity, expectedVersion,
 * reversesBatchId, orderReference, selectedExternalOrderId,
 * autoAddForTransfer — so the leftmost broken column's sentence is the one the
 * caller reads. Inside the delta row's orderReference cell the three rules run
 * in the order the table states them: the order intent, then id-and-reference,
 * then a positive delta.
 *
 * Two cells are enforced elsewhere, by design: a delta row's
 * `autoAddForTransfer: true` with `delta < 0` is the route's own 400 (CR-3),
 * which runs right after this parse; and `logType` is ignored in every row
 * (the schema pins its literal, the writer decides what is written).
 */
export function parseAdjustShape(body: AdjustWithIntentInput): AdjustShape {
  const S = ADJUST_SHAPE_SENTENCES;
  const {
    productId,
    locationId,
    intent,
    delta,
    countedQuantity,
    expectedVersion,
    reversesBatchId,
    orderReference,
    selectedExternalOrderId,
    autoAddForTransfer,
  } = body;
  // reason / notes are optional in every row and carried when present.
  const words = {
    ...(body.reason !== undefined ? { reason: body.reason } : {}),
    ...(body.notes !== undefined ? { notes: body.notes } : {}),
  };

  if (intent === 'count') {
    if (delta !== undefined) refuse(['delta'], S.countCarriesNoDelta);
    if (countedQuantity === undefined) refuse(['countedQuantity'], S.countNeedsQuantity);
    if (expectedVersion === undefined) refuse(['expectedVersion'], S.countNeedsVersion);
    if (reversesBatchId !== undefined) refuse(['reversesBatchId'], S.countReversesNothing);
    if (orderReference !== undefined) refuse(['orderReference'], S.countNotAttributed);
    if (selectedExternalOrderId !== undefined) {
      refuse(['selectedExternalOrderId'], S.countNotAttributed);
    }
    if (autoAddForTransfer === true) refuse(['autoAddForTransfer'], S.countNotATransfer);
    return { kind: 'count', productId, locationId, countedQuantity, expectedVersion, ...words };
  }

  if (intent === 'correction') {
    if (delta === undefined) refuse(['delta'], S.correctionNeedsUnits);
    // `delta: 0` never reaches here: the base refine refuses it first.
    if (delta <= 0) refuse(['delta'], S.correctionDownwardIsCount);
    if (countedQuantity !== undefined) refuse(['countedQuantity'], S.correctionNotACount);
    if (expectedVersion !== undefined) refuse(['expectedVersion'], S.correctionCarriesNoVersion);
    if (orderReference !== undefined) refuse(['orderReference'], S.correctionAttributedByBatch);
    if (selectedExternalOrderId !== undefined) {
      refuse(['selectedExternalOrderId'], S.correctionAttributedByBatch);
    }
    if (autoAddForTransfer === true) refuse(['autoAddForTransfer'], S.correctionNotATransfer);
    return {
      kind: 'correction',
      productId,
      locationId,
      delta,
      ...(reversesBatchId !== undefined ? { reversesBatchId } : {}),
      ...words,
    };
  }

  if (delta === undefined) refuse(['delta'], S.deltaNeedsUnits);
  if (countedQuantity !== undefined) refuse(['countedQuantity'], S.deltaNoCountedQuantity);
  if (reversesBatchId !== undefined) refuse(['reversesBatchId'], S.deltaNoReversal);
  if (orderReference !== undefined) {
    if (intent !== 'order') refuse(['orderReference'], S.referenceNeedsOrderIntent);
    if (selectedExternalOrderId !== undefined) {
      refuse(['orderReference'], S.referenceOrPickNotBoth);
    }
    if (delta > 0) refuse(['orderReference'], S.referenceOnlyForStockOut);
  }
  // A `selectedExternalOrderId` on a POSITIVE `order` delta is accepted and
  // still stamps, as it did before this table existed — no UI sends one (the
  // residual, stated in pack § P2-B3-1).
  return {
    kind: 'delta',
    productId,
    locationId,
    delta,
    ...(intent !== undefined ? { intent } : {}),
    ...(selectedExternalOrderId !== undefined ? { selectedExternalOrderId } : {}),
    ...(orderReference !== undefined ? { orderReference } : {}),
    ...(autoAddForTransfer !== undefined ? { autoAddForTransfer } : {}),
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    ...words,
  };
}

export const BatchInventoryAdjustmentSchema = z.object({
  // Reconciliation Part 2 (pack CB1b.5): the request-size maximum. The journal
  // sends one adjustment per counted product and the route prelocks all of them
  // in one statement; past the prelock's own cap that would be a bare 500, so
  // the request is bounded here instead.
  adjustments: z
    .array(InventoryAdjustmentSchema)
    .min(1, 'At least one adjustment is required')
    .max(MAX_BATCH_ADJUST_ITEMS, capMessage(MAX_BATCH_ADJUST_ITEMS, 'items')),
  type: z.string().trim().optional(),
});

export const StockInSchema = z.object({
  productId: positiveInt,
  locationId: positiveInt,
  quantity: z.number().int().positive(),
  // Reconciliation Part 2 (pack § P2-B3-1R, R-a.4): the dialog's one optional
  // Note, persisted on the audit event as `details.notes` (the adjust route's
  // key and bound) and shown in the product's history to admins and its author.
  notes: z.string().trim().max(2000).optional(),
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
    .min(1, "At least one transfer is required")
    // QB-9: the one covered-writer feeding schema that had no request-size
    // maximum — and this route runs one full transaction PER transfer.
    .max(MAX_BATCH_TRANSFERS, capMessage(MAX_BATCH_TRANSFERS, "transfers")),
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
