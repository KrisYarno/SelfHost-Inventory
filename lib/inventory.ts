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
import { v4 as uuidv4 } from 'uuid';

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
    transferId?: string;
    // Phase C (P-C1): nullable passthrough. reasonCode/unitCostCents give the row
    // its ledger meaning; batchId joins the row to its companion audit event.
    reasonCode?: string | null;
    unitCostCents?: number | null;
    batchId?: string | null;
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
      transferId: data.transferId ?? null,
      reasonCode: data.reasonCode ?? null,
      unitCostCents: data.unitCostCents ?? null,
      batchId: data.batchId ?? null,
    },
    // SECURITY: never `users: true` here — these rows are returned verbatim by
    // adjust/stock-in/transfer/batch-adjust responses, so a full User include
    // would ship passwordHash to the client. Field set mirrors
    // app/api/inventory/logs/route.ts (the proven table-rendering contract).
    include: {
      users: { select: { id: true, username: true, email: true } },
      products: { select: { id: true, name: true, baseName: true, variant: true } },
      locations: { select: { id: true, name: true } },
    }
  });
}

/**
 * Phase C (ER-C2): frozen-at-write unit-cost conversion, DRY across every writer
 * that stamps `unitCostCents` (stock-in route + graduation import Tasks 2/4 — they
 * MUST call this, never re-derive it).
 *
 * `costPrice` is a NULLABLE Decimal (Lane 6 / R-D3): NULL = cost unknown, an
 * explicit 0 = genuinely free. Both a NULL and a 0 yield null here (NULL truthfully
 * = no cost; a receipt frozen at "free" carries no representable unit cost either).
 * Negative is impossible in real data but defended (→ null). The signed-INT
 * `unitCostCents` column caps at 2147483647, i.e. a cost of 21474836.47; ABOVE that
 * we cannot represent the value, so we return null AND console.error — writing a
 * truncated number would be a lie (truthful-data).
 */
export function centsFromCostPrice(costPrice: Prisma.Decimal | number | null): number | null {
  if (costPrice === null) return null;
  const n = Number(costPrice);
  if (n > 21474836.47) {
    console.error(
      `centsFromCostPrice: costPrice ${n} exceeds the INT-cents bound (21474836.47); storing null instead of a truncated value`
    );
    return null;
  }
  return n > 0 ? Math.round(n * 100) : null;
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
    // Phase C (P-C1): pure passthrough into createInventoryLog — this hot path
    // adds no semantics of its own; callers decide the values.
    reasonCode?: string | null;
    unitCostCents?: number | null;
    batchId?: string | null;
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
    reasonCode,
    unitCostCents,
    batchId,
  } = args;

  // Create the log entry
  const log = await createInventoryLog(
    {
      userId,
      productId,
      locationId,
      delta,
      logType,
      reasonCode,
      unitCostCents,
      batchId,
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
  // Phase C (P-C4): trailing positionals converted to an options bag. The record
  // callback was the LAST of 7 positionals; adding 3 more (reasonCode/unitCostCents/
  // batchId) as positionals would be unreadable. The record callback is invoked with
  // the SAME `tx` as the stock write so recordChange joins the caller's transaction
  // and hard-aborts the mutation if the audit row cannot be written.
  opts?: {
    logType?: inventory_logs_logType;
    expectedVersion?: number;
    reasonCode?: string | null;
    unitCostCents?: number | null;
    batchId?: string | null;
    record?: (
      tx: Prisma.TransactionClient,
      result: { log: Awaited<ReturnType<typeof createInventoryLog>>; newVersion: number }
    ) => Promise<void>;
  }
) {
  const { logType, expectedVersion, reasonCode, unitCostCents, batchId, record } =
    opts ?? {};

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
          reasonCode,
          unitCostCents,
          batchId,
        });

        // Record the change inside the SAME transaction as the stock write.
        if (record) await record(tx, { log, newVersion });

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
  // Phase C (P-C1/P-C7): the caller's event batchId, stamped onto BOTH legs so
  // the audit event joins its ledger rows. transferId remains the precise leg-pair
  // key; batchId is the operation GROUP key (a batch transfer shares one batchId
  // across N events / 2N rows).
  batchId?: string | null;
  // Optional in-transaction recorder (change-tracking Task 8): invoked with the
  // SAME `tx` as both transfer legs' writes so recordChange joins this
  // transaction and hard-aborts the transfer if the audit row cannot be written.
  record?: (
    tx: Prisma.TransactionClient,
    result: { transferId: string; fromVersion: number; toVersion: number }
  ) => Promise<void>;
}) {
  const {
    userId,
    productId,
    fromLocationId,
    toLocationId,
    quantity,
    expectedFromVersion,
    expectedToVersion,
    batchId,
    record,
  } = options;

  if (fromLocationId === toLocationId) {
    throw new Error('Source and destination locations must be different.');
  }
  if (quantity <= 0) {
    throw new Error('Transfer quantity must be greater than zero.');
  }

  // One id per transfer: stamped on BOTH log rows so they pair exactly.
  const transferId = uuidv4();

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
              transferId,
              batchId,
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
              transferId,
              batchId,
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

        // Record the change inside the SAME transaction as both transfer legs.
        if (record) {
          await record(tx, {
            transferId,
            fromVersion: updatedFrom.version,
            toVersion: updatedTo.version,
          });
        }

        return {
          // Phase C (P-C7): expose transferId top-level so transfer/batch results
          // (built AFTER the record callback returns) can surface the leg-pair key.
          transferId,
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
  metadata?: Record<string, unknown>,
  // Optional in-transaction recorder (change-tracking Task 8): invoked with the
  // SAME `tx` as every item's stock write so recordChange joins this
  // transaction and hard-aborts the batch if the audit row cannot be written.
  record?: (
    tx: Prisma.TransactionClient,
    logs: Awaited<ReturnType<typeof createInventoryLog>>[]
  ) => Promise<void>,
  // Phase C (P-C1): NEW trailing options object (this path had none). opts.batchId
  // is threaded onto every ledger row so the companion audit event joins them.
  opts?: { batchId?: string | null }
) {
  const batchId = opts?.batchId ?? null;
  // Phase C (D6 / R-D18): the manual-order fulfillment path (deduct-simple ->
  // workbench complete-order) posts type "DEDUCTION" — the same business event as
  // an external-order sale, so it gets the SALE logType. Every other transaction
  // type keeps ADJUSTMENT (item.changeType is still not mapped).
  const logType =
    type === "DEDUCTION"
      ? inventory_logs_logType.SALE
      : inventory_logs_logType.ADJUSTMENT;

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

      // Apply the stock delta through the shared write core: log +
      // product_locations upsert (quantity/version increment) + loc-1
      // Product.quantity mirror — the same path adjust/stock-in/batch-adjust use.
      // Phase C (D6): logType is SALE for "DEDUCTION" (manual-order fulfillment)
      // and ADJUSTMENT otherwise — computed once above from `type`; item.changeType
      // is still not mapped. batchId (from opts) joins each row to its event.
      //
      // Concurrency note: the read-compare version guard above stays OUTSIDE
      // applyStockDelta and is UNCHANGED. Like createInventoryAdjustment, this
      // path's write is a commutative relative increment, for which read-compare
      // is the documented-safe idiom. Unlike createInventoryAdjustment, this path
      // intentionally has NO retry loop (single attempt) — that pre-existing
      // difference is preserved.
      const { log, newVersion } = await applyStockDelta(tx, {
        userId,
        productId: item.productId,
        locationId: item.locationId,
        delta: item.quantityChange,
        logType,
        batchId,
      });

      versions[`${item.productId}-${item.locationId}`] = newVersion;

      logs.push(log);
    }

    // Record the change inside the SAME transaction as the item stock writes.
    if (record) await record(tx, logs);

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

