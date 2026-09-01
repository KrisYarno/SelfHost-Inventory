/**
 * lib/inventory/request-limits.ts — THE ONE OWNER OF EVERY REQUEST CAP
 * (reconciliation Part 2, pack CB1.5a-i.6, seam S-B10).
 *
 * Five schemas cap their item arrays at the same number for the same reason:
 * every entry becomes a prelocked `product_locations` key, and the prelock's own
 * cap is a LIB BACKSTOP whose RangeError would reach the wire as a bare 500. The
 * number was spelled five times, and the two dialogs that count against it would
 * have been the sixth and seventh — so it lives here instead, once, beside the
 * message that renders it.
 *
 * A PURE module by contract (no zod, no React, no Next, no Prisma — the
 * `lib/inventory/intent.ts` precedent): the schemas import it server-side and the
 * dialogs import it in the browser, and neither pulls anything else in with it.
 */

/** `FulfillmentRequestSchema.items` (lib/validation/fulfillment.ts). */
export const MAX_FULFILLMENT_ITEMS = 100;

/** `UnfulfillRequestSchema.items` (lib/validation/unfulfill.ts). */
export const MAX_UNFULFILL_ITEMS = 100;

/** `SimpleDeductSchema.items` (lib/validation/workbench.ts). */
export const MAX_SIMPLE_DEDUCT_ITEMS = 100;

/** `BatchInventoryAdjustmentSchema.adjustments` (lib/validation/inventory.ts). */
export const MAX_BATCH_ADJUST_ITEMS = 100;

/** `BatchTransferSchema.transfers` (lib/validation/inventory.ts). */
export const MAX_BATCH_TRANSFERS = 100;

/**
 * The cap counters become visible from here on — before the cap, not at it (the
 * journal's idiom, `hooks/use-journal.ts`): an operator who learns about the
 * bound only from a 400 has already spent the work.
 */
export const CAP_COUNTER_FROM = 80;

/** The wire text every capped schema renders. */
export const capMessage = (max: number, noun: string) =>
  `at most ${max} ${noun} per request`;
