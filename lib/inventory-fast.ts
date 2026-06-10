import prisma from '@/lib/prisma';
import type { CurrentInventoryLevel } from '@/types/inventory';

/**
 * Ultra-fast version: Gets current inventory levels without last update times
 * Use this when you just need quantities
 */
export async function getCurrentInventoryLevelsFast(
  locationId?: number
): Promise<CurrentInventoryLevel[]> {
  // SHOW contract: current-stock views intentionally include provisional
  // (PENDING_REVIEW) products -- pending stock is real stock. Do NOT add an
  // approvalStatus filter here. See __tests__/integration/read-path-isolation.test.ts.
  // Get all product locations with products and locations in a single query
  const productLocations = await prisma.product_locations.findMany({
    where: {
      ...(locationId ? { locationId } : {}),
      products: { deletedAt: null },
    },
    include: {
      products: true,
      locations: true,
    },
  });
  
  // Map to inventory levels (without last update time)
  const inventoryLevels: CurrentInventoryLevel[] = productLocations.map(pl => ({
    productId: pl.productId,
    product: pl.products,
    locationId: pl.locationId,
    location: pl.locations,
    quantity: pl.quantity,
    lastUpdated: new Date(0), // Default date, not fetched
    version: pl.version,
  }));
  
  // If specific location requested, include products with 0 quantity
  if (locationId) {
    const productsWithInventory = new Set(inventoryLevels.map(il => il.productId));
    const [allProducts, location] = await Promise.all([
      prisma.product.findMany({
        where: {
          id: {
            notIn: Array.from(productsWithInventory),
          },
          deletedAt: null,
        },
      }),
      prisma.location.findUnique({ where: { id: locationId } }),
    ]);
    
    if (location) {
      for (const product of allProducts) {
        inventoryLevels.push({
          productId: product.id,
          product,
          locationId,
          location,
          quantity: 0,
          lastUpdated: new Date(0),
          version: 0,
        });
      }
    }
  }
  
  return inventoryLevels;
}