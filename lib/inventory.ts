import prisma from '@/lib/prisma';
import { 
  inventory_logs_logType,
  Prisma
} from '@prisma/client';
import type { 
  StockValidation,
  CurrentInventoryLevel,
  InventorySnapshot
} from '@/types/inventory';
import { 
  InsufficientStockError, 
  ProductNotFoundError
} from '@/lib/error-handling';

/**
 * Creates an inventory log entry
 */
export async function createInventoryLog(
  data: {
    userId: number;
    productId: number;
    locationId: number;
    delta: number;
    logType?: inventory_logs_logType;
  },
  tx?: Prisma.TransactionClient
) {
  const db = tx || prisma;
  
  // Create the log entry
  return await db.inventory_logs.create({
    data: {
      userId: data.userId,
      productId: data.productId,
      locationId: data.locationId,
      delta: data.delta,
      changeTime: new Date(),
      logType: data.logType || inventory_logs_logType.ADJUSTMENT,
    },
    include: {
      users: true,
      products: true,
      locations: true,
    }
  });
}

/**
 * Validates if sufficient stock is available
 */
export async function validateStockAvailability(
  productId: number,
  locationId: number,
  requestedQuantity: number,
  tx?: Prisma.TransactionClient
): Promise<StockValidation> {
  const db = tx || prisma;
  const currentQuantity = await getCurrentQuantity(productId, locationId, db);
  
  if (currentQuantity >= requestedQuantity) {
    return {
      isValid: true,
      currentQuantity,
      requestedQuantity,
    };
  }
  
  return {
    isValid: false,
    currentQuantity,
    requestedQuantity,
    shortfall: requestedQuantity - currentQuantity,
    error: `Insufficient stock. Available: ${currentQuantity}, Requested: ${requestedQuantity}`,
  };
}

/**
 * Gets current quantity for a product at a location
 * from the product_locations table
 */
export async function getCurrentQuantity(
  productId: number,
  locationId: number,
  tx?: Prisma.TransactionClient
): Promise<number> {
  const db = tx || prisma;
  
  // Get quantity from product_locations table
  const productLocation = await db.product_locations.findUnique({
    where: {
      productId_locationId: {
        productId,
        locationId,
      },
    },
  });
  
  return productLocation?.quantity || 0;
}

/**
 * Gets current inventory levels for all products
 */
export async function getCurrentInventoryLevels(
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
  
  const inventoryLevels: CurrentInventoryLevel[] = [];
  
  // Map product locations to inventory levels
  for (const pl of productLocations) {
    // Get the last update time
    const lastLog = await prisma.inventory_logs.findFirst({
      where: {
        productId: pl.productId,
        locationId: pl.locationId,
      },
      orderBy: {
        changeTime: 'desc',
      },
      select: {
        changeTime: true,
      },
    });
    
    inventoryLevels.push({
      productId: pl.productId,
      product: pl.products,
      locationId: pl.locationId,
      location: pl.locations,
      quantity: pl.quantity,
      lastUpdated: lastLog?.changeTime || new Date(0),
    });
  }
  
  // If specific location requested, also include products with 0 quantity
  if (locationId) {
    const productsWithInventory = new Set(inventoryLevels.map(il => il.productId));
    const allProducts = await prisma.product.findMany();
    const location = await prisma.location.findUnique({ where: { id: locationId } });
    
    for (const product of allProducts) {
      if (!productsWithInventory.has(product.id) && location) {
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
 * Gets inventory snapshot at a specific point in time
 * by summing inventory logs up to that timestamp
 */
export async function getInventorySnapshot(
  timestamp: Date,
  locationId?: number
): Promise<InventorySnapshot> {
  // Get all products
  const products = await prisma.product.findMany();
  
  // Get all locations or specific location
  const locations = await prisma.location.findMany({
    where: locationId ? { id: locationId } : undefined,
  });
  
  const inventory: Array<{
    productId: number;
    locationId: number;
    quantity: number;
  }> = [];
  
  // For each product/location, sum deltas up to the timestamp
  for (const product of products) {
    for (const location of locations) {
      const result = await prisma.inventory_logs.aggregate({
        where: {
          productId: product.id,
          locationId: location.id,
          changeTime: {
            lte: timestamp,
          },
        },
        _sum: {
          delta: true,
        },
      });
      
      inventory.push({
        productId: product.id,
        locationId: location.id,
        quantity: result._sum.delta || 0,
      });
    }
  }
  
  return {
    timestamp,
    inventory,
  };
}

/**
 * Creates an inventory adjustment and updates product_locations with optimistic locking
 */
export async function createInventoryAdjustment(
  userId: string,
  productId: number,
  locationId: number,
  delta: number,
  logType?: inventory_logs_logType,
  expectedVersion?: number
) {
  const maxRetries = 3;
  let retryCount = 0;
  
  while (retryCount < maxRetries) {
    try {
      return await prisma.$transaction(async (tx) => {
        // Get current product location with version
        const currentProductLocation = await tx.product_locations.findUnique({
          where: {
            productId_locationId: {
              productId,
              locationId,
            },
          },
        });

        // Check version if provided (for optimistic locking)
        if (expectedVersion !== undefined && currentProductLocation) {
          if (currentProductLocation.version !== expectedVersion) {
            throw new OptimisticLockError(
              'Product inventory has been modified by another user. Please refresh and try again.',
              currentProductLocation.version,
              expectedVersion
            );
          }
        }

        // If removing stock, validate availability
        if (delta < 0) {
          const validation = await validateStockAvailability(
            productId,
            locationId,
            Math.abs(delta),
            tx
          );

          if (!validation.isValid) {
            // Get product name for better error message
            const product = await tx.product.findUnique({
              where: { id: productId },
              select: { name: true }
            });
            
            if (!product) {
              throw new ProductNotFoundError(productId);
            }
            
            throw new InsufficientStockError(
              product.name,
              validation.currentQuantity,
              Math.abs(delta)
            );
          }
        }

        // Create the log entry
        const log = await createInventoryLog({
          userId: parseInt(userId),
          productId,
          locationId,
          delta,
          logType,
        }, tx);

        // Update or create product_locations entry with version increment
        const updatedProductLocation = await tx.product_locations.upsert({
          where: {
            productId_locationId: {
              productId,
              locationId,
            },
          },
          update: {
            quantity: {
              increment: delta,
            },
            version: {
              increment: 1,
            },
          },
          create: {
            productId,
            locationId,
            quantity: delta,
            version: 1,
          },
        });

        // Update the product's quantity field for location 1 (for compatibility)
        if (locationId === 1) {
          await tx.product.update({
            where: { id: productId },
            data: { quantity: { increment: delta } },
          });
        }

        return {
          log,
          newVersion: updatedProductLocation.version,
        };
      });
    } catch (error) {
      if (error instanceof OptimisticLockError && retryCount < maxRetries - 1) {
        retryCount++;
        // Small delay before retry
        await new Promise(resolve => setTimeout(resolve, 100 * retryCount));
        continue;
      }
      throw error;
    }
  }
  
  throw new Error('Max retries exceeded');
}

/**
 * Custom error class for optimistic lock violations
 */
export class OptimisticLockError extends Error {
  constructor(
    message: string,
    public currentVersion: number,
    public expectedVersion: number
  ) {
    super(message);
    this.name = 'OptimisticLockError';
  }
}

/**
 * Simplified transaction creation for compatibility with optimistic locking support
 */
export async function createInventoryTransaction(
  type: string,
  userId: string,
  items: Array<{
    productId: number;
    locationId: number;
    changeType?: string;
    quantityChange: number;
    notes?: string;
    expectedVersion?: number;
  }>,
  metadata?: Record<string, unknown>
) {
  return await prisma.$transaction(async (tx) => {
    const logs = [];
    const versions: Record<string, number> = {};

    // Process each item
    for (const item of items) {
      // Get current product location with version
      const currentProductLocation = await tx.product_locations.findUnique({
        where: {
          productId_locationId: {
            productId: item.productId,
            locationId: item.locationId,
          },
        },
      });

      // Check version if provided (for optimistic locking)
      if (item.expectedVersion !== undefined && currentProductLocation) {
        if (currentProductLocation.version !== item.expectedVersion) {
          throw new OptimisticLockError(
            `Product ${item.productId} inventory has been modified by another user. Please refresh and try again.`,
            currentProductLocation.version,
            item.expectedVersion
          );
        }
      }

      // Validate stock if removing
      if (item.quantityChange < 0) {
        const validation = await validateStockAvailability(
          item.productId,
          item.locationId,
          Math.abs(item.quantityChange),
          tx
        );

        if (!validation.isValid) {
          // Get product name for better error message
          const product = await tx.product.findUnique({
            where: { id: item.productId },
            select: { name: true }
          });
          
          if (!product) {
            throw new ProductNotFoundError(item.productId);
          }
          
          throw new InsufficientStockError(
            product.name,
            validation.currentQuantity,
            Math.abs(item.quantityChange)
          );
        }
      }

      // Create log entry
      const log = await createInventoryLog({
        userId: parseInt(userId),
        productId: item.productId,
        locationId: item.locationId,
        delta: item.quantityChange,
        logType: inventory_logs_logType.ADJUSTMENT,
      }, tx);

      // Update product_locations with version increment
      const updatedProductLocation = await tx.product_locations.upsert({
        where: {
          productId_locationId: {
            productId: item.productId,
            locationId: item.locationId,
          },
        },
        update: {
          quantity: {
            increment: item.quantityChange,
          },
          version: {
            increment: 1,
          },
        },
        create: {
          productId: item.productId,
          locationId: item.locationId,
          quantity: item.quantityChange,
          version: 1,
        },
      });

      versions[`${item.productId}-${item.locationId}`] = updatedProductLocation.version;

      // Update product quantity for location 1 (compatibility)
      if (item.locationId === 1) {
        await tx.product.update({
          where: { id: item.productId },
          data: { quantity: { increment: item.quantityChange } },
        });
      }

      logs.push(log);
    }

    return {
      transaction: {
        id: `txn_${Date.now()}`,
        type,
        status: 'COMPLETED',
        userId: parseInt(userId),
        metadata,
      },
      logs,
      versions,
    };
  });
}

/**
 * Helper to calculate quantity change (simplified)
 */
export function calculateQuantityChange(
  changeType: string,
  quantity: number
): number {
  // For the actual schema, we just use positive/negative deltas
  return quantity;
}