/**
 * Bundle snapshot resolution helper (D7).
 *
 * For bundle items, the effective component composition at the moment of
 * fulfillment is captured in `ExternalOrderItem.bundleComponentSnapshot`
 * (frozen JSON). The snapshot is the source of truth — it guarantees that
 * fulfill and unfulfill operate on the same composition even if the bundle
 * is PATCHed in between.
 *
 * For legacy rows that pre-date the snapshot column (or whose snapshot was
 * never backfilled), we fall back to the live `ProductLink.bundleComponents`
 * join rows. After the Fix B at-fulfill snapshot write, the unfulfill path
 * should never need the fallback in practice — but we keep it for the
 * validation path and for defensive reads.
 */
import { BundleComponentSnapshotArraySchema } from '@/lib/validation/bundle-links';
import type { BundleComponentSnapshot } from '@/types/bulk-map';

/** Shape of a live BundleComponent row (subset of fields the resolver needs). */
export interface LiveBundleComponent {
  internalProductId: number;
  quantity: number;
  sortOrder?: number;
  internalProduct?: { id: number; name: string } | null;
}

/** Result of resolving a bundle item's components. */
export type SnapshotResolveResult =
  | { ok: true; components: BundleComponentSnapshot[]; source: 'snapshot' | 'live' }
  | { ok: false; reason: 'malformed_snapshot'; detail: string }
  | { ok: false; reason: 'empty' };

/**
 * Resolve a bundle item's effective components. Prefers the frozen snapshot;
 * Zod-validates it to fail-closed on DB corruption. Falls back to live
 * components when the snapshot is null/undefined. Returns `{ok:false,reason:'empty'}`
 * when neither source has any components.
 */
export function resolveBundleComponents(
  rawSnapshot: unknown,
  liveBundleComponents?: LiveBundleComponent[] | null,
): SnapshotResolveResult {
  if (rawSnapshot !== null && rawSnapshot !== undefined) {
    const parsed = BundleComponentSnapshotArraySchema.safeParse(rawSnapshot);
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'malformed_snapshot',
        detail: parsed.error.errors[0]?.message ?? 'invalid format',
      };
    }
    // Normalize optional fields to match BundleComponentSnapshot's required shape.
    const components: BundleComponentSnapshot[] = parsed.data.map((c) => ({
      internalProductId: c.internalProductId,
      internalProductName: c.internalProductName ?? `Product ${c.internalProductId}`,
      quantity: c.quantity,
      sortOrder: c.sortOrder ?? 0,
    }));
    return { ok: true, components, source: 'snapshot' };
  }

  // null/undefined snapshot → fall back to live bundleComponents (Prisma-typed, no Zod needed).
  const live = liveBundleComponents ?? [];
  if (live.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  const components: BundleComponentSnapshot[] = live.map((c, i) => ({
    internalProductId: c.internalProductId,
    internalProductName: c.internalProduct?.name ?? `Product ${c.internalProductId}`,
    quantity: c.quantity,
    sortOrder: c.sortOrder ?? i,
  }));
  return { ok: true, components, source: 'live' };
}
