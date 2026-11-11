/**
 * A PLAUSIBLE ORDER NUMBER — the ONE home of the bar (reconciliation Part 2,
 * pack § P2-B3-1, B3-1b). A run of ASCII digits, 1–20 of them; the reasoning
 * lives beside the resolver that applies it on the server
 * (`lib/orders/resolve-order-reference.ts`).
 *
 * A LEAF, with no imports at all, so a client component can take the bar
 * without pulling the resolver's Prisma import into its bundle: the resolver,
 * the Attribute… picker and the adjust dialog all import it from here, and
 * none of them declares its own. The CommonJS copy under `scripts/backfill/**`
 * cannot import TypeScript and stays a pinned copy.
 */
export const ORDER_REFERENCE_SHAPE = /^[0-9]{1,20}$/;
