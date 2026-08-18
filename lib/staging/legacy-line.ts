import { AppError } from '@/lib/error-handling';

/**
 * The legacy staging line's non-null guarantee, asserted where the row becomes
 * a wire shape (contract pack REV-2 C1.5 / plan P-7).
 *
 * The Receiving/Labeling overhaul NULL-widens three columns on `staging_items`:
 * `locationId`, `receivedBy` and `receivedAt`. All three describe the RECEIPT
 * act, which the supply-order flow records as `verifiedBy`/`verifiedAt` plus a
 * per-batch location chosen at labeling time — so a new-flow line legitimately
 * carries NULL in all three, while EVERY row the legacy pre-staging flow ever
 * wrote carries all three (they were NOT NULL when those rows were written, and
 * nothing rewrites history).
 *
 * The legacy read paths only ever return legacy rows, so their wire contract
 * keeps its non-null types. That is a DATA invariant, not a type-system one, so
 * it is asserted at the mapping boundary rather than cast away: if a new-flow
 * line ever reaches a legacy mapper the answer is a 500 naming the invariant,
 * never a silently-null `locationId` rendered as a location.
 *
 * `asserts` narrows the caller's row in place, which is why the helper takes the
 * whole row and returns nothing.
 */
export function assertLegacyLine<
  T extends { locationId: number | null; receivedBy: number | null; receivedAt: Date | null },
>(row: T): asserts row is T & { locationId: number; receivedBy: number; receivedAt: Date } {
  if (row.locationId === null || row.receivedBy === null || row.receivedAt === null) {
    throw new AppError(
      'legacy staging line missing locationId/receivedBy/receivedAt',
      'INVARIANT',
      500,
    );
  }
}
