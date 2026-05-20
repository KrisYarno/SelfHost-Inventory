import prisma from '@/lib/prisma';

export type BundleStatus = 'instock' | 'outofstock';

export interface BundleStatusResult {
  status: BundleStatus;
  warning?: { kind: 'orphan-component'; internalProductId: number };
}

/**
 * Compute the in/out-of-stock status for a bundle ProductLink.
 *
 * - `instock` iff every component has on-hand ≥ component.quantity at the
 *   sync location (or summed across all locations if syncLocationId is null).
 * - `outofstock` if any component is short.
 * - `outofstock` (with orphan warning, per eng-review D3) if any component
 *   points at a soft-deleted Product. Caller propagates the warning to the
 *   operator UI; this function never throws.
 * - Defensive: an empty components list is treated as `outofstock`.
 */
export async function computeBundleStockStatus(
  productLinkId: string,
  syncLocationId: number | null,
): Promise<BundleStatusResult> {
  const components = await prisma.bundleComponent.findMany({
    where: { productLinkId },
    include: {
      internalProduct: {
        include: {
          product_locations: syncLocationId
            ? { where: { locationId: syncLocationId } }
            : true,
        },
      },
    },
  });

  if (components.length === 0) {
    return { status: 'outofstock' };
  }

  for (const c of components) {
    if (c.internalProduct.deletedAt !== null) {
      return {
        status: 'outofstock',
        warning: { kind: 'orphan-component', internalProductId: c.internalProductId },
      };
    }

    const locations = c.internalProduct.product_locations ?? [];
    const onHand = syncLocationId
      ? locations[0]?.quantity ?? 0
      : locations.reduce((sum: number, pl: { quantity: number }) => sum + pl.quantity, 0);

    if (onHand < c.quantity) {
      return { status: 'outofstock' };
    }
  }

  return { status: 'instock' };
}
