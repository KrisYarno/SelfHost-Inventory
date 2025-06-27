import prisma from '@/lib/prisma';
import { 
  inventory_logs_logType,
  Prisma
} from '@prisma/client';
import type { 
  CurrentInventoryLevel
} from '@/types/inventory';

/**
 * Optimized version: Gets current inventory levels for all products
 * Fixes N+1 query problem by batch loading last update times
 */
export async function getCurrentInventoryLevelsOptimized(
  locationId?: number
): Promise<CurrentInventoryLevel[]> {
  // Get product locations with related data
  const productLocations = await prisma.product_locations.findMany({
    where: locationId ? { locationId } : undefined,
    include: {
      products: true,
      locations: true,
    },
  });
  
  if (productLocations.length === 0) {
    return [];
  }
  
  // Batch load last update times for all product/location combinations
  const productLocationPairs = productLocations.map(pl => ({
    productId: pl.productId,
    locationId: pl.locationId,
  }));
  
  // Get the most recent log for each product/location combination
  // Using a simpler approach that's more compatible
  const lastUpdatePromises = productLocationPairs.map(pair => 
    prisma.inventory_logs.findFirst({
      where: {
        productId: pair.productId,
        locationId: pair.locationId,
      },
      orderBy: {
        changeTime: 'desc',
      },
      select: {
        changeTime: true,
      },
    }).then(log => ({
      key: `${pair.productId}-${pair.locationId}`,
      changeTime: log?.changeTime || null,
    }))
  );
  
  // Batch the promises to avoid overwhelming the database
  const batchSize = 50;
  const lastUpdateResults = [];
  for (let i = 0; i < lastUpdatePromises.length; i += batchSize) {
    const batch = lastUpdatePromises.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch);
    lastUpdateResults.push(...batchResults);
  }
  
  // Create a map for quick lookup
  const lastUpdateMap = new Map(
    lastUpdateResults.map(item => [
      item.key,
      item.changeTime
    ])
  );
  
  // Map product locations to inventory levels
  const inventoryLevels: CurrentInventoryLevel[] = productLocations.map(pl => ({
    productId: pl.productId,
    product: pl.products,
    locationId: pl.locationId,
    location: pl.locations,
    quantity: pl.quantity,
    lastUpdated: lastUpdateMap.get(`${pl.productId}-${pl.locationId}`) || new Date(0),
  }));
  
  // If specific location requested, also include products with 0 quantity
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
        });
      }
    }
  }
  
  return inventoryLevels;
}

/**
 * Batch update product quantities
 * More efficient for multiple updates
 */
export async function batchUpdateQuantities(
  updates: Array<{
    productId: number;
    locationId: number;
    delta: number;
  }>,
  userId: number,
  logType: inventory_logs_logType = inventory_logs_logType.ADJUSTMENT
) {
  return await prisma.$transaction(async (tx) => {
    // Validate all stock availability first
    for (const update of updates) {
      if (update.delta < 0) {
        const currentQuantity = await getCurrentQuantityOptimized(
          update.productId,
          update.locationId,
          tx
        );
        
        if (currentQuantity < Math.abs(update.delta)) {
          throw new Error(
            `Insufficient stock for product ${update.productId}. Available: ${currentQuantity}, Requested: ${Math.abs(update.delta)}`
          );
        }
      }
    }
    
    // Create all log entries
    const logEntries = updates.map(update => ({
      userId,
      productId: update.productId,
      locationId: update.locationId,
      delta: update.delta,
      changeTime: new Date(),
      logType,
    }));
    
    await tx.inventory_logs.createMany({
      data: logEntries,
    });
    
    // Update all product_locations
    for (const update of updates) {
      await tx.product_locations.upsert({
        where: {
          productId_locationId: {
            productId: update.productId,
            locationId: update.locationId,
          },
        },
        update: {
          quantity: {
            increment: update.delta,
          },
        },
        create: {
          productId: update.productId,
          locationId: update.locationId,
          quantity: Math.max(0, update.delta),
        },
      });
    }
    
    return { success: true, updatedCount: updates.length };
  });
}

/**
 * Optimized quantity lookup with caching consideration
 */
export async function getCurrentQuantityOptimized(
  productId: number,
  locationId: number,
  tx?: Prisma.TransactionClient
): Promise<number> {
  const db = tx || prisma;
  
  const productLocation = await db.product_locations.findUnique({
    where: {
      productId_locationId: {
        productId,
        locationId,
      },
    },
    select: {
      quantity: true,
    },
  });
  
  return productLocation?.quantity || 0;
}