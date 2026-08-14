import prisma from "@/lib/prisma";
import { requireCompanyMembership } from "@/lib/api-utils";
import { AppError } from "@/lib/error-handling";
import type { DeductionIntent } from "@/lib/inventory/intent";

/**
 * The reference-resolution round: attribute a manual deduction from the order
 * number the packer TYPED, when — and only when — that number identifies
 * exactly one order.
 *
 * WHY THIS EXISTS AT ALL. Phase 0b-2 accrued the order a packer had SELECTED,
 * and the production backfill proved that premise unmet: `selectedExternalOrderId`
 * has never been written in production (0 of 1,897 all-time accrual events).
 * Packers do not pick an order; they type the Woo order number into the
 * workbench's free-text field. All 10 distinct references production has ever
 * recorded resolve exactly against `external_orders.orderNumber`. The
 * attribution data has been there the whole time, in the wrong field.
 *
 * HOW THIS DIFFERS FROM ITS SIBLING, and the difference is the design:
 *
 *   resolve-selected-order.ts   a CLIENT-SUPPLIED ID annotating a stock write.
 *                               Unverifiable => the PAYLOAD is invalid => 400,
 *                               nothing commits. An intent we cannot verify must
 *                               fail the request rather than ride along as if it
 *                               were true.
 *   this module                 free text a packer typed while packing.
 *                               Unresolvable => THE DEDUCTION IS STILL LEGAL.
 *                               It has always been legal, it is what production
 *                               has done for months, and refusing it now to
 *                               protect a column would trade a working warehouse
 *                               for an attribution. Only the STAMP is withheld.
 *
 * So nothing here throws for a reference it cannot use: every outcome is NAMED
 * and the caller decides. The one thing that does propagate is a non-AppError
 * fault — a database outage is not a bad reference, and swallowing it would turn
 * an infrastructure failure into a silently unattributed movement.
 *
 * MEMBERSHIP is the same single predicate the sibling uses
 * (`requireCompanyMembership`, never re-implemented), applied to the RESOLVED
 * order — never to a claim. Only its CONSEQUENCE differs: there a failure
 * rejects the payload, here it withholds the attribution. Nothing about the
 * declined order is logged, returned or recorded; an approved user of another
 * company learns nothing from having typed a number.
 *
 * NOT Next-free, and cannot be, for the sibling's reason: `requireCompanyMembership`
 * lives in @/lib/api-utils, which imports `next/server`. Re-implementing the
 * predicate to win a module-purity property is exactly the duplication the
 * single-homed membership rule exists to prevent.
 */

/**
 * A PLAUSIBLE ORDER NUMBER, defined conservatively FROM THE DATA: a run of
 * ASCII digits, 1–20 of them.
 *
 * Every reference production has ever recorded is a plain digit string and every
 * one of them resolves, so digits is what this admits. `#12345`, `WC-123`,
 * `12 345` and `walk-in 88` are refused even where a normalization could
 * plausibly rescue the first two: inventing that normalization is a MATCHER's
 * job (W3, with an exceptions queue behind it), and doing it here would create
 * attributions from a rule nobody reviewed. The 20-digit ceiling is a sanity
 * bound, not an order-number bound — nothing longer is a Woo order number.
 *
 * DUPLICATED ON PURPOSE in scripts/backfill/order-attribution/plan.js, which is
 * standalone by contract (it imports @prisma/client and its own planner, never
 * lib/ or next/). The companion backfill must apply the same bar to the same
 * strings; the two copies are pinned equal in
 * __tests__/unit/lib/orders/resolve-order-reference.test.ts.
 */
export const ORDER_REFERENCE_SHAPE = /^[0-9]{1,20}$/;

/**
 * How many candidate orders are read before uniqueness is declared unprovable.
 * The collation-tolerant lookup can return rows that are not exact matches, so
 * a page that comes back FULL means "there may be more" — and "may be more" is
 * not the same as unique. Ambiguous, then.
 */
export const ORDER_REFERENCE_CANDIDATE_CAP = 10;

/** The two evidence tokens, shared verbatim with the companion backfill. */
export const ORDER_ATTRIBUTION_SOURCE = {
  /** 0b-2's structured id: the packer picked the order. */
  SELECTED: "selected",
  /** This module: the packer typed a number that named exactly one order. */
  REFERENCE_RESOLVED: "reference-resolved",
} as const;

export type OrderAttributionSource =
  (typeof ORDER_ATTRIBUTION_SOURCE)[keyof typeof ORDER_ATTRIBUTION_SOURCE];

/**
 * Every way this can end. The four non-resolved outcomes are distinguished for
 * the caller's benefit and for tests — the route treats them identically (accrue
 * the text, stamp nothing), because from a packer's point of view they are all
 * "we could not tell", and W3's matcher inherits all four.
 */
export type OrderReferenceResolution =
  | { outcome: "resolved"; orderRecordId: string }
  | {
      outcome: "unusable" | "unmatched" | "ambiguous" | "not-a-member";
      orderRecordId: null;
    };

/** The trimmed reference when it looks like an order number, null otherwise. */
export function normalizeOrderReference(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return ORDER_REFERENCE_SHAPE.test(trimmed) ? trimmed : null;
}

/**
 * May a reference be resolved for this chip value?
 *
 * ABSENT and `order` yes; `other` and `damage-loss` no.
 *
 * NOTE THE ASYMMETRY WITH `mapDeductionIntent`, which reads an absent chip as
 * `other` (its default) and therefore stamps no structured id. That default is
 * right for the id — a client sending an id with no chip is a pre-chip client
 * whose intent is genuinely unknown. It is wrong for the reference, because the
 * surface that produces a reference with no chip is not an old client: it is the
 * CURRENT workbench, whose chip only renders when a WC order is selected. An
 * absent chip there means "no chip was offered", not "the operator declined to
 * classify". An operator who DID see the chip and chose `other` is answered, not
 * overruled — their answer outranks any number they also typed.
 */
export function isReferenceResolutionEligible(intent?: DeductionIntent | null): boolean {
  return intent == null || intent === "order";
}

/**
 * Resolve a typed order reference to an order id, or say why not.
 *
 * The bar is EXACT and UNIQUE. MySQL's default collation is case- and
 * pad-insensitive, so the `where` clause is a CANDIDATE fetch and equality is
 * decided here on the raw strings: `12345 ` is not `12345`, and a "close enough"
 * match is precisely the false attribution this lane exists to remove.
 */
export async function resolveOrderReference(
  raw: string | null | undefined,
  user: { id: number; isAdmin: boolean }
): Promise<OrderReferenceResolution> {
  const reference = normalizeOrderReference(raw);
  if (reference === null) return { outcome: "unusable", orderRecordId: null };

  const candidates = await prisma.externalOrder.findMany({
    where: { orderNumber: reference },
    select: { id: true, orderNumber: true, companyId: true },
    orderBy: { id: "asc" },
    take: ORDER_REFERENCE_CANDIDATE_CAP,
  });

  // A full page cannot prove uniqueness — there may be an unread eleventh row.
  if (candidates.length >= ORDER_REFERENCE_CANDIDATE_CAP) {
    return { outcome: "ambiguous", orderRecordId: null };
  }

  const exact = candidates.filter((c) => c.orderNumber === reference);
  if (exact.length === 0) return { outcome: "unmatched", orderRecordId: null };
  if (exact.length > 1) return { outcome: "ambiguous", orderRecordId: null };

  const order = exact[0];
  try {
    await requireCompanyMembership(user.id, order.companyId, user.isAdmin);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    // The deduction stands; the attribution does not. Nothing about the order is
    // reported back — not its id, not its company, not that it exists.
    return { outcome: "not-a-member", orderRecordId: null };
  }
  return { outcome: "resolved", orderRecordId: order.id };
}
