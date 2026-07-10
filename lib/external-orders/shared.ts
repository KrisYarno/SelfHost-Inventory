import { decryptValue, isEncrypted } from "@/lib/encryption";
import { deriveExternalOrderMeta } from "@/lib/external-orders/meta";
import { AppError } from "@/lib/error-handling";
import { getPlatformAdapter } from "@/lib/platforms/core/registry";
import prisma from "@/lib/prisma";
import { diff } from "@/lib/change-tracking";
import type { ChangeDiff } from "@/lib/change-tracking";
import type { PlatformType, PlatformAdapter, NormalizedOrder } from "@/lib/platforms/core/types";
import type { Integration } from "@prisma/client";
import type { Prisma, PrismaClient } from "@prisma/client";

// ---------------------------------------------------------------------------
// deriveInternalStatus
// ---------------------------------------------------------------------------

export type InternalOrderStatus = "pending" | "processing" | "fulfilled" | "cancelled";

/**
 * Map platform-specific order statuses to a normalized internal status.
 * Extracted verbatim from the webhook handler.
 */
export function deriveInternalStatus(
  platform: PlatformType,
  order: {
    nativeStatus: string;
    financialStatus: string | null;
    fulfillmentStatus: string | null;
    rawPayload?: any;
  }
): InternalOrderStatus {
  if (platform === "WOOCOMMERCE") {
    const status = (order.nativeStatus || "").toLowerCase();
    if (status === "completed") return "fulfilled";
    if (status === "processing") return "processing";
    // `trash` and `trashed` are WC's soft-delete states. WC fires order.updated
    // when an order is moved to trash (NOT order.deleted, which only fires on
    // permanent/force delete). Treat trash as cancelled so the inventory side
    // surfaces the change instead of falling through to "pending".
    if (
      ["cancelled", "refunded", "failed", "trash", "trashed"].includes(status)
    )
      return "cancelled";
    return "pending";
  }

  // Shopify doesn't have a single canonical status; infer from raw fields.
  const fulfillment = (order.fulfillmentStatus || "").toLowerCase();
  const financial = (order.financialStatus || "").toLowerCase();
  const cancelledAt =
    (order.rawPayload as any)?.cancelled_at ??
    (order.rawPayload as any)?.cancelledAt;

  if (cancelledAt || financial === "voided" || financial === "refunded")
    return "cancelled";
  if (fulfillment === "fulfilled") return "fulfilled";
  if (financial === "paid" || financial === "partially_paid")
    return "processing";
  return "pending";
}

// reconcileStatus was removed: with the stockedOut separation, internalStatus
// is WC-only and can be freely overwritten by webhooks/sync/recheck. The old
// reconcileStatus was a band-aid to protect local fulfilled state from being
// overwritten. Now stockedOut handles that independently.

// ---------------------------------------------------------------------------
// decryptOrNull
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper around lib/encryption.
 * Returns null for null input, decrypts encrypted values, passes plaintext through.
 */
export function decryptOrNull(value: string | null): string | null {
  if (!value) return null;
  if (!isEncrypted(value)) return value;
  return decryptValue(value);
}

// ---------------------------------------------------------------------------
// hostFromStoreUrl
// ---------------------------------------------------------------------------

/**
 * Extract hostname from a store URL. Falls back to string parsing for URLs
 * without a protocol prefix. Returns empty string for truly invalid input.
 */
export function hostFromStoreUrl(url: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    // URL constructor failed — try stripping protocol-like prefix manually.
    const cleaned = url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return cleaned || "";
  }
}

// ---------------------------------------------------------------------------
// upsertOrderWithItems — discriminated union for status handling (Amendment 6)
// ---------------------------------------------------------------------------

type StatusCompute = { statusMode: "compute"; platform: PlatformType };
type StatusPreserve = { statusMode: "preserve"; internalStatus: string };
type StatusHandling = StatusCompute | StatusPreserve;

/**
 * Change summary returned by `upsertOrderWithItems`. Consumed by the webhook,
 * cron sync, and recheck callers to drive R-D4 ingestion recording — a change
 * event is written ONLY when `changed` is true (effective transition, not every
 * re-delivery). `itemsProcessed`/`itemsMapped` are PRESERVED from the historical
 * return shape (the recheck response contract depends on them).
 */
export interface OrderChangeSummary {
  /** true when the upsert took the create branch (no prior row). */
  created: boolean;
  /** created || material field diff || item-set change (the R-D4 gate). */
  changed: boolean;
  /** Material field changes only, from/to (normalized per ER-B1). */
  changes: ChangeDiff;
  /**
   * Rows removed by the stale-item cleanup, captured before the deleteMany
   * (R-D16). Note: `id` is the ExternalOrderItem cuid (String), not a number.
   */
  prunedItems: Array<{
    id: string;
    externalItemId: string | null;
    productLinkId: string | null;
  }>;
  /** ExternalOrder cuid. */
  orderId: string;
  orderNumber: string | null;
  itemsProcessed: number;
  itemsMapped: number;
}

type TransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export type UpsertOrderParams = {
  integrationId: string;
  companyId: string;
  storeUrl: string;
  normalized: NormalizedOrder;
  status: StatusHandling;
  /**
   * User-tier same-tx recording seam (P-B2, recheck). When present AND the
   * upsert produced an effective change, it is awaited with the SAME tx client
   * as the write, so an unrecordable user change aborts the whole upsert.
   * Machine paths (webhook/cron) do NOT use this — they record best-effort via
   * `recordIngestion` AFTER the returned summary instead.
   */
  onRecorded?: (
    tx: Prisma.TransactionClient,
    summary: OrderChangeSummary
  ) => Promise<void>;
};

/** A normalized, comparison-stable line item (ER-B1). */
type NormalizedItemRow = {
  externalItemId: string | null;
  quantity: number;
  unitPrice: string | null;
};

/**
 * Normalize an item set for diffing (ER-B1): money via String() (Prisma Decimal
 * never compares equal to a parsed number raw), nullish → null, sorted by a
 * stable key — `externalItemId` when present, else the `(name, quantity)` tuple
 * (the null-id findFirst-fallback rows carry no external identity).
 */
function normalizeOrderItems(
  items: Array<{
    externalItemId: string | null;
    quantity: number;
    price: unknown;
    name?: string | null;
  }>
): NormalizedItemRow[] {
  return items
    .map((i) => ({
      externalItemId: i.externalItemId ?? null,
      quantity: i.quantity,
      unitPrice:
        i.price === null || i.price === undefined ? null : String(i.price),
      _key:
        i.externalItemId ?? JSON.stringify([i.name ?? "", i.quantity]),
    }))
    .sort((a, b) => (a._key < b._key ? -1 : a._key > b._key ? 1 : 0))
    .map(({ _key, ...rest }) => rest);
}

/**
 * Atomically upsert an ExternalOrder and its line items.
 *
 * - Wraps the full operation in `prisma.$transaction` (Amendment 2).
 * - Uses discriminated union for status (Amendment 6): `compute` calls
 *   deriveInternalStatus; `preserve` keeps the provided value.
 * - When externalItemId is non-null, uses `tx.externalOrderItem.upsert()`
 *   on the `orderId_externalItemId` unique constraint (Amendment 3).
 *   When null, falls back to `findFirst` + create/update (Amendment 7).
 * - Auto-maps items via ProductLink lookup.
 * - Cleans up stale items whose externalItemId is no longer in the order.
 */
export async function upsertOrderWithItems(
  prismaClient: PrismaClient,
  params: UpsertOrderParams
): Promise<OrderChangeSummary> {
  const { integrationId, companyId, storeUrl, normalized, status, onRecorded } =
    params;

  return prismaClient.$transaction(
    async (tx: TransactionClient) => {
      // R-D4 gate (P-B3): read the before-image INSIDE the tx, before the
      // upsert, so the diff sees the material field set (nativeStatus,
      // financialStatus, fulfillmentStatus, internalStatus, total, currency,
      // customer, orderNumber) + the item set — not the write-only
      // externalStatusHash (which omits total/currency/customer/line-items).
      const beforeOrder = await tx.externalOrder.findUnique({
        where: {
          integrationId_externalId: {
            integrationId,
            externalId: normalized.externalId,
          },
        },
        select: {
          nativeStatus: true,
          financialStatus: true,
          fulfillmentStatus: true,
          internalStatus: true,
          total: true,
          currency: true,
          customerEmail: true,
          customerName: true,
          orderNumber: true,
          items: {
            select: {
              externalItemId: true,
              quantity: true,
              price: true,
              name: true,
            },
          },
        },
      });
      const created = beforeOrder === null || beforeOrder === undefined;

      // Determine internal status based on discriminated union
      const internalStatus =
        status.statusMode === "compute"
          ? deriveInternalStatus(status.platform, normalized)
          : status.internalStatus;

      const platform =
        status.statusMode === "compute"
          ? status.platform
          : (normalized.platform as PlatformType);

      // Derive meta fields (external URL, status hash, timestamps)
      const derivedMeta = deriveExternalOrderMeta({
        platform,
        storeUrl,
        externalId: normalized.externalId,
        normalized,
        rawPayload: normalized.rawPayload as any,
      });

      // Upsert the order itself
      const externalOrder = await tx.externalOrder.upsert({
        where: {
          integrationId_externalId: {
            integrationId,
            externalId: normalized.externalId,
          },
        },
        create: {
          companyId,
          integrationId,
          externalId: normalized.externalId,
          orderNumber: normalized.externalOrderNumber,
          nativeStatus: normalized.nativeStatus,
          financialStatus: normalized.financialStatus,
          fulfillmentStatus: normalized.fulfillmentStatus,
          platformStatusRaw:
            derivedMeta.platformStatusRaw as Prisma.InputJsonValue,
          externalStatusHash: derivedMeta.externalStatusHash,
          externalOrderUrl: derivedMeta.externalOrderUrl,
          total: normalized.total,
          currency: normalized.currency,
          customerEmail: normalized.customer?.email,
          customerName: normalized.customer?.name,
          rawPayload: normalized.rawPayload as Prisma.InputJsonValue,
          internalStatus,
          externalCreatedAt: normalized.createdAt,
          externalUpdatedAt: derivedMeta.externalUpdatedAt,
          lastSeenAt: derivedMeta.lastSeenAt,
        },
        update: {
          orderNumber: normalized.externalOrderNumber,
          nativeStatus: normalized.nativeStatus,
          financialStatus: normalized.financialStatus,
          fulfillmentStatus: normalized.fulfillmentStatus,
          platformStatusRaw:
            derivedMeta.platformStatusRaw as Prisma.InputJsonValue,
          externalStatusHash: derivedMeta.externalStatusHash,
          externalOrderUrl: derivedMeta.externalOrderUrl,
          total: normalized.total,
          currency: normalized.currency,
          customerEmail: normalized.customer?.email,
          customerName: normalized.customer?.name,
          rawPayload: normalized.rawPayload as Prisma.InputJsonValue,
          internalStatus,
          updatedAt: new Date(),
          externalCreatedAt: normalized.createdAt,
          externalUpdatedAt: derivedMeta.externalUpdatedAt,
          lastSeenAt: derivedMeta.lastSeenAt,
        },
      });

      // Process line items
      let itemsProcessed = 0;
      let itemsMapped = 0;
      const seenExternalItemIds = new Set<string>();

      for (const lineItem of normalized.lineItems) {
        if (lineItem.externalId) seenExternalItemIds.add(lineItem.externalId);

        // Auto-map via ProductLink
        let productLink = null;
        if (lineItem.externalProductId) {
          productLink = await tx.productLink.findFirst({
            where: {
              integrationId,
              externalProductId: lineItem.externalProductId,
              externalVariantId: lineItem.externalVariantId ?? null,
            },
          });

          // Auto-update externalTitle to track WC name changes. The mapping is
          // identified by IDs, but the displayed title stays current so admin
          // pages show the WC product's current name without manual re-mapping.
          // Per-item ExternalOrderItem.name remains frozen at the value WC sent
          // for THIS order (historical accuracy).
          if (productLink && lineItem.name) {
            const computedTitle = lineItem.variantName
              ? `${lineItem.name} — ${lineItem.variantName}`
              : lineItem.name;
            if (productLink.externalTitle !== computedTitle) {
              await tx.productLink.update({
                where: { id: productLink.id },
                data: { externalTitle: computedTitle },
              });
              productLink.externalTitle = computedTitle;
            }
          }
        }

        // D7: Build a point-in-time snapshot of bundle components at intake.
        // Only set on CREATE (never overwrite on UPDATE) to preserve immutability.
        // Prisma typed-input shape: omit the field (undefined) for non-bundles
        // so the column defaults to NULL; assign the array when this is a bundle.
        let bundleComponentSnapshot: Prisma.InputJsonValue | undefined = undefined;
        if (productLink?.isBundle) {
          const components = await tx.bundleComponent.findMany({
            where: { productLinkId: productLink.id },
            include: { internalProduct: { select: { name: true } } },
            orderBy: { sortOrder: "asc" },
          });
          bundleComponentSnapshot = components.map((c) => ({
            internalProductId: c.internalProductId,
            internalProductName: c.internalProduct.name,
            quantity: c.quantity,
            sortOrder: c.sortOrder,
          })) as unknown as Prisma.InputJsonValue;
        }

        const itemData = {
          name: lineItem.name,
          variantName: lineItem.variantName ?? null,
          sku: lineItem.sku,
          quantity: lineItem.quantity,
          price: lineItem.unitPrice,
          productLinkId: productLink?.id ?? null,
          isMapped: !!productLink,
        };

        if (lineItem.externalId) {
          // Amendment 3 + 7: non-null externalItemId — use upsert on unique constraint
          await tx.externalOrderItem.upsert({
            where: {
              orderId_externalItemId: {
                orderId: externalOrder.id,
                externalItemId: lineItem.externalId,
              },
            },
            create: {
              orderId: externalOrder.id,
              externalItemId: lineItem.externalId,
              externalProductId: lineItem.externalProductId || "",
              externalVariantId: lineItem.externalVariantId,
              ...itemData,
              // D7: snapshot set once at first intake, never overwritten
              bundleComponentSnapshot,
            },
            update: itemData,
            // NOTE: bundleComponentSnapshot intentionally excluded from update
            // to preserve the D7 immutability guarantee.
          });
        } else {
          // Amendment 7: null externalItemId — fall back to findFirst + create/update
          const existingItem = await tx.externalOrderItem.findFirst({
            where: {
              orderId: externalOrder.id,
              externalItemId: null,
              externalProductId: lineItem.externalProductId || "",
              externalVariantId: lineItem.externalVariantId ?? null,
            },
          });

          if (existingItem) {
            await tx.externalOrderItem.update({
              where: { id: existingItem.id },
              data: itemData,
              // NOTE: bundleComponentSnapshot intentionally excluded from update
              // to preserve the D7 immutability guarantee.
            });
          } else {
            await tx.externalOrderItem.create({
              data: {
                orderId: externalOrder.id,
                externalItemId: null,
                externalProductId: lineItem.externalProductId || "",
                externalVariantId: lineItem.externalVariantId,
                ...itemData,
                // D7: snapshot set once at first intake, never overwritten
                bundleComponentSnapshot,
              },
            });
          }
        }

        itemsProcessed += 1;
        if (productLink) itemsMapped += 1;
      }

      // Clean up stale items (whose externalItemId is no longer in the order).
      // P0-3: Run unconditionally. If seenExternalItemIds is empty (every line
      // item in the payload lacked an externalItemId), delete all rows with a
      // non-null externalItemId for this order. Prisma's empty `notIn: []` is
      // ambiguous, so we split into two explicit branches. The where-clause is
      // captured so we can read the to-be-pruned rows before they vanish.
      const staleWhere: Prisma.ExternalOrderItemWhereInput =
        seenExternalItemIds.size > 0
          ? {
              orderId: externalOrder.id,
              AND: [
                { externalItemId: { not: null } },
                { externalItemId: { notIn: Array.from(seenExternalItemIds) } },
              ],
            }
          : {
              orderId: externalOrder.id,
              externalItemId: { not: null },
            };

      // R-D16: capture id + identity of the rows about to be pruned BEFORE the
      // deleteMany — today they vanish unrecorded. KNOWN LIMITATION: stale
      // null-externalItemId items are never pruned (the cleanup is non-null
      // scoped), so they cannot appear here — unchanged behavior, now written
      // down.
      const prunedItems =
        (await tx.externalOrderItem.findMany({
          where: staleWhere,
          select: { id: true, externalItemId: true, productLinkId: true },
        })) ?? [];

      await tx.externalOrderItem.deleteMany({ where: staleWhere });

      // Read the post-write item set (after the loop + prune) so BOTH sides of
      // the item diff are Decimal-typed and normalize identically (ER-B1 — a
      // number built from normalized.lineItems would never re-compare equal).
      const afterItemRows =
        (await tx.externalOrderItem.findMany({
          where: { orderId: externalOrder.id },
          select: {
            externalItemId: true,
            quantity: true,
            price: true,
            name: true,
          },
        })) ?? [];

      // --- R-D4 material field-set diff (P-B3, ER-B1 normalization) ---
      const beforeScalar = {
        nativeStatus: beforeOrder?.nativeStatus ?? null,
        financialStatus: beforeOrder?.financialStatus ?? null,
        fulfillmentStatus: beforeOrder?.fulfillmentStatus ?? null,
        internalStatus: beforeOrder?.internalStatus ?? null,
        total:
          beforeOrder == null || beforeOrder.total == null
            ? null
            : String(beforeOrder.total),
        currency: beforeOrder?.currency ?? null,
        customerEmail: beforeOrder?.customerEmail ?? null,
        customerName: beforeOrder?.customerName ?? null,
        orderNumber: beforeOrder?.orderNumber ?? null,
      };
      const afterScalar = {
        nativeStatus: normalized.nativeStatus ?? null,
        financialStatus: normalized.financialStatus ?? null,
        fulfillmentStatus: normalized.fulfillmentStatus ?? null,
        internalStatus,
        total: normalized.total == null ? null : String(normalized.total),
        currency: normalized.currency ?? null,
        customerEmail: normalized.customer?.email ?? null,
        customerName: normalized.customer?.name ?? null,
        orderNumber: normalized.externalOrderNumber ?? null,
      };
      const changes: ChangeDiff = diff(beforeScalar, afterScalar, [
        "nativeStatus",
        "financialStatus",
        "fulfillmentStatus",
        "internalStatus",
        "total",
        "currency",
        "customerEmail",
        "customerName",
        "orderNumber",
      ]);

      const beforeItems = normalizeOrderItems(beforeOrder?.items ?? []);
      const afterItems = normalizeOrderItems(afterItemRows);
      const itemsChanged =
        JSON.stringify(beforeItems) !== JSON.stringify(afterItems);
      if (itemsChanged || prunedItems.length > 0) {
        changes.items = { from: beforeItems, to: afterItems };
      }

      const changed = created || Object.keys(changes).length > 0;

      const summary: OrderChangeSummary = {
        created,
        changed,
        changes,
        prunedItems,
        orderId: externalOrder.id,
        orderNumber:
          externalOrder.orderNumber ?? normalized.externalOrderNumber ?? null,
        itemsProcessed,
        itemsMapped,
      };

      // User-tier same-tx recording seam (P-B2, recheck). Machine ingestion
      // paths (webhook/cron) do NOT pass onRecorded — they call recordIngestion
      // best-effort AFTER this returns. A throw here aborts the whole upsert
      // (correct: an unrecordable user change must not commit).
      if (onRecorded && changed) {
        await onRecorded(tx, summary);
      }

      return summary;
    },
    { timeout: 10000 }
  );
}

// ---------------------------------------------------------------------------
// getIntegrationClient — Amendment 1
// ---------------------------------------------------------------------------

export type IntegrationClient = {
  adapter: PlatformAdapter;
  storeUrl: string;
  credentials: { key: string; secret: string };
  integration: Integration;
};

/**
 * Load an integration, decrypt its credentials, and return a ready-to-use
 * client bundle.  Used by stock sync, fulfillment push, and manual sync.
 */
export async function getIntegrationClient(
  integrationId: string
): Promise<IntegrationClient> {
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
  });
  if (!integration || !integration.isActive) {
    throw new AppError(
      "Integration not found or inactive",
      "NOT_FOUND",
      404
    );
  }

  const adapter = getPlatformAdapter(integration.platform as PlatformType);

  const key = decryptOrNull(integration.encryptedApiKey);
  const secret = decryptOrNull(integration.encryptedApiSecret);
  if (!key || !secret) {
    throw new AppError(
      "Failed to decrypt integration credentials",
      "CREDENTIAL_ERROR",
      500
    );
  }

  return {
    adapter,
    storeUrl: integration.storeUrl,
    credentials: { key, secret },
    integration,
  };
}

// ---------------------------------------------------------------------------
// pushOrderStatusToExternal — Batch 3: Fulfillment Write-Back
// ---------------------------------------------------------------------------

/**
 * Push an order status update to an external platform.
 * Uses getIntegrationClient + adapter.updateOrderStatus().
 * Best-effort: callers should wrap in try/catch and never let failures
 * block local operations.
 */
export async function pushOrderStatusToExternal(
  integrationId: string,
  externalOrderId: string,
  status: string
): Promise<{ success: boolean; error?: string }> {
  const { adapter, storeUrl, credentials } =
    await getIntegrationClient(integrationId);

  if (!adapter.updateOrderStatus) {
    return {
      success: false,
      error: `Adapter for ${adapter.platform} does not support updateOrderStatus`,
    };
  }

  return adapter.updateOrderStatus(storeUrl, credentials, externalOrderId, status);
}
