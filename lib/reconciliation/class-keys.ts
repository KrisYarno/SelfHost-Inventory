/**
 * The CLOSED attribution class-key vocabulary — its OWN module (no Prisma, no
 * Next, no imports at all) so the admin UI's chips and the assistant tool's
 * `z.enum` can value-import it WITHOUT dragging `lib/prisma` into a client
 * chunk. M4b's build audit found `new PrismaClient(...)` inside the
 * /admin/reconciliation page chunk, reached exactly through this constant's
 * old home in `attribution.ts` (which imports the Prisma singleton); jest never
 * saw it because the root setup force-mocks `@/lib/prisma`. The producer
 * re-exports both names, so server callers are unchanged.
 */
export const ATTRIBUTION_CLASS_KEYS = [
  'attributed·fulfillment',
  'attributed·selected',
  'attributed·reference-resolved',
  'attributed·manual',
  'attributed·derived',
  'declined·unusable',
  'declined·unmatched',
  'declined·ambiguous',
  'declined·not-a-member',
  'declined·resolver-error',
  'declined·unknown',
  'none·no-reference-typed',
  'none·explicit-non-order-intent',
  'none·order-intent-no-id',
  'none·no-order-context',
  'none·unknown',
] as const;

export type AttributionClassKey = (typeof ATTRIBUTION_CLASS_KEYS)[number];
