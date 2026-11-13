/**
 * THE ORDER CAPTURE'S SENTENCES — the server's words a client reads back
 * (reconciliation Part 2, pack § P2-B3-1R, R-a.3).
 *
 * A LEAF, with no imports at all (the `order-reference-shape.ts` precedent):
 * the adjust dialog compares a refusal's message to these sentences, and it
 * must take them without pulling `resolve-selected-order.ts` (Prisma,
 * `next/server`) or `reconciliation/attribution.ts` (Prisma) into a client
 * chunk. The server modules import them FROM here, so the dialog and the
 * route can never word the same fact two ways. A source pin keeps every
 * `"use client"` file off those two modules as a value import.
 */

/**
 * The ONE 400 a picked order id earns when it resolves to no order, or to an
 * order in a company the caller is not a member of
 * (`lib/orders/resolve-selected-order.ts`). The dialog recognises it, by this
 * exact text, as "that order can't be used anymore" rather than a failed save.
 */
export const SELECTED_ORDER_REJECTED_SENTENCE =
  "selectedExternalOrderId does not reference an order you can access";

/**
 * A member with NO company: the order search's empty answer names why
 * (B3-1 FR1), not "no match". MOVED here from
 * `lib/reconciliation/attribution.ts`, which re-exports it.
 */
export const NO_COMPANY_MEMBERSHIP_NOTE =
  "you are not a member of any company yet, so there are no orders to search — ask an admin to add you";
