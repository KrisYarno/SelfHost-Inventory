import { decryptValue, isEncrypted } from "@/lib/encryption";
import { deriveExternalOrderMeta } from "@/lib/external-orders/meta";
import { AppError } from "@/lib/error-handling";
import { getPlatformAdapter } from "@/lib/platforms/core/registry";
import prisma from "@/lib/prisma";
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

/**
 * Smart reconciliation between the current locally-stored status and the
 * freshly-derived status from a remote order. Use this on manual "recheck"
 * and any flow where local fulfillment work must not regress while still
 * allowing legitimate WC state changes (cancellation, completion) to flow in.
 *
 * Rules (in order):
 *   1. If the remote derives to `cancelled` (cancelled / refunded / failed
 *      on WC, voided on Shopify), the order is cancelled — terminal WC
 *      state always wins, even over local `fulfilled`. The user needs to
 *      decide whether to unfulfill inventory; the status change surfaces it.
 *   2. If the local state is `fulfilled` and remote is NOT cancelled, keep
 *      `fulfilled`. Local fulfillment represents real deducted inventory;
 *      regressing to `processing`/`pending` would misrepresent the work.
 *   3. Otherwise, trust the freshly-derived status from the remote.
 */
export function reconcileStatus(
  platform: PlatformType,
  currentInternalStatus: InternalOrderStatus,
  remoteOrder: {
    nativeStatus: string;
    financialStatus: string | null;
    fulfillmentStatus: string | null;
    rawPayload?: any;
  }
): InternalOrderStatus {
  const derived = deriveInternalStatus(platform, remoteOrder);

  if (derived === "cancelled") return "cancelled";
  if (currentInternalStatus === "fulfilled") return "fulfilled";
  return derived;
}

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

export type UpsertOrderParams = {
  integrationId: string;
  companyId: string;
  storeUrl: string;
  normalized: NormalizedOrder;
  status: StatusHandling;
};

export type UpsertOrderResult = {
  orderId: string;
  itemsProcessed: number;
  itemsMapped: number;
};

type TransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

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
): Promise<UpsertOrderResult> {
  const { integrationId, companyId, storeUrl, normalized, status } = params;

  return prismaClient.$transaction(
    async (tx: TransactionClient) => {
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
        }

        const itemData = {
          name: lineItem.name,
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
            },
            update: itemData,
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
            });
          } else {
            await tx.externalOrderItem.create({
              data: {
                orderId: externalOrder.id,
                externalItemId: null,
                externalProductId: lineItem.externalProductId || "",
                externalVariantId: lineItem.externalVariantId,
                ...itemData,
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
      // ambiguous, so we split into two explicit branches.
      if (seenExternalItemIds.size > 0) {
        await tx.externalOrderItem.deleteMany({
          where: {
            orderId: externalOrder.id,
            AND: [
              { externalItemId: { not: null } },
              { externalItemId: { notIn: Array.from(seenExternalItemIds) } },
            ],
          },
        });
      } else {
        await tx.externalOrderItem.deleteMany({
          where: {
            orderId: externalOrder.id,
            externalItemId: { not: null },
          },
        });
      }

      return { orderId: externalOrder.id, itemsProcessed, itemsMapped };
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
