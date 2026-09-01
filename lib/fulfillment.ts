import prisma from '@/lib/prisma';
import { Prisma, inventory_logs_logType } from '@prisma/client';
import { createInventoryLog } from '@/lib/inventory';
import {
  MAX_PRELOCK_KEYS,
  prelockKey,
  prelockProductLocations,
  type PrelockKeyInput,
  type PrelockedRow,
} from '@/lib/inventory/prelock';
import { AppError, ProductNotFoundError } from '@/lib/error-handling';
import {
  BUNDLE_SENTINEL_PRODUCT_ID,
  BUNDLE_SENTINEL_INVENTORY_LOG_ID,
} from '@/lib/external-orders/constants';
import { resolveBundleComponents } from '@/lib/external-orders/bundle-snapshot';

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
    /** P0 #6: For bundle items, the component productIds deducted for THIS item.
     * Routes use this to expose a clean public shape without leaking the
     * BUNDLE_SENTINEL_PRODUCT_ID (-1) into client responses. */
    componentIds?: number[];
    /** True when this entry represents a bundle (productId is the sentinel). */
    isBundle?: boolean;
  }>;
  skipped: Array<{
    itemId: string;
    reason:
      | 'unmapped'
      | 'insufficient_stock'
      | 'user_skipped'
      | 'already_fulfilled'
      /**
       * NEVER produced from P2-B1.5 on: every key a fulfil writes is X-held
       * from the prelock to commit, so there is no race left to report. The
       * member stays because removing it would be a type change for a consumer
       * that switches on it.
       */
      | 'concurrent_modification'
      | 'malformed_snapshot';
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
      // FIX G: use the shared resolver — Zod parse + normalize + fallback.
      const resolved = resolveBundleComponents(
        item.bundleComponentSnapshot,
        item.productLink.bundleComponents,
      );

      if (!resolved.ok) {
        if (resolved.reason === 'malformed_snapshot') {
          issues.push('malformed_snapshot');
        } else {
          // resolved.reason === 'empty'
          issues.push('Bundle has no components in snapshot or live mapping — cannot fulfill');
        }
        hasStockIssues = true;
        validationItems.push({
          itemId: item.id,
          name: item.name,
          variantName: item.variantName ?? null,
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

      const components = resolved.components;

      const shortages: BundleShortage[] = [];

      // FIX D (P1 #4): Batch component stock reads into a single query per item.
      // Previously this loop did N round-trips (findFirst/findMany per component).
      const itemComponentIds = components.map((c) => c.internalProductId);
      const stockByProductId = new Map<number, number>();

      if (locationId) {
        const rows = await prisma.product_locations.findMany({
          where: { productId: { in: itemComponentIds }, locationId },
          select: { productId: true, quantity: true },
        });
        for (const r of rows) {
          stockByProductId.set(r.productId, r.quantity);
        }
      } else {
        // Sum across all locations per product.
        const rows = await prisma.product_locations.findMany({
          where: { productId: { in: itemComponentIds } },
          select: { productId: true, quantity: true },
        });
        for (const r of rows) {
          stockByProductId.set(
            r.productId,
            (stockByProductId.get(r.productId) ?? 0) + r.quantity
          );
        }
      }

      for (const c of components) {
        const required = c.quantity * remainingQty;
        const available = stockByProductId.get(c.internalProductId) ?? 0;
        if (available < required) {
          shortages.push({
            internalProductId: c.internalProductId,
            name: c.internalProductName ?? `Product ${c.internalProductId}`,
            required,
            available,
          });
        }
      }

      if (shortages.length > 0) {
        issues.push('insufficient_stock');
        bundleShortages = shortages;
        hasStockIssues = true;
      }
    } else if (item.isMapped && item.productLink?.internalProduct?.deletedAt != null) {
      // FD1-6: the PREVIEW agrees with the FULFIL about a soft-deleted product.
      // The include above is unfiltered, while the fulfil pass reads products
      // `deletedAt: null` (OC-5 below) so unfulfill can always put back what
      // fulfil took — so without this the line renders "ready" off live stock,
      // the operator confirms, and it comes back in `failed[]`: a refusal this
      // surface promised would not happen. No availability block either: there
      // is no product left for stock to be available AT.
      issues.push('Product no longer exists');
      hasStockIssues = true;
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
      variantName: item.variantName ?? null,
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
 * ONE item that SURVIVED pass 1 — decided, and owed exactly the stock it names
 * (pack CB1.5a-i.2; the unfulfill idiom, `unfulfill/route.ts`).
 *
 * Discriminated because the two branches spend different things: a single
 * mapping deducts its own product, a bundle deducts one row per COMPONENT (and
 * answers with the sentinel entry the public shape expects). Every quantity is
 * computed in pass 1, so the prelock between the passes can be built from the
 * survivors alone.
 *
 * EXPORTED for `planPass2`'s pins (the planner is module-internal otherwise).
 */
export type Survivor =
  | {
      kind: 'single';
      itemId: string;
      locationId: number;
      /** min(asked, remaining) — the over-fulfil clamp lives in pass 1. */
      productId: number;
      quantity: number;
    }
  | {
      kind: 'bundle';
      itemId: string;
      locationId: number;
      orderItemName: string;
      quantity: number;
      /** `deductQty` = component.quantity × quantity; component order kept. */
      components: Array<{ productId: number; deductQty: number }>;
    };

/** A survivor whose guard PASSED in pass 2a — carrying the name its result entry needs. */
export type Winner = Survivor & { productName: string };

/**
 * I0 — ONE LINE, ONCE (pack CB1.5a-i.1). Pass 1 computes `remaining` from the
 * ONE order this transaction loaded and pass 2b's `fulfilledQty` increment is
 * unconditional, so a request naming the same line twice would over-fulfil it.
 * Refused before the transaction opens: zero statements. Neither dialog can send
 * one (both map over unique order lines) — this is a library contract, not a UI
 * case, and the schema does not require uniqueness.
 */
function assertNoDuplicateItemIds(items: FulfillmentItem[]): void {
  const seen = new Set<string>();
  items.forEach((item) => {
    if (seen.has(item.itemId)) {
      throw new AppError(
        'the same order line appears more than once in the request',
        'DUPLICATE_ITEM',
        400
      );
    }
    seen.add(item.itemId);
  });
}

/**
 * A key the prelock materialized is never absent from what it returns, so this
 * is a belt, never a branch a test can reach (the `lib/inventory.ts` spelling of
 * the same rule — module-private there, so it is spelled once more here rather
 * than widening that module's surface).
 */
const NEVER_STOCKED = { quantity: 0, version: 0 };

/**
 * PASS 2a — THE GUARDS, over a SIMULATION of the within-tx tally (pack
 * CB1.5a-i.2; the two-loop idiom of `createInventoryTransaction` and
 * batch-adjust, with ONE stated difference: those THROW on a refusal, fulfil
 * SKIPS the refused survivor and lets the winners proceed).
 *
 * Pure, and EXPORTED so the shape can be pinned directly: guards issue no
 * statements, so a statement-order pin cannot tell this two-loop from an
 * interleaved decide-then-write. It has exactly ONE call site (pinned).
 *
 * The tally is seeded from the prelock's returned rows — the values every guard
 * compares against (spec REV-13 §2.7(3), for BOTH fulfil paths now) — and is
 * advanced per PASSED survivor, so a later survivor naming the same key is
 * guarded against what an earlier one WILL write. A refusal quotes that locked,
 * current number (QB-9) and spends nothing.
 */
export function planPass2(
  survivors: Survivor[],
  locked: ReadonlyMap<string, PrelockedRow>,
  namesById: ReadonlyMap<number, string>
): { winners: Winner[]; skipped: FulfillmentResult['skipped'] } {
  const tally = new Map<string, { quantity: number; version: number }>();
  locked.forEach((row, key) => tally.set(key, { quantity: row.quantity, version: row.version }));

  const winners: Winner[] = [];
  const skipped: FulfillmentResult['skipped'] = [];

  survivors.forEach((survivor) => {
    // The units this survivor REQUIRES per key: one entry for a single, and for
    // a bundle one per component — SUMMED, because a bundle naming one product
    // in two components spends that key twice.
    const keys: string[] = [];
    const units = new Map<string, number>();
    const productIdByKey = new Map<string, number>();
    const requireUnits = (productId: number, quantity: number) => {
      const key = prelockKey(productId, survivor.locationId);
      if (!units.has(key)) {
        keys.push(key);
        units.set(key, 0);
        productIdByKey.set(key, productId);
      }
      units.set(key, units.get(key)! + quantity);
    };
    if (survivor.kind === 'bundle') {
      survivor.components.forEach((component) =>
        requireUnits(component.productId, component.deductQty)
      );
    } else {
      requireUnits(survivor.productId, survivor.quantity);
    }

    let refusal: string | null = null;
    for (const key of keys) {
      const current = tally.get(key) ?? NEVER_STOCKED;
      const needed = units.get(key)!;
      if (current.quantity < needed) {
        // Today's texts; the NUMBER is the tally's, which is the locked truth.
        refusal =
          survivor.kind === 'bundle'
            ? `Insufficient stock for bundle component (productId: ${productIdByKey.get(key)}). Available: ${current.quantity}, Requested: ${needed}`
            : `Insufficient stock for ${namesById.get(survivor.productId) ?? ''}. Available: ${current.quantity}, Requested: ${needed}`;
        break; // the FIRST short key wins
      }
    }

    if (refusal !== null) {
      // NO stock / ledger / fulfilledQty statement is spent on a refusal.
      skipped.push({
        itemId: survivor.itemId,
        reason: 'insufficient_stock',
        details: refusal,
      });
      return;
    }

    keys.forEach((key) => {
      const current = tally.get(key) ?? NEVER_STOCKED;
      tally.set(key, {
        quantity: current.quantity - units.get(key)!,
        version: current.version + 1,
      });
    });

    winners.push({
      ...survivor,
      // A bundle names its ORDER LINE; a single carries the name the batched
      // `products` read returned (the `??` is the same belt as above — every
      // survivor whose id that read did not answer was already dropped).
      productName:
        survivor.kind === 'bundle'
          ? survivor.orderItemName
          : namesById.get(survivor.productId) ?? '',
    });
  });

  return { winners, skipped };
}

/**
 * Fulfills an external order by deducting inventory and updating order status
 */
export async function fulfillExternalOrder(
  orderId: string,
  locationId: number,
  items: FulfillmentItem[],
  userId: number,
  _notes?: string,
  /**
   * Task 12 (change-tracking): same-transaction change-capture seam. The route
   * supplies an ORDER-scoped `recordChange` closure; we invoke it INSIDE this
   * function's deduction transaction (after all deductions + the order-status
   * write, before commit) so an unrecordable fulfillment never commits (spec
   * R-D2). The deduction tx lives here — this is the only place same-tx capture
   * is possible, since a route-level wrap would spawn a separate nested tx.
   */
  record?: (
    tx: Prisma.TransactionClient,
    result: FulfillmentResult
  ) => Promise<void>,
  /**
   * Phase C (P-C1/P-C2): the route's per-request event batchId. Stamped onto
   * BOTH deduction ledger rows (single + bundle-component) so each SALE row
   * joins the fulfillment audit event. NULL for callers that don't record.
   */
  batchId?: string | null,
  /**
   * Reconciliation Part 2 (spec §2.7(1), pack CB1a-ii.1): opts.lockFirst is the
   * ORDER lock, run as the transaction's FIRST act — before the order read, so
   * nothing this function reads predates it. Same shape as the three stock
   * primitives'; this path has no retry loop, so it runs once. Optional: a
   * caller that supplies nothing spends no extra statement.
   */
  opts?: {
    lockFirst?: (tx: Prisma.TransactionClient) => Promise<unknown>;
  }
): Promise<FulfillmentResult> {
  const result: FulfillmentResult = {
    fulfilled: [],
    skipped: [],
    failed: [],
    inventoryLogIds: [],
    affectedComponentIds: [],
  };

  // FIX H (P2): O(N) dedup for affectedComponentIds via Set scoped to this call.
  // Previously the loop did `if (!arr.includes(id)) arr.push(id)` per component,
  // which is O(M*C^2) overall (M items × C components × O(C) includes scan).
  const affectedComponentIdSet = new Set<number>();

  assertNoDuplicateItemIds(items);

  return await prisma.$transaction(
    async (tx) => {
      // The order lock is statement 1 — before the order read below, which is
      // this transaction's first consistent read.
      if (opts?.lockFirst) await opts.lockFirst(tx);

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

      // ---------------------------------------------------------------------
      // PASS 1 — DECIDE (pack CB1.5a-i.2). Every refusal that does not depend on
      // stock happens here, from the order this transaction loaded behind the
      // order lock, and NOTHING is written to `product_locations`. The one write
      // pass 1 makes is the bundle snapshot freeze (FIX B) — a write to
      // `external_order_items`, which does not disturb the lock order (unfulfill
      // writes the same table before ITS prelock).
      //
      // What comes out is the SURVIVORS, and with them the complete key set the
      // prelock has to cover — bundle COMPONENTS included, which is what retires
      // the B1 bundle-path exception (spec REV-13 §2.7(3)).
      // ---------------------------------------------------------------------
      const survivors: Survivor[] = [];

      for (const fulfillmentItem of items) {
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

        // Bundle path: isBundle=true → expand into per-component deductions (D7).
        // The bundle branch WINS over a manual override, as it always has.
        if (orderItem.isMapped && orderItem.productLink?.isBundle) {
          // FIX G: shared helper handles snapshot Zod parse + normalize + fallback.
          const resolved = resolveBundleComponents(
            orderItem.bundleComponentSnapshot,
            orderItem.productLink.bundleComponents,
          );

          if (!resolved.ok) {
            if (resolved.reason === 'malformed_snapshot') {
              result.skipped.push({
                itemId: fulfillmentItem.itemId,
                reason: 'malformed_snapshot',
                details: `Bundle item ${orderItem.id} has malformed bundleComponentSnapshot: ${resolved.detail}`,
              });
            } else {
              // 'empty' — no components in snapshot OR live mapping
              result.failed.push({
                itemId: fulfillmentItem.itemId,
                error: `Bundle item ${orderItem.id} has no components in snapshot or live mapping`,
              });
            }
            continue;
          }

          const components = resolved.components;

          // FIX B (P0): D7 invariant — every fulfilled bundle item must have a
          // frozen snapshot so unfulfill reads a stable composition. For legacy
          // items where the snapshot is null and we're falling back to the live
          // join rows, freeze the current composition NOW. Without this, a
          // bundle's components could be PATCHed between fulfill and unfulfill —
          // unfulfill would restore stock for components that were never
          // deducted.
          //
          // It PERSISTS across a pass-2a stock refusal (designed — W2S-1 kept it
          // on a SKIP too) and is rolled back by an abort, because the whole
          // request is one transaction now.
          if (resolved.source === 'live') {
            await tx.externalOrderItem.update({
              where: { id: orderItem.id },
              data: { bundleComponentSnapshot: components as unknown as Prisma.InputJsonValue },
            });
          }

          survivors.push({
            kind: 'bundle',
            itemId: fulfillmentItem.itemId,
            locationId,
            orderItemName: orderItem.name,
            quantity: quantityToFulfill,
            components: components.map((component) => ({
              productId: component.internalProductId,
              deductQty: component.quantity * quantityToFulfill,
            })),
          });

          continue; // Skip the single-mapping path below
        }

        // Determine which product to use: the manual override if one was sent,
        // else the mapped internal product.
        const productId = fulfillmentItem.productId
          ? fulfillmentItem.productId
          : orderItem.isMapped && orderItem.productLink?.internalProduct
            ? orderItem.productLink.internalProduct.id
            : undefined;

        if (productId === undefined) {
          if (fulfillmentItem.skipUnmapped) {
            // User chose to skip this unmapped item
            result.skipped.push({
              itemId: fulfillmentItem.itemId,
              reason: 'user_skipped',
              details: 'Item is unmapped and user chose to skip',
            });
          } else {
            // Not mapped and no override
            result.skipped.push({
              itemId: fulfillmentItem.itemId,
              reason: 'unmapped',
              details: 'Item is not mapped to an internal product',
            });
          }
          continue;
        }

        survivors.push({
          kind: 'single',
          itemId: fulfillmentItem.itemId,
          locationId,
          productId,
          quantity: quantityToFulfill,
        });
      }

      // ---------------------------------------------------------------------
      // THE PRODUCT READ — ONE consistent read of `products` (the named residual
      // outside the canonical order, spec §2.7), over every survivor id: a
      // single's product, and every bundle component.
      //
      // Why it exists at all: a manual override is a raw number from the request
      // and the prelock INSERT's foreign key would kill the WHOLE transaction
      // over one bad id (pack REV-22 F2). So the ids are proved first, and an id
      // this read does not return fails its item ITEM-LOCALLY — a `failed.push`,
      // never a throw: a throw here would 404 the whole request through the
      // ladder and discard the siblings. The message is CONSTRUCTED from the
      // class, never re-spelled.
      //
      // It also supplies the NAMES the result entries and the refusal texts
      // carry — the per-item `product.findUnique` retired with it.
      // ---------------------------------------------------------------------
      const survivorProductIds: number[] = [];
      const seenProductId = new Set<number>();
      const noteId = (productId: number) => {
        if (seenProductId.has(productId)) return;
        seenProductId.add(productId);
        survivorProductIds.push(productId);
      };
      survivors.forEach((survivor) => {
        if (survivor.kind === 'bundle') {
          survivor.components.forEach((component) => noteId(component.productId));
        } else {
          noteId(survivor.productId);
        }
      });

      // Zero survivors, no statement — the same rule the prelock keeps for an
      // empty key set, so an all-refused request still spends nothing.
      const existingProducts =
        survivorProductIds.length > 0
          ? await tx.product.findMany({
              // OC-5: `deletedAt: null`, because UNFULFILL refuses to restore a
              // soft-deleted product (`unfulfill/route.ts`, "not found or deleted
              // — stock not restored"). Without the filter fulfil deducts what no
              // undo can put back, and the workbench's all-or-nothing promise
              // breaks with no path home. A soft-deleted id is simply absent from
              // this answer, so its item takes the item-local `failed[]` path
              // below — the same sentence an unknown id gets, no new vocabulary.
              where: { id: { in: survivorProductIds }, deletedAt: null },
              select: { id: true, name: true },
            })
          : [];
      const namesById = new Map<number, string>();
      existingProducts.forEach((product) => namesById.set(product.id, product.name));

      // THE LOCATION, PROVED THE SAME WAY (OC-4). The prelock's INSERT fires
      // `fk_pl_location` as well as `fk_pl_product`, so an unknown `locationId`
      // — a raw number off the request, like a manual override — would die as
      // MySQL 1452 and take the WHOLE transaction with it, pass 1's snapshot
      // freezes included, reaching the wire as a generic 500. Unlike a product
      // id this is REQUEST-scoped: one location covers every item, so an absent
      // one refuses the whole request rather than failing an item. Zero
      // survivors, no statement — the rule the product read and the prelock keep.
      if (survivors.length > 0) {
        const location = await tx.location.findUnique({
          where: { id: locationId },
          select: { id: true },
        });
        if (!location) {
          throw new AppError(`Location ${locationId} not found`, 'LOCATION_NOT_FOUND', 400);
        }
      }

      const provenSurvivors: Survivor[] = [];
      survivors.forEach((survivor) => {
        // For a bundle, the FIRST absent component id names the whole item.
        const missing =
          survivor.kind === 'bundle'
            ? survivor.components
                .map((component) => component.productId)
                .find((productId) => !namesById.has(productId))
            : namesById.has(survivor.productId)
              ? undefined
              : survivor.productId;
        if (missing !== undefined) {
          result.failed.push({
            itemId: survivor.itemId,
            error: new ProductNotFoundError(missing).message,
          });
          return;
        }
        provenSurvivors.push(survivor);
      });

      // ---------------------------------------------------------------------
      // THE PRELOCK — every remaining survivor's keys, bundle COMPONENT keys
      // included, in the canonical order, before the first `product_locations`
      // X lock this request takes. Two requests naming the same rows in opposite
      // item order can no longer take them in opposite orders.
      // ---------------------------------------------------------------------
      const keys: PrelockKeyInput[] = [];
      provenSurvivors.forEach((survivor) => {
        if (survivor.kind === 'bundle') {
          survivor.components.forEach((component) =>
            keys.push({ productId: component.productId, locationId: survivor.locationId })
          );
        } else {
          keys.push({ productId: survivor.productId, locationId: survivor.locationId });
        }
      });

      // A bundle multiplies keys past the request's item count, so the request
      // schema's cap of 100 items does not bound this set on its own: the count
      // is checked here, against the prelock's own cap, and refused as a 400
      // rather than reaching the library's RangeError (an unhelpful 500). The
      // refusal aborts the transaction atomically — pass 1's freezes included.
      // The sentence is fulfil's OWN: no dialog can split a fulfil, so "split it"
      // would name a remedy that does not exist.
      const distinctKeys = new Set(
        keys.map((key) => prelockKey(key.productId, key.locationId))
      );
      if (distinctKeys.size > MAX_PRELOCK_KEYS) {
        throw new AppError(
          'this order needs more than 200 stock rows in one request and cannot be fulfilled in one pass',
          'TOO_MANY_KEYS',
          400
        );
      }

      // `prelockProductLocations` owns the dedupe and the canonical sort (one
      // owner per invariant), so the keys ride in as the survivors named them.
      // Empty keys → no statement (the prelock's own rule).
      const locked = await prelockProductLocations(tx, keys);

      // ---------------------------------------------------------------------
      // PASS 2a — THE GUARDS. Every survivor is decided against the within-tx
      // tally before this transaction writes any stock at all; the planner owns
      // the tally (it is built from `locked`, never by this caller).
      // ---------------------------------------------------------------------
      const { winners, skipped: stockRefusals } = planPass2(
        provenSurvivors,
        locked,
        namesById
      );
      // `skipped[]` is therefore in PASS order — pass-1 refusals first, stock
      // refusals after. The order is NOT contractual; envelope consumers select
      // by priority, never by index.
      stockRefusals.forEach((refusal) => result.skipped.push(refusal));

      // ---------------------------------------------------------------------
      // PASS 2b — THE WRITES, winners only, in request order. UNGUARDED by
      // design: every one follows its item's complete guard, and a throw here
      // (or anywhere after statement 1) propagates out of `$transaction` and
      // aborts the request. There is no per-item catch: a committed SALE row and
      // its item's `fulfilledQty` increment are ONE transaction by construction
      // (W2S-1's property, now structural).
      // ---------------------------------------------------------------------
      for (const winner of winners) {
        const deductions =
          winner.kind === 'bundle'
            ? winner.components.map((component) => ({
                productId: component.productId,
                units: component.deductQty,
              }))
            : [{ productId: winner.productId, units: winner.quantity }];

        let firstLogId = 0;
        for (const deduction of deductions) {
          const affectedRows = await tx.$executeRaw(Prisma.sql`
            UPDATE product_locations
            SET quantity = quantity - ${deduction.units},
                version = version + 1,
                updatedAt = NOW()
            WHERE productId = ${deduction.productId}
              AND locationId = ${winner.locationId}
              AND quantity >= ${deduction.units}
          `);

          // THE BACKSTOP. The `quantity >=` clause stays, but it is no longer
          // the guard: the row has been X-held since the prelock and the tally
          // said "enough", so 0 rows here is an impossibility (a zero-unit
          // component still bumps `version`, so 1 row is always reported), and a
          // 500 is the honest answer to one.
          if (affectedRows !== 1) {
            throw new Error(
              `fulfil invariant: locked row ${deduction.productId}:${winner.locationId} moved under the tally`
            );
          }

          const log = await createInventoryLog(
            {
              userId,
              productId: deduction.productId,
              locationId: winner.locationId,
              delta: -deduction.units,
              // Phase C (P-C2): a fulfillment deduction is a SALE; batchId joins
              // the row to the fulfillment audit event.
              logType: inventory_logs_logType.SALE,
              batchId,
              // W2-1 (pack T7 stamping): the order this sale belongs to, taken
              // from the transaction's own loaded order (path-addressed and
              // membership-checked by the route), never from the request body.
              orderRecordId: order.id,
            },
            tx
          );
          if (firstLogId === 0) firstLogId = log.id;

          // Legacy product.quantity mirror for location 1. This is a derived
          // value that should track product_locations[productId, 1].quantity.
          // No stock guard here: the authoritative check already happened, and
          // the mirror must track the source of truth.
          if (winner.locationId === 1) {
            await tx.$executeRaw(Prisma.sql`
              UPDATE products
              SET quantity = quantity - ${deduction.units}
              WHERE id = ${deduction.productId}
            `);
          }
        }

        // Update ExternalOrderItem.fulfilledQty. UNCONDITIONAL: the order lock
        // serializes every fulfil/unfulfill of this order ACROSS transactions,
        // and the DUPLICATE_ITEM guard makes each line appear once WITHIN this
        // request, so the loaded fulfilledQty is current for every increment. A
        // second guard AFTER the stock writes is exactly the late-failure shape
        // W2S-1 warned about.
        await tx.externalOrderItem.update({
          where: { id: winner.itemId },
          data: {
            fulfilledQty: {
              increment: winner.quantity,
            },
          },
        });

        if (winner.kind === 'bundle') {
          // Per-item component IDs for clean public response (Fix C P0 #6)
          result.fulfilled.push({
            itemId: winner.itemId,
            productId: BUNDLE_SENTINEL_PRODUCT_ID,
            productName: winner.productName,
            quantity: winner.quantity,
            inventoryLogId: BUNDLE_SENTINEL_INVENTORY_LOG_ID,
            isBundle: true,
            componentIds: winner.components.map((component) => component.productId),
          });

          // P0-3 + FIX H: accumulate component IDs into a Set scoped to this
          // call so the route can push bundle WC stock — O(1) per id.
          winner.components.forEach((component) =>
            affectedComponentIdSet.add(component.productId)
          );
        } else {
          result.fulfilled.push({
            itemId: winner.itemId,
            productId: winner.productId,
            productName: winner.productName,
            quantity: winner.quantity,
            inventoryLogId: firstLogId,
          });

          result.inventoryLogIds.push(firstLogId);
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

      // FIX H: materialize the deduplicated component-id Set into the result.
      result.affectedComponentIds = Array.from(affectedComponentIdSet);

      // Task 12: capture the ORDER change on THIS tx, after all deductions and
      // the order-status write, so a failed record aborts the fulfillment.
      if (record) {
        await record(tx, result);
      }

      return result;
    },
    {
      timeout: 30000, // 30 second timeout for fulfillment transaction
    }
  );
}
