import prisma from '@/lib/prisma';
import { 
  inventory_logs_logType,
  Prisma
} from '@prisma/client';
import type {
  StockValidation
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
 * Applies a single stock delta inside an existing transaction.
 *
 * Performs, in this exact order, the write block shared by every stock route:
 *   1. createInventoryLog(..., tx)
 *   2. tx.product_locations.upsert (increment quantity + version, or create at version 1)
 *   3. if locationId === 1, tx.product.update to mirror the legacy Product.quantity field
 *
 * Extracted verbatim from createInventoryAdjustment so the same write path can be
 * reused (e.g. by pre-staging graduation/decline) without duplicating logic.
 *
 * Note: although future callers (graduation/decline) only need fire-and-forget
 * semantics (Promise<void>), createInventoryAdjustment relies on the created log row
 * and the resulting version. Returning them here lets the delegating caller preserve
 * its exact `{ log, newVersion }` contract WITHOUT issuing any extra Prisma reads —
 * behavior preservation is the priority. Callers that don't need the result simply
 * `await applyStockDelta(...)` and ignore the return.
 */
export async function applyStockDelta(
  tx: Prisma.TransactionClient,
  args: {
    userId: number;
    productId: number;
    locationId: number;
    delta: number;
    logType?: inventory_logs_logType;
  }
): Promise<{
  log: Awaited<ReturnType<typeof createInventoryLog>>;
  newVersion: number;
}> {
  const {
    userId,
    productId,
    locationId,
    delta,
    logType = inventory_logs_logType.ADJUSTMENT,
  } = args;

  // Create the log entry
  const log = await createInventoryLog(
    {
      userId,
      productId,
      locationId,
      delta,
      logType,
    },
    tx
  );

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
}

/**
 * Retries `fn` when the underlying transaction fails with a deadlock /
 * lock-wait-timeout, using a small linear backoff. Used by the pre-staging
 * graduation/decline flows that contend on the same product_locations rows.
 */
const DEADLOCK_CODES = new Set(['P2034']);
export async function withDeadlockRetry<T>(
  fn: () => Promise<T>,
  attempts = 3
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const code = e?.code ?? '';
      const msg = String(e?.message ?? '');
      if (DEADLOCK_CODES.has(code) || /deadlock|lock wait timeout/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 50 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * Creates an inventory adjustment and updates product_locations with optimistic locking
 */
export async function createInventoryAdjustment(
  userId: number,
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

        // Apply the stock delta: log + product_locations upsert + loc-1 mirror.
        // Extracted to applyStockDelta; preserves the exact same Prisma call
        // sequence (createInventoryLog -> upsert -> conditional product.update).
        const { log, newVersion } = await applyStockDelta(tx, {
          userId,
          productId,
          locationId,
          delta,
          logType,
        });

        return {
          log,
          newVersion,
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
 * Atomically transfer quantity between two locations with optimistic locking
 */
export async function createInventoryTransfer(options: {
  userId: number;
  productId: number;
  fromLocationId: number;
  toLocationId: number;
  quantity: number;
  expectedFromVersion?: number;
  expectedToVersion?: number;
}) {
  const {
    userId,
    productId,
    fromLocationId,
    toLocationId,
    quantity,
    expectedFromVersion,
    expectedToVersion,
  } = options;

  if (fromLocationId === toLocationId) {
    throw new Error('Source and destination locations must be different.');
  }
  if (quantity <= 0) {
    throw new Error('Transfer quantity must be greater than zero.');
  }

  const maxRetries = 3;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      return await prisma.$transaction(async (tx) => {
        // Load current rows for optimistic checks
        const [fromRow, toRow] = await Promise.all([
          tx.product_locations.findUnique({
            where: { productId_locationId: { productId, locationId: fromLocationId } },
          }),
          tx.product_locations.findUnique({
            where: { productId_locationId: { productId, locationId: toLocationId } },
          }),
        ]);

        // Version checks if provided
        if (expectedFromVersion !== undefined && fromRow) {
          if (fromRow.version !== expectedFromVersion) {
            throw new OptimisticLockError(
              'Source location inventory was modified by another user.',
              fromRow.version,
              expectedFromVersion
            );
          }
        }
        if (expectedToVersion !== undefined && toRow) {
          if (toRow.version !== expectedToVersion) {
            throw new OptimisticLockError(
              'Destination location inventory was modified by another user.',
              toRow.version,
              expectedToVersion
            );
          }
        }

        // Validate availability at source within transaction
        const availability = await validateStockAvailability(
          productId,
          fromLocationId,
          quantity,
          tx
        );
        if (!availability.isValid) {
          const product = await tx.product.findUnique({ where: { id: productId }, select: { name: true } });
          if (!product) {
            throw new ProductNotFoundError(productId);
          }
          throw new InsufficientStockError(
            product.name,
            availability.currentQuantity,
            availability.requestedQuantity
          );
        }

        // Create two TRANSFER logs
        const [fromLog, toLog] = await Promise.all([
          createInventoryLog(
            {
              userId,
              productId,
              locationId: fromLocationId,
              delta: -quantity,
              logType: inventory_logs_logType.TRANSFER,
            },
            tx
          ),
          createInventoryLog(
            {
              userId,
              productId,
              locationId: toLocationId,
              delta: quantity,
              logType: inventory_logs_logType.TRANSFER,
            },
            tx
          ),
        ]);

        // Decrement source (must exist after validation)
        const updatedFrom = await tx.product_locations.upsert({
          where: { productId_locationId: { productId, locationId: fromLocationId } },
          update: {
            quantity: { decrement: quantity },
            version: { increment: 1 },
          },
          create: {
            productId,
            locationId: fromLocationId,
            quantity: 0,
            version: 1,
          },
        });

        // Increment destination (create if needed)
        const updatedTo = await tx.product_locations.upsert({
          where: { productId_locationId: { productId, locationId: toLocationId } },
          update: {
            quantity: { increment: quantity },
            version: { increment: 1 },
          },
          create: {
            productId,
            locationId: toLocationId,
            quantity,
            version: 1,
          },
        });

        // Maintain Product.quantity legacy semantics for location 1
        if (fromLocationId === 1) {
          await tx.product.update({ where: { id: productId }, data: { quantity: { decrement: quantity } } });
        }
        if (toLocationId === 1) {
          await tx.product.update({ where: { id: productId }, data: { quantity: { increment: quantity } } });
        }

        return {
          logs: { from: fromLog, to: toLog },
          fromVersion: updatedFrom.version,
          toVersion: updatedTo.version,
        };
      });
    } catch (error) {
      if (error instanceof OptimisticLockError && retryCount < maxRetries - 1) {
        retryCount++;
        await new Promise((resolve) => setTimeout(resolve, 100 * retryCount));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Max retries exceeded for inventory transfer.');
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
  userId: number,
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
        userId,
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
        userId,
        metadata,
      },
      logs,
      versions,
    };
  });
}

