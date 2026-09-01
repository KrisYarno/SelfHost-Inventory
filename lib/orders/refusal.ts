/**
 * lib/orders/refusal.ts — THE ONE READER OF A FULFIL ENVELOPE'S REFUSAL.
 *
 * Reconciliation Part 2, pack CB1.5c (seam S-B15). A fulfil answers 200 with a
 * per-item envelope, and from B1.5 on a PARTIAL 200 is reachable in production
 * for the first time: a short line is a `skipped` entry, not an error status.
 * Both consumers of that envelope — the fulfil dialog's toast tiers and the
 * workbench's all-or-nothing WC leg — have to say ONE sentence about why, so
 * the selection lives here once instead of twice.
 *
 * THE PRIORITY, and why it is not "the first entry":
 *   1. the first `insufficient_stock` skip's `details`  — the operator-actionable
 *      truth, and the one that quotes the exact locked quantity (QB-9);
 *   2. the first `failed[]` entry's `error`             — a structural fault;
 *   3. the first other skip that HAS `details`;
 *   4. that skip's `reason`                             — the bare class name.
 * `skipped[]` is in PASS order after B1.5 (pack I5 / FVc-2) and that order is
 * explicitly NOT contractual, so an index-based read would let a pass-1
 * "unmapped" shadow the short line the operator actually has to act on.
 *
 * A LEAF module by contract (DCc-3): no React, no Next, no Prisma, no hooks.
 * The dialog suites mock `@/hooks/use-orders`; a helper that lived there would
 * be `undefined` inside the dialog under test and the refusal pins would go
 * green for the wrong reason (the FDe-4 class this lane already paid for).
 * Both dialogs import THIS module directly, and nothing mocks it.
 *
 * The envelope is typed STRUCTURALLY rather than as `FulfillmentResult`: that
 * interface lives in `lib/fulfillment.ts` beside Prisma, the route reshapes
 * `fulfilled[]` on the way out, and this helper reads only the two arrays whose
 * shape the route passes through untouched.
 */

/** The `skipped[]` entry shape this reader depends on (a subset of the wire's). */
interface RefusalSkip {
  reason?: string | null;
  details?: string | null;
}

/** The `failed[]` entry shape this reader depends on. */
interface RefusalFailure {
  error?: string | null;
}

/** `results` off the fulfil route's 200 envelope (`fulfill/route.ts`). */
interface RefusalEnvelope {
  skipped?: RefusalSkip[] | null;
  failed?: RefusalFailure[] | null;
}

/** A usable sentence is a non-empty string; anything else is not a refusal. */
function sentence(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * The one refusal to show for a fulfil envelope, chosen by PRIORITY.
 *
 * Returns `null` — never `undefined` (DCc-10) — when the envelope names no
 * refusal at all, so a caller can spell its own fallback with `??`.
 */
export function primaryRefusal(results: RefusalEnvelope | null | undefined): string | null {
  // QA-2: SHAPE, not just absence. `?? []` answered null and undefined, and a
  // body carrying a non-array `skipped` (a version skew, a proxied envelope)
  // reached `.find` and threw INSIDE the caller's try — the fulfil dialog then
  // reported a COMMITTED fulfilment as "Fulfillment Failed". A half this reader
  // cannot iterate names no refusal; the other half is still read.
  const skipped = Array.isArray(results?.skipped) ? results.skipped : [];
  const failed = Array.isArray(results?.failed) ? results.failed : [];

  // 1. The short line, with the exact locked quantity the engine reported.
  const shortLine = skipped.find(
    (skip) => skip?.reason === "insufficient_stock" && sentence(skip?.details) !== null,
  );
  if (shortLine) return sentence(shortLine.details);

  // 2. A structural fault (item not in the order, an absent product, a bundle
  //    with no components) — the route's `failed[]` carries the full sentence.
  const failure = failed.find((entry) => sentence(entry?.error) !== null);
  if (failure) return sentence(failure.error);

  // 3. Any other skip that explains itself. Reaching here means no
  //    `insufficient_stock` skip carried details, so this is that "other" set.
  const explained = skipped.find((skip) => sentence(skip?.details) !== null);
  if (explained) return sentence(explained.details);

  // 4. The bare class name of the first skip — "unmapped", "already_fulfilled".
  const bare = skipped.find((skip) => sentence(skip?.reason) !== null);
  if (bare) return sentence(bare.reason);

  return null;
}
