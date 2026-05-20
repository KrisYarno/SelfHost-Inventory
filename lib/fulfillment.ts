import prisma from '@/lib/prisma';
import { Prisma, inventory_logs_logType } from '@prisma/client';
import { createInventoryLog } from '@/lib/inventory';
import { ProductNotFoundError } from '@/lib/error-handling';
import { BundleComponentSnapshotArraySchema } from '@/lib/validation/bundle-links';

/**
 * Fulfillment Item Interface
 */
export interface FulfillmentItem {
  itemId: string;        // ExternalOrderItem.id
  quantity: number;      // Quantity to fulfill
  productId?: number;    // Manual override for unmapped items
  skipUnmapped?: boolean;
}

/**
 * Fulfillment Result Interface
 */
export interface FulfillmentResult {
  fulfilled: Array<{
    itemId: string;
    productId: number;
    productName: string;
    quantity: number;
    inventoryLogId: number;
  }>;
  skipped: Array<{
    itemId: string;
    reason: 'unmapped' | 'insufficient_stock' | 'user_skipped' | 'already_fulfilled';
    details?: string;
  }>;
  failed: Array<{
    itemId: string;
    error: string;
  }>;
  inventoryLogIds: number[];
  // Amendment 5: External order info for fulfillment push
  externalId?: string;
  integrationId?: string;
  integrationPlatform?: string;
  // Amendment 7: Full order totals for completed vs processing determination
  totalQuantity?: number;
  totalFulfilled?: number;
  // P0-3: Component productIds deducted for bundle items (used to push bundle WC stock)
  affectedComponentIds?: number[];
}

/**
 * Per-component shortage detail for a bundle item.
 */
export interface BundleShortage {
  internalProductId: number;
  name: string;
  required: number;
  available: number;
}

/**
 * Validation Result Interface for pre-fulfillment checks
 */
export interface FulfillmentValidationResult {
  orderId: string;
  canFulfill: boolean;
  requiresAttention: boolean;
  items: Array<{
    itemId: string;
    name: string;
    variantName: string | null;
    sku: string | null;
    requestedQty: number;
    remainingQty: number;
    fulfilledQty: number;
    isMapped: boolean;
    mapping?: {
      productId: number;
      productName: string;
      availableByLocation: Array<{
        locationId: number;
        locationName: string;
        available: number;
      }>;
    };
    issues: string[];
    /** Populated for bundle items when one or more components have insufficient stock. */
    bundleShortages?: BundleShortage[];
  }>;
  suggestedLocationId?: number;
}

/**
 * Validates an order for fulfillment readiness
 */
export async function validateOrderFulfillment(
  orderId: string,
  locationId?: number
): Promise<FulfillmentValidationResult> {
  // Get order with items and product mappings (including bundle data for shortage detection)
  const order = await prisma.externalOrder.findUnique({
    where: { id: orderId },
    include: {
      items: {
        include: {
          productLink: {
            include: {
              internalProduct: true,
              bundleComponents: {
                orderBy: { sortOrder: 'asc' },
                include: {
                  internalProduct: {
                    select: { id: true, name: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!order) {
    throw new Error(`Order ${orderId} not found`);
  }

  const validationItems = [];
  let hasUnmappedItems = false;
  let hasStockIssues = false;

  // Validate each item
  for (const item of order.items) {
    const remainingQty = item.quantity - item.fulfilledQty;
    const issues: string[] = [];

    let mapping: FulfillmentValidationResult['items'][0]['mapping'] | undefined;

    let bundleShortages: BundleShortage[] | undefined;

    if (item.isMapped && item.productLink?.isBundle) {
      // --- Bundle path: check each component for stock ---
      type SnapshotComponent = {
        internalProductId: number;
        quantity: number;
        internalProductName?: string;
      };

      const rawSnapshot = (item as any).bundleComponentSnapshot;
      let components: SnapshotComponent[];

      if (rawSnapshot !== null && rawSnapshot !== undefined) {
        const parsed = BundleComponentSnapshotArraySchema.safeParse(rawSnapshot);
        if (!parsed.success) {
          // Malformed snapshot — treat as unfulfillable (no valid components)
          issues.push('malformed_snapshot');
          hasStockIssues = true;
          validationItems.push({
            itemId: item.id,
            name: item.name,
            variantName: (item as any).variantName ?? null,
            sku: item.sku,
            requestedQty: item.quantity,
            remainingQty,
            fulfilledQty: item.fulfilledQty,
            isMapped: item.isMapped,
            mapping: undefined,
            issues,
            bundleShortages: undefined,
          });
          continue;
        }
        components = parsed.data;
      } else {
        // null snapshot → fall back to live bundleComponents (Prisma-typed, no Zod needed)
        components = (item.productLink as any).bundleComponents?.map((c: any) => ({
          internalProductId: c.internalProductId,
          quantity: c.quantity,
          internalProductName: c.internalProduct?.name,
        })) ?? [];
      }

      const shortages: BundleShortage[] = [];

      for (const c of components) {
        const required = c.quantity * remainingQty;
        if (locationId) {
          const loc = await prisma.product_locations.findFirst({
            where: { productId: c.internalProductId, locationId },
          });
          const available = loc?.quantity ?? 0;
          if (available < required) {
            shortages.push({
              internalProductId: c.internalProductId,
              name: c.internalProductName ?? `Product ${c.internalProductId}`,
              required,
              available,
            });
          }
        } else {
          // No location specified: check total stock across all locations
          const allLocs = await prisma.product_locations.findMany({
            where: { productId: c.internalProductId },
          });
          const totalAvailable = allLocs.reduce((sum: number, l: { quantity: number }) => sum + l.quantity, 0);
          if (totalAvailable < required) {
            shortages.push({
              internalProductId: c.internalProductId,
              name: c.internalProductName ?? `Product ${c.internalProductId}`,
              required,
              available: totalAvailable,
            });
          }
        }
      }

      if (shortages.length > 0) {
        issues.push('insufficient_stock');
        bundleShortages = shortages;
        hasStockIssues = true;
      }
    } else if (item.isMapped && item.productLink?.internalProduct) {
      const product = item.productLink.internalProduct;

      // Get availability across all locations
      const productLocations = await prisma.product_locations.findMany({
        where: { productId: product.id },
        include: {
          locations: true,
        },
      });

      const availableByLocation = productLocations.map((pl) => ({
        locationId: pl.locationId,
        locationName: pl.locations.name,
        available: pl.quantity,
      }));

      mapping = {
        productId: product.id,
        productName: product.name,
        availableByLocation,
      };

      // Check stock at requested location if provided
      if (locationId) {
        const locationStock = productLocations.find(
          (pl) => pl.locationId === locationId
        );
        const available = locationStock?.quantity || 0;

        if (available < remainingQty) {
          issues.push(
            `Insufficient stock at selected location (available: ${available}, needed: ${remainingQty})`
          );
          hasStockIssues = true;
        }
      } else {
        // Check if sufficient stock exists anywhere
        const totalStock = availableByLocation.reduce(
          (sum, loc) => sum + loc.available,
          0
        );
        if (totalStock < remainingQty) {
          issues.push(
            `Insufficient total stock (available: ${totalStock}, needed: ${remainingQty})`
          );
          hasStockIssues = true;
        }
      }
    } else {
      issues.push('Item is not mapped to an internal product');
      hasUnmappedItems = true;
    }

    if (remainingQty <= 0) {
      issues.push('Item is already fully fulfilled');
    }

    validationItems.push({
      itemId: item.id,
      name: item.name,
      variantName: (item as any).variantName ?? null,
      sku: item.sku,
      requestedQty: item.quantity,
      remainingQty,
      fulfilledQty: item.fulfilledQty,
      isMapped: item.isMapped,
      mapping,
      issues,
      bundleShortages,
    });
  }

  // Suggest a location with best overall stock
  let suggestedLocationId: number | undefined;
  if (!locationId && !hasUnmappedItems) {
    const locationScores = new Map<number, number>();

    for (const item of validationItems) {
      if (item.mapping) {
        for (const loc of item.mapping.availableByLocation) {
          const canFulfill = loc.available >= item.remainingQty ? 1 : 0;
          locationScores.set(
            loc.locationId,
            (locationScores.get(loc.locationId) || 0) + canFulfill
          );
        }
      }
    }

    if (locationScores.size > 0) {
      const bestLocation = Array.from(locationScores.entries()).sort(
        (a, b) => b[1] - a[1]
      )[0];
      suggestedLocationId = bestLocation[0];
    }
  }

  return {
    orderId: order.id,
    canFulfill: !hasStockIssues && !hasUnmappedItems,
    requiresAttention: hasUnmappedItems || hasStockIssues,
    items: validationItems,
    suggestedLocationId,
  };
}

/**
 * Fulfills an external order by deducting inventory and updating order status
 */
export async function fulfillExternalOrder(
  orderId: string,
  locationId: number,
  items: FulfillmentItem[],
  userId: number,
  _notes?: string
): Promise<FulfillmentResult> {
  const result: FulfillmentResult = {
    fulfilled: [],
    skipped: [],
    failed: [],
    inventoryLogIds: [],
    affectedComponentIds: [],
  };

  return await prisma.$transaction(
    async (tx) => {
      // Get order with items and integration (Amendment 5: need integration for push)
      const order = await tx.externalOrder.findUnique({
        where: { id: orderId },
        include: {
          integration: {
            select: {
              id: true,
              platform: true,
              fulfillmentPushEnabled: true,
            },
          },
          items: {
            include: {
              productLink: {
                include: {
                  internalProduct: true,
                  bundleComponents: {
                    orderBy: { sortOrder: 'asc' },
                  },
                },
              },
            },
          },
        },
      });

      if (!order) {
        throw new Error(`Order ${orderId} not found`);
      }

      // Amendment 5: Populate external order info for fulfillment push
      result.externalId = order.externalId;
      result.integrationId = order.integrationId;
      result.integrationPlatform = order.integration.platform;

      // Process each fulfillment item
      for (const fulfillmentItem of items) {
        try {
          // Find the order item
          const orderItem = order.items.find(
            (item) => item.id === fulfillmentItem.itemId
          );

          if (!orderItem) {
            result.failed.push({
              itemId: fulfillmentItem.itemId,
              error: 'Item not found in order',
            });
            continue;
          }

          // Check if already fully fulfilled
          const remainingQty = orderItem.quantity - orderItem.fulfilledQty;
          if (remainingQty <= 0) {
            result.skipped.push({
              itemId: fulfillmentItem.itemId,
              reason: 'already_fulfilled',
              details: 'Item is already fully fulfilled',
            });
            continue;
          }

          // Ensure we don't over-fulfill
          const quantityToFulfill = Math.min(
            fulfillmentItem.quantity,
            remainingQty
          );

          // Bundle path: isBundle=true → expand into per-component deductions (D7)
          if (orderItem.isMapped && orderItem.productLink?.isBundle) {
            type SnapshotComponent = {
              internalProductId: number;
              quantity: number;
              internalProductName?: string;
            };

            // D7: prefer frozen snapshot; fall back to live bundleComponents for legacy rows.
            // Zod-validate the snapshot when present to fail-closed on DB corruption.
            const rawSnapshot = orderItem.bundleComponentSnapshot;
            let components: SnapshotComponent[];

            if (rawSnapshot !== null && rawSnapshot !== undefined) {
              const parsed = BundleComponentSnapshotArraySchema.safeParse(rawSnapshot);
              if (!parsed.success) {
                result.skipped.push({
                  itemId: fulfillmentItem.itemId,
                  reason: 'unmapped',
                  details: `Bundle item ${orderItem.id} has malformed bundleComponentSnapshot: ${parsed.error.errors[0]?.message ?? 'invalid format'}`,
                });
                continue;
              }
              components = parsed.data;
            } else {
              // null snapshot → fall back to live bundleComponents (Prisma-typed, no Zod needed)
              components = orderItem.productLink.bundleComponents as SnapshotComponent[];
            }

            if (!components || components.length === 0) {
              result.failed.push({
                itemId: fulfillmentItem.itemId,
                error: `Bundle item ${orderItem.id} has no components in snapshot or live mapping`,
              });
              continue;
            }

            // Pre-flight stock check: verify ALL components have sufficient stock
            // before making any deductions. This prevents partial deductions where
            // the first N-1 components succeed and component N fails, leaving
            // inventory permanently decremented with no way to recover without a
            // manual correction.
            let preflightFailed = false;
            for (const component of components) {
              const deductQty = component.quantity * quantityToFulfill;
              const stockRow = await tx.product_locations.findUnique({
                where: {
                  productId_locationId: {
                    productId: component.internalProductId,
                    locationId,
                  },
                },
                select: { quantity: true },
              });
              const available = stockRow?.quantity ?? 0;
              if (available < deductQty) {
                result.skipped.push({
                  itemId: fulfillmentItem.itemId,
                  reason: 'insufficient_stock',
                  details: `Insufficient stock for bundle component (productId: ${component.internalProductId}). Available: ${available}, Requested: ${deductQty}`,
                });
                preflightFailed = true;
                break;
              }
            }

            if (preflightFailed) continue;

            // All components have sufficient stock — now deduct each one.
            for (const component of components) {
              const deductQty = component.quantity * quantityToFulfill;

              await tx.$executeRaw(Prisma.sql`
                UPDATE product_locations
                SET quantity = quantity - ${deductQty},
                    version = version + 1,
                    updatedAt = NOW()
                WHERE productId = ${component.internalProductId}
                  AND locationId = ${locationId}
                  AND quantity >= ${deductQty}
              `);

              await createInventoryLog(
                {
                  userId,
                  productId: component.internalProductId,
                  locationId,
                  delta: -deductQty,
                  logType: inventory_logs_logType.ADJUSTMENT,
                },
                tx
              );

              // Legacy products.quantity mirror for location 1
              if (locationId === 1) {
                await tx.$executeRaw(Prisma.sql`
                  UPDATE products
                  SET quantity = quantity - ${deductQty}
                  WHERE id = ${component.internalProductId}
                `);
              }
            }

            // Update ExternalOrderItem.fulfilledQty
            await tx.externalOrderItem.update({
              where: { id: fulfillmentItem.itemId },
              data: { fulfilledQty: { increment: quantityToFulfill } },
            });

            result.fulfilled.push({
              itemId: fulfillmentItem.itemId,
              productId: -1, // Bundle — no single productId
              productName: orderItem.name,
              quantity: quantityToFulfill,
              inventoryLogId: -1, // Multiple logs created; use sentinel
            });

            // P0-3: Accumulate component IDs so the route can push bundle WC stock
            for (const component of components) {
              if (!result.affectedComponentIds!.includes(component.internalProductId)) {
                result.affectedComponentIds!.push(component.internalProductId);
              }
            }

            continue; // Skip the single-mapping path below
          }

          // Determine which product to use
          let productId: number | undefined;

          if (fulfillmentItem.productId) {
            // Manual override provided
            productId = fulfillmentItem.productId;
          } else if (orderItem.isMapped && orderItem.productLink?.internalProduct) {
            // Use mapped product — internalProduct is non-null in this (non-bundle) branch
            productId = orderItem.productLink.internalProduct!.id;
          } else if (fulfillmentItem.skipUnmapped) {
            // User chose to skip this unmapped item
            result.skipped.push({
              itemId: fulfillmentItem.itemId,
              reason: 'user_skipped',
              details: 'Item is unmapped and user chose to skip',
            });
            continue;
          } else {
            // Not mapped and no override
            result.skipped.push({
              itemId: fulfillmentItem.itemId,
              reason: 'unmapped',
              details: 'Item is not mapped to an internal product',
            });
            continue;
          }

          // Get product info first (for error messages and existence check)
          const product = await tx.product.findUnique({
            where: { id: productId },
            select: { name: true },
          });

          if (!product) {
            throw new ProductNotFoundError(productId);
          }

          // Atomic decrement with stock check. This single UPDATE both validates
          // that sufficient stock exists and decrements it in one statement.
          // Race-safe: two concurrent transactions cannot both succeed because
          // the WHERE clause is evaluated against the committed row at UPDATE time.
          const affectedRows = await tx.$executeRaw(Prisma.sql`
            UPDATE product_locations
            SET quantity = quantity - ${quantityToFulfill},
                version = version + 1,
                updatedAt = NOW()
            WHERE productId = ${productId}
              AND locationId = ${locationId}
              AND quantity >= ${quantityToFulfill}
          `);

          if (affectedRows === 0) {
            // Either the row doesn't exist or insufficient stock. Read the current
            // state for the error message (best-effort — may still race but the
            // actual deduction already declined).
            const currentRow = await tx.product_locations.findUnique({
              where: { productId_locationId: { productId, locationId } },
              select: { quantity: true },
            });

            result.skipped.push({
              itemId: fulfillmentItem.itemId,
              reason: 'insufficient_stock',
              details: `Insufficient stock for ${product.name}. Available: ${currentRow?.quantity ?? 0}, Requested: ${quantityToFulfill}`,
            });
            continue;
          }

          // Create inventory log (deduction) — only after the atomic UPDATE succeeded
          const log = await createInventoryLog(
            {
              userId,
              productId,
              locationId,
              delta: -quantityToFulfill,
              logType: inventory_logs_logType.ADJUSTMENT,
            },
            tx
          );

          // Legacy product.quantity mirror for location 1. This is a derived
          // value that should track product_locations[productId, 1].quantity.
          // No stock guard here: the authoritative check already happened in
          // the product_locations UPDATE above, and the mirror must track
          // the source of truth even if that means going temporarily negative
          // during a concurrent race. Removing the guard also prevents silent
          // desync when another code path has already decremented the mirror.
          if (locationId === 1) {
            await tx.$executeRaw(Prisma.sql`
              UPDATE products
              SET quantity = quantity - ${quantityToFulfill}
              WHERE id = ${productId}
            `);
          }

          // Update ExternalOrderItem.fulfilledQty
          await tx.externalOrderItem.update({
            where: { id: fulfillmentItem.itemId },
            data: {
              fulfilledQty: {
                increment: quantityToFulfill,
              },
            },
          });

          result.fulfilled.push({
            itemId: fulfillmentItem.itemId,
            productId,
            productName: product.name,
            quantity: quantityToFulfill,
            inventoryLogId: log.id,
          });

          result.inventoryLogIds.push(log.id);
        } catch (error) {
          console.error(
            `Error fulfilling item ${fulfillmentItem.itemId}:`,
            error
          );
          result.failed.push({
            itemId: fulfillmentItem.itemId,
            error:
              error instanceof Error ? error.message : 'Unknown error occurred',
          });
        }
      }

      // Update order status
      const allItemsFulfilled = await tx.externalOrderItem.findMany({
        where: { orderId: order.id },
        select: {
          quantity: true,
          fulfilledQty: true,
        },
      });

      const totalQuantity = allItemsFulfilled.reduce(
        (sum, item) => sum + item.quantity,
        0
      );
      const totalFulfilled = allItemsFulfilled.reduce(
        (sum, item) => sum + item.fulfilledQty,
        0
      );

      // stockedOut separation: fulfill writes stockedOut (inventory deduction
      // truth) but NEVER writes internalStatus (that's WC's domain, set only
      // by webhooks/sync/recheck). Any deduction = stocked out.
      const isFullyStockedOut = totalFulfilled >= totalQuantity;
      const now = new Date();

      await tx.externalOrder.update({
        where: { id: orderId },
        data: {
          stockedOut: totalFulfilled > 0,
          stockedOutAt: totalFulfilled > 0 ? now : null,
          stockedOutBy: totalFulfilled > 0 ? userId : null,
          // Keep fulfilledAt/fulfilledBy for audit trail on full deduction
          fulfilledAt: isFullyStockedOut ? now : order.fulfilledAt,
          fulfilledBy: isFullyStockedOut ? userId : order.fulfilledBy,
        },
      });

      // Amendment 7: Include full order totals for completed vs processing check
      result.totalQuantity = totalQuantity;
      result.totalFulfilled = totalFulfilled;

      return result;
    },
    {
      timeout: 30000, // 30 second timeout for fulfillment transaction
    }
  );
}
