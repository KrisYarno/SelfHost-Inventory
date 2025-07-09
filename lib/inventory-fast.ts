import prisma from '@/lib/prisma';
import type { CurrentInventoryLevel } from '@/types/inventory';

/**
 * Ultra-fast version: Gets current inventory levels without last update times
 * Use this when you just need quantities
 */
export async function getCurrentInventoryLevelsFast(
  locationId?: number
): Promise<CurrentInventoryLevel[]> {
  // Get all product locations with products and locations in a single query
  const productLocations = await prisma.product_locations.findMany({
    where: locationId ? { locationId } : undefined,
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

/**
 * Get inventory levels with pagination
 */
export async function getCurrentInventoryLevelsPaginated(
  locationId?: number,
  page: number = 1,
  pageSize: number = 50
): Promise<{
  inventory: CurrentInventoryLevel[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const skip = (page - 1) * pageSize;
  
  // Get total count
  const totalProducts = await prisma.product.count();
  
  // Get paginated products
  const products = await prisma.product.findMany({
    skip,
    take: pageSize,
    orderBy: { name: 'asc' },
  });
  
  // Get product locations for these products
  const productIds = products.map(p => p.id);
  const productLocations = await prisma.product_locations.findMany({
    where: {
      productId: { in: productIds },
      ...(locationId ? { locationId } : {}),
    },
    include: {
      locations: true,
    },
  });
  
  // Create a map for quick lookup
  const locationMap = new Map<number, typeof productLocations>();
  productLocations.forEach(pl => {
    const key = pl.productId;
    if (!locationMap.has(key)) {
      locationMap.set(key, []);
    }
    locationMap.get(key)!.push(pl);
  });
  
  // Build inventory levels
  const inventory: CurrentInventoryLevel[] = [];
  
  for (const product of products) {
    const locations = locationMap.get(product.id) || [];
    
    if (locationId) {
      // Single location view
      const pl = locations.find(l => l.locationId === locationId);
      const location = pl?.locations || await prisma.location.findUnique({ where: { id: locationId } });
      
      if (location) {
        inventory.push({
          productId: product.id,
          product,
          locationId,
          location,
          quantity: pl?.quantity || 0,
          lastUpdated: new Date(0),
          version: pl?.version || 0,
        });
      }
    } else {
      // All locations - aggregate
      const totalQuantity = locations.reduce((sum, pl) => sum + pl.quantity, 0);
      inventory.push({
        productId: product.id,
        product,
        locationId: 0,
        location: { id: 0, name: 'All Locations' },
        quantity: totalQuantity,
        lastUpdated: new Date(0),
        version: 0, // Aggregated view doesn't have a single version
      });
    }
  }
  
  return {
    inventory,
    total: totalProducts,
    page,
    pageSize,
  };
}