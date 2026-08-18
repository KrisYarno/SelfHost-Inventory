import { z } from 'zod';
import { RESOLUTIONS } from '@/lib/exceptions/kinds';
import { ProductCreateUIShape } from '@/lib/validation/product';

/**
 * Zod schemas for the supply-order flow (contract pack C2a.4; spec §5).
 *
 * Supersedes `lib/validation/inbound-shipment.ts`, which M6 deletes with the
 * rest of the W1 write surface.
 *
 * THREE HOUSE RULES carry this file:
 *
 *   1. PLAIN `z.object`, ALWAYS. No `.refine`, no `.superRefine` at the object
 *      level — the MCP adapter reads `.shape` off request schemas, and a
 *      refinement turns a ZodObject into a ZodEffects with no `.shape` at all.
 *      Cross-field rules are post-parse `assert*` helpers that throw a ZodError,
 *      which `lib/api-utils` already renders as a 400.
 *   2. DATES ARE LEXICAL HERE. `orderedAt`/`from`/`to` are CALENDAR DAYS, not
 *      instants: the schema checks the SHAPE (`YYYY-MM-DD`) and the `assert*`
 *      helpers check that the day exists (`new Date('2026-02-30')` silently
 *      rolls over to Mar 2, which would store a date nobody typed). The server
 *      stores UTC midnight.
 *   3. COST NEVER TRAVELS FROM A LINE (premise 1). A product created while
 *      entering an order carries NO `costPrice` — the receipt's own unit cost is
 *      what prices it later, through the D-COST prompt. See PK-8 below.
 *
 * NULL vs UNDEFINED, everywhere in the PATCH schemas: `undefined` (absent) means
 * "leave it alone"; an explicit `null` means "erase it". The one exception is
 * `orderedAt`, which is never nullable — `orderedAt IS NULL` is the discriminator
 * that makes a header a LEGACY W1 receipt, so clearing it would silently move an
 * order into the other data model.
 */

// ---------------------------------------------------------------------------
// Shared field vocabulary
// ---------------------------------------------------------------------------

/**
 * Cents ceiling. The columns are MySQL INTs, and spec D4 states the exactness
 * contract up to 1e8 cents x 1e6 units — past that the money module makes no
 * promise and the driver, not this schema, would be the one to refuse. Mirrors
 * the bound `AllocateShipmentCostsSchema` already uses.
 */
const MAX_CENTS = 100_000_000;

/** Unit ceiling — the house bound the count endpoint and the override use. */
const MAX_UNITS = 1_000_000;

/** `inbound_shipments.id` is a cuid in a VarChar(30). */
const shipmentId = z.string().max(30);

/** A calendar day, checked LEXICALLY (rule 2 — reality is `assertRealCalendarDate`). */
const calendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be an ISO calendar day (YYYY-MM-DD)');

const noteText = z.string().max(500);

// ---------------------------------------------------------------------------
// PK-8 — the product create shape, MINUS costPrice
// ---------------------------------------------------------------------------

/**
 * `ProductCreateUIShape` minus `costPrice`, and minus NOTHING ELSE (PK2-3):
 * `locationId` and `reorderConfig` stay, because `resolveSupplyOrderProduct`
 * mirrors `POST /api/products` exactly and that route honours both.
 *
 * Built by DESTRUCTURING the live UI shape rather than by re-declaring the
 * fields, so the two never drift: a field added to product creation appears here
 * automatically, and only the deliberate omission is spelled out.
 */
const { costPrice: _costPrice, ...productCreateFromOrderShape } = ProductCreateUIShape;

export const ProductCreateFromOrderShape = productCreateFromOrderShape;

export const ProductCreateFromOrderSchema = z.object(ProductCreateFromOrderShape);

export type ProductCreateFromOrderInput = z.infer<typeof ProductCreateFromOrderSchema>;

/**
 * Name a product for a line: one that already exists, or one to create.
 *
 * NOT exported as a schema (only as a type): every EXPORTED schema in this
 * module is a plain ZodObject with a `.shape`, and a discriminated union is
 * neither — a pin in the unit suite holds that line.
 */
const ProductSelectorSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('existing'), productId: z.number().int().positive() }),
  z.object({ mode: z.literal('new'), productFields: ProductCreateFromOrderSchema }),
]);

export type ProductSelectorInput = z.infer<typeof ProductSelectorSchema>;

// ---------------------------------------------------------------------------
// Order entry
// ---------------------------------------------------------------------------

/**
 * ONE ordered line. `lineTotalCents` is the money ACTUALLY PAID for the line —
 * the exact figure, kept whole; the per-unit cost is derived from it and never
 * entered. 0 is legal and means free (`lineMoney` then reports a NULL unit cost
 * rather than a $0.00 valuation).
 *
 * `labelingRequired` defaults TRUE: the bench is the normal path, and a line
 * that skips it is the exception the operator opts into.
 */
export const LineInputSchema = z.object({
  product: ProductSelectorSchema,
  orderedQuantity: z.number().int().min(1).max(MAX_UNITS),
  lineTotalCents: z.number().int().min(0).max(MAX_CENTS),
  labelingRequired: z.boolean().default(true),
  notes: z.string().max(5000).optional(),
});

/**
 * A supply order is entered WHEN IT IS PLACED, so `orderedAt` is required — it
 * is both the business fact and the `model` discriminator (spec §5.4).
 *
 * `feesCents` DEFAULTS TO 0, not NULL: an order form that was submitted without
 * fees genuinely had none. NULL is reserved for "not recorded", which only the
 * PATCH can set (G1s-12).
 *
 * 1..50 lines: a header with no lines is not an order any more (the W1
 * header-only create is retired), and 50 is the practical ceiling for one
 * transaction's worth of product resolution.
 */
export const CreateSupplyOrderSchema = z.object({
  supplier: z.string().max(255).optional(),
  supplierRef: z.string().max(255).optional(),
  orderedAt: calendarDay,
  notes: z.string().max(5000).optional(),
  feesCents: z.number().int().min(0).max(MAX_CENTS).default(0),
  feesNote: z.string().max(255).optional(),
  lines: z.array(LineInputSchema).min(1).max(50),
});

/**
 * Header edits + the two lifecycle actions. The PATCH forks on the header's
 * MODEL (legacy -> 409) and then on its status, never on this body.
 */
export const PatchSupplyOrderSchema = z.object({
  supplier: z.string().max(255).nullable().optional(),
  supplierRef: z.string().max(255).nullable().optional(),
  // Never nullable — see the NULL vs UNDEFINED note in the module header.
  orderedAt: calendarDay.optional(),
  notes: z.string().max(5000).nullable().optional(),
  feesCents: z.number().int().min(0).max(MAX_CENTS).nullable().optional(),
  feesNote: z.string().max(255).nullable().optional(),
  action: z.enum(['close', 'cancel']).optional(),
});

// ---------------------------------------------------------------------------
// Lines after the order is placed
// ---------------------------------------------------------------------------

/**
 * An UNORDERED ARRIVAL (§4.2.5): something turned up that was never ordered on
 * this header. It is created already VERIFIED, and it carries NO
 * `orderedQuantity` — a booking must never write one, because the line has to
 * stay unordered for every later query and analytic (PK-5).
 *
 * `lineTotalCents` is optional AND nullable: an unbilled arrival honestly has no
 * total, and NULL is how that is said. A verified count of 0 is legal for the
 * same reason it is on a verify.
 */
export const AddArrivedLineSchema = z.object({
  product: ProductSelectorSchema,
  lineTotalCents: z.number().int().min(0).max(MAX_CENTS).nullable().optional(),
  verifiedQuantity: z.number().int().min(0).max(MAX_UNITS),
  labelingRequired: z.boolean().optional(),
  note: noteText.optional(),
});

/** Editing an ORDERED line before it is verified. */
export const PatchLineSchema = z.object({
  product: ProductSelectorSchema.optional(),
  orderedQuantity: z.number().int().min(1).max(MAX_UNITS).optional(),
  lineTotalCents: z.number().int().min(0).max(MAX_CENTS).optional(),
  labelingRequired: z.boolean().optional(),
  notes: z.string().max(5000).optional(),
});

/**
 * THE DELIVERY COUNT. Zero is legal and stays VERIFIED(0) — "nothing arrived" is
 * a fact about the dock, and refusing to record it would push the operator back
 * to guessing (the same reasoning the W1 count endpoint carries).
 *
 * `deliveredProduct` re-points the line at what ACTUALLY arrived (a substitute,
 * or a product created on the spot); the server refuses it once anything has
 * been stocked or disposed.
 *
 * `verifiedQuantity` is OPTIONAL (spec REV-10 clause 2): absent means a
 * FLAG/NOTE-ONLY act — the labeling flag moved, the count did not. Absent is
 * NOT 0, which is a real count of an empty box.
 *
 * `expectPrevious` is the client's statement of the count it was LOOKING AT
 * (clause 1): `null` = "nothing has been counted", a number = the count on the
 * card, absent = no assertion (an older client). A mismatch against the locked
 * row is a 409 rather than a silent re-classification of somebody else's count.
 */
export const VerifyLineSchema = z.object({
  verifiedQuantity: z.number().int().min(0).max(MAX_UNITS).optional(),
  expectPrevious: z.number().int().min(0).max(MAX_UNITS).nullable().optional(),
  note: noteText.optional(),
  labelingRequired: z.boolean().optional(),
  deliveredProduct: ProductSelectorSchema.optional(),
});

/**
 * ONE labeled batch booking into ONE location.
 *
 * `bookingKey` is the CLIENT's identity for this attempt (UNIQUE with
 * `stagingItemId` in the schema): a replay of the same key with the same
 * quantity and location returns the original booking, and a replay with
 * different numbers is a 409 IDEMPOTENCY_MISMATCH. A uuid because that is what
 * the column is sized for (VarChar(36)) and what the UI mints per attempt.
 */
export const StockInSchema = z.object({
  bookingKey: z.string().uuid(),
  quantity: z.number().int().min(1).max(MAX_UNITS),
  locationId: z.number().int().positive(),
  note: noteText.optional(),
});

/**
 * Writing off the remainder of a line. The reason is REQUIRED: this is the act
 * that turns unlabelled units into a recorded money loss, and an unexplained
 * write-off is exactly what the labeling-loss row exists to prevent.
 */
export const DiscardRemainingSchema = z.object({
  reason: z.string().min(1).max(500),
});

/** Discarding a whole line (nothing verified yet) — the reason is optional. */
export const DiscardLineSchema = z.object({
  reason: noteText.optional(),
});

/**
 * Settling an exception. `resolution` is the CLOSED vocabulary from
 * `lib/exceptions/kinds` — one list, so the column, the UI and this schema
 * cannot drift. `relatedShipmentId` / `creditRef` carry the evidence for
 * `reshipped` / `supplier-credited`.
 */
export const ResolveSchema = z.object({
  // `inventory_exceptions.key` is a VarChar(191).
  exceptionKey: z.string().min(1).max(191),
  resolution: z.enum(RESOLUTIONS),
  note: noteText.optional(),
  relatedShipmentId: shipmentId.optional(),
  creditRef: z.string().max(100).optional(),
});

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

/** `GET /api/labeling/queue?orderId=` — absent means every order. */
export const LabelingQueueQuerySchema = z.object({
  orderId: shipmentId.optional(),
});

/** `GET /api/analytics/supply-orders?from=&to=` — both ends required. */
export const SupplyOrdersAnalyticsQuerySchema = z.object({
  from: calendarDay,
  to: calendarDay,
});

export type LineInput = z.infer<typeof LineInputSchema>;
export type CreateSupplyOrderInput = z.infer<typeof CreateSupplyOrderSchema>;
export type PatchSupplyOrderInput = z.infer<typeof PatchSupplyOrderSchema>;
export type AddArrivedLineInput = z.infer<typeof AddArrivedLineSchema>;
export type PatchLineInput = z.infer<typeof PatchLineSchema>;
export type VerifyLineInput = z.infer<typeof VerifyLineSchema>;
export type StockInInput = z.infer<typeof StockInSchema>;
export type DiscardRemainingInput = z.infer<typeof DiscardRemainingSchema>;
export type DiscardLineInput = z.infer<typeof DiscardLineSchema>;
export type ResolveInput = z.infer<typeof ResolveSchema>;
export type LabelingQueueQuery = z.infer<typeof LabelingQueueQuerySchema>;
export type SupplyOrdersAnalyticsQuery = z.infer<typeof SupplyOrdersAnalyticsQuerySchema>;

// ---------------------------------------------------------------------------
// Post-parse assertions (house rule 1)
// ---------------------------------------------------------------------------

function refuse(path: (string | number)[], message: string): never {
  throw new z.ZodError([{ code: z.ZodIssueCode.custom, path, message }]);
}

/**
 * REFUSE a new-product payload that carries `costPrice` AT ALL (PK-8).
 *
 * Runs on the RAW body, BEFORE the parse: Zod strips unknown keys, so without
 * this the field would vanish silently and the client would believe the cost it
 * sent was stored. Cost enters a product through the receipt's own unit cost and
 * the D-COST prompt — never through an order form (premise 1).
 *
 * `hasOwnProperty` and not `in`: an INHERITED `costPrice` (a prototype-polluted
 * object, a class instance) is not something the client typed, and a PRESENT
 * `undefined`/`null` IS — somebody wrote the key, and answering 400 tells them
 * the field has no meaning here instead of dropping it on the floor.
 */
export function assertProductCreateOmitsCostPrice(raw: unknown): void {
  if (raw === null || typeof raw !== 'object') return;
  if (!Object.prototype.hasOwnProperty.call(raw, 'costPrice')) return;
  refuse(
    ['productFields', 'costPrice'],
    'costPrice is not accepted here — a product created from a supply order is priced by the receipt, not by the order form',
  );
}

/**
 * The unit/value PAIRING that `ProductCreateUISchema.superRefine` enforces,
 * re-homed as a post-parse assertion because this module's schemas stay plain
 * ZodObjects.
 *
 * A numeric value with no unit is a number with no meaning ("10" of what?), and
 * a unit with no value is the same hole from the other side. An explicit `null`
 * value is "no size recorded", which pairs with no unit at all.
 */
export function assertProductSizePair(
  fields: { unit?: string | null; numericValue?: number | null } | undefined | null,
): void {
  if (!fields) return;
  const hasNumeric = fields.numericValue !== undefined && fields.numericValue !== null;
  const hasUnit = !!fields.unit;

  if (hasNumeric && !hasUnit) {
    refuse(['productFields', 'unit'], 'Unit is required when numeric value is provided');
  }
  if (hasUnit && !hasNumeric) {
    refuse(
      ['productFields', 'numericValue'],
      'Numeric value is required when unit is provided',
    );
  }
}

/**
 * The day must EXIST. `calendarDay` only proves the shape, and `new Date` is
 * happy to roll `2026-02-30` over to March 2 — which would store an order date
 * the operator never typed. Round-trip through UTC midnight and require the
 * string back (the W0-ISO idiom from `lib/assistant/tools.ts`).
 */
export function assertRealCalendarDate(value: string, field: string): void {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    refuse([field], `${field} is not a real calendar day`);
  }
}

/** Both ends must be real days, and the window must run forwards. */
export function assertAnalyticsWindow(query: SupplyOrdersAnalyticsQuery): void {
  assertRealCalendarDate(query.from, 'from');
  assertRealCalendarDate(query.to, 'to');
  // 'YYYY-MM-DD' sorts chronologically, so the lexical comparison IS the date
  // comparison (the same property `lib/analytics/date-grain.ts` relies on).
  if (query.from > query.to) {
    refuse(['to'], '`to` must not be before `from`');
  }
}

/** A PATCH that asks for nothing is a client bug, not a silent no-op write. */
export function assertPatchNotEmpty(body: PatchSupplyOrderInput): void {
  const asked = Object.values(body).some((value) => value !== undefined);
  if (!asked) {
    refuse(
      [],
      'provide at least one of supplier, supplierRef, orderedAt, notes, feesCents, feesNote or action',
    );
  }
}

/**
 * And for a VERIFY (spec REV-10 clause 2). With the count now optional, an
 * empty body would otherwise be a no-op that still claimed the header, took the
 * locks and wrote an audit row saying nothing happened.
 *
 * `expectPrevious` deliberately does NOT count as asking for something: it is
 * an assertion ABOUT a request, not a request.
 */
export function assertVerifyBodyNotEmpty(body: VerifyLineInput): void {
  const asked =
    body.verifiedQuantity !== undefined ||
    body.labelingRequired !== undefined ||
    body.deliveredProduct !== undefined ||
    body.note !== undefined;
  if (!asked) {
    refuse(
      [],
      'provide at least one of verifiedQuantity, labelingRequired, deliveredProduct or note',
    );
  }
}

/** The same rule for a line PATCH. */
export function assertLinePatchNotEmpty(body: PatchLineInput): void {
  const asked = Object.values(body).some((value) => value !== undefined);
  if (!asked) {
    refuse(
      [],
      'provide at least one of product, orderedQuantity, lineTotalCents, labelingRequired or notes',
    );
  }
}
