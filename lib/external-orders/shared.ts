import { decryptValue, isEncrypted } from "@/lib/encryption";
import { deriveExternalOrderMeta } from "@/lib/external-orders/meta";
import type { PlatformType, NormalizedOrder } from "@/lib/platforms/core/types";
import type { Prisma, PrismaClient } from "@prisma/client";

// ---------------------------------------------------------------------------
// deriveInternalStatus
// ---------------------------------------------------------------------------

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
): "pending" | "processing" | "fulfilled" | "cancelled" {
  if (platform === "WOOCOMMERCE") {
    const status = (order.nativeStatus || "").toLowerCase();
    if (status === "completed") return "fulfilled";
    if (status === "processing") return "processing";
    if (["cancelled", "refunded", "failed"].includes(status)) return "cancelled";
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

      // Clean up stale items (whose externalItemId is no longer in the order)
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
      }

      return { orderId: externalOrder.id, itemsProcessed, itemsMapped };
    },
    { timeout: 10000 }
  );
}
