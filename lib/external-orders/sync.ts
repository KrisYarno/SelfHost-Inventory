import prisma from "@/lib/prisma";
import { decryptValue, isEncrypted } from "@/lib/encryption";
import { deriveExternalOrderMeta } from "@/lib/external-orders/meta";
import { getPlatformAdapter } from "@/lib/platforms/core/registry";
import type { PlatformType } from "@/lib/platforms/core/types";

type SyncResult = {
  integrationId: string;
  platform: PlatformType;
  since: string;
  fetched: number;
  upserted: number;
  skipped: number;
  deleted: number;
  errors: Array<{ externalId?: string; message: string }>;
  lastSyncAt: string;
};

type SyncOptions = {
  lookbackDays?: number;
  maxOrders?: number;
};

const DEFAULT_INITIAL_LOOKBACK_DAYS = 7;
const DEFAULT_MAX_ORDERS = 250;
const LOOKBACK_SAFETY_MINUTES = 10;

function getEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function decryptOrNull(value: string | null): string | null {
  if (!value) return null;
  if (!isEncrypted(value)) return value;
  return decryptValue(value);
}

function hostFromStoreUrl(storeUrl: string): string {
  try {
    const url = new URL(storeUrl);
    return url.host;
  } catch {
    return storeUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
}

function startDateForSync(lastSyncAt: Date | null, lookbackDays: number): Date {
  const now = new Date();
  if (!lastSyncAt) {
    return new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  }
  return new Date(lastSyncAt.getTime() - LOOKBACK_SAFETY_MINUTES * 60 * 1000);
}

function parseShopifyLinkHeader(link: string | null): string | null {
  if (!link) return null;
  // Example: <https://shop/admin/api/2025-10/orders.json?limit=250&page_info=...>; rel="next"
  const parts = link.split(",");
  for (const part of parts) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/i);
    if (m?.[1]) {
      try {
        const url = new URL(m[1]);
        return url.searchParams.get("page_info");
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function fetchShopifyOrders(params: {
  shopDomain: string;
  accessToken: string;
  since: Date;
  maxOrders: number;
}): Promise<any[]> {
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2025-10";
  const limit = 250;
  let pageInfo: string | null = null;
  const results: any[] = [];

  while (results.length < params.maxOrders) {
    const url = new URL(`https://${params.shopDomain}/admin/api/${apiVersion}/orders.json`);
    url.searchParams.set("status", "any");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set(
      "fields",
      [
        "id",
        "name",
        "order_number",
        "financial_status",
        "fulfillment_status",
        "created_at",
        "updated_at",
        "currency",
        "total_price",
        "cancelled_at",
        "customer",
        "line_items",
      ].join(",")
    );
    if (pageInfo) {
      url.searchParams.set("page_info", pageInfo);
    } else {
      url.searchParams.set("updated_at_min", params.since.toISOString());
      url.searchParams.set("order", "updated_at asc");
    }

    const resp = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": params.accessToken,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Shopify API error ${resp.status}: ${body.slice(0, 300)}`);
    }

    const data = (await resp.json()) as { orders?: any[] };
    const orders = data.orders || [];
    results.push(...orders);
    if (results.length >= params.maxOrders) break;

    const nextPage = parseShopifyLinkHeader(resp.headers.get("link"));
    if (!nextPage) break;
    pageInfo = nextPage;
  }

  return results.slice(0, params.maxOrders);
}

async function fetchWooOrders(params: {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  since: Date;
  maxOrders: number;
}): Promise<any[]> {
  const perPage = 100;
  let page = 1;
  const results: any[] = [];

  const auth = Buffer.from(`${params.consumerKey}:${params.consumerSecret}`).toString("base64");

  while (results.length < params.maxOrders) {
    const url = new URL("/wp-json/wc/v3/orders", params.baseUrl);
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));
    url.searchParams.set("orderby", "modified");
    url.searchParams.set("order", "asc");
    url.searchParams.set("modified_after", params.since.toISOString());

    const resp = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`WooCommerce API error ${resp.status}: ${body.slice(0, 300)}`);
    }

    const orders = (await resp.json()) as any[];
    if (!Array.isArray(orders) || orders.length === 0) break;
    results.push(...orders);
    if (results.length >= params.maxOrders) break;

    page += 1;
  }

  return results.slice(0, params.maxOrders);
}

function deriveInternalStatus(
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

  const fulfillment = (order.fulfillmentStatus || "").toLowerCase();
  const financial = (order.financialStatus || "").toLowerCase();
  const cancelledAt = (order.rawPayload as any)?.cancelled_at ?? (order.rawPayload as any)?.cancelledAt;

  if (cancelledAt || financial === "voided" || financial === "refunded") return "cancelled";
  if (fulfillment === "fulfilled") return "fulfilled";
  if (financial === "paid" || financial === "partially_paid") return "processing";
  return "pending";
}

export async function syncIntegrationOrders(
  integrationId: string,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
    include: { company: true },
  });
  if (!integration) throw new Error("Integration not found");
  if (!integration.isActive) throw new Error("Integration is inactive");

  const platform = integration.platform as PlatformType;

  const lookbackDays = Math.max(
    1,
    options.lookbackDays ??
      getEnvInt("EXTERNAL_SYNC_INITIAL_LOOKBACK_DAYS", DEFAULT_INITIAL_LOOKBACK_DAYS)
  );
  const maxOrders = Math.max(
    1,
    options.maxOrders ?? getEnvInt("EXTERNAL_SYNC_MAX_ORDERS", DEFAULT_MAX_ORDERS)
  );

  const sinceDate = startDateForSync(integration.lastSyncAt, lookbackDays);

  const apiKey = decryptOrNull(integration.encryptedApiKey);
  const apiSecret = decryptOrNull(integration.encryptedApiSecret);

  let remoteOrders: any[] = [];
  if (platform === "SHOPIFY") {
    if (!apiKey) {
      throw new Error("Shopify sync requires Admin API access token (API Key field)");
    }
    const shopDomain = hostFromStoreUrl(integration.storeUrl);
    remoteOrders = await fetchShopifyOrders({
      shopDomain,
      accessToken: apiKey,
      since: sinceDate,
      maxOrders,
    });
  } else if (platform === "WOOCOMMERCE") {
    if (!apiKey || !apiSecret) {
      throw new Error("WooCommerce sync requires consumer key + consumer secret");
    }
    remoteOrders = await fetchWooOrders({
      baseUrl: integration.storeUrl,
      consumerKey: apiKey,
      consumerSecret: apiSecret,
      since: sinceDate,
      maxOrders,
    });
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const adapter = getPlatformAdapter(platform);

  let upserted = 0;
  let skipped = 0;
  const errors: Array<{ externalId?: string; message: string }> = [];
  for (const order of remoteOrders) {
    try {
      const normalized = adapter.parseOrderWebhook(JSON.stringify(order));
      const internalStatus = deriveInternalStatus(platform, normalized);
      const derivedMeta = deriveExternalOrderMeta({
        platform,
        storeUrl: integration.storeUrl,
        externalId: normalized.externalId,
        normalized,
        rawPayload: normalized.rawPayload as any,
      });

      const externalOrder = await prisma.externalOrder.upsert({
        where: {
          integrationId_externalId: {
            integrationId: integration.id,
            externalId: normalized.externalId,
          },
        },
        create: {
          companyId: integration.companyId,
          integrationId: integration.id,
          externalId: normalized.externalId,
          orderNumber: normalized.externalOrderNumber,
          nativeStatus: normalized.nativeStatus,
          financialStatus: normalized.financialStatus,
          fulfillmentStatus: normalized.fulfillmentStatus,
          platformStatusRaw: derivedMeta.platformStatusRaw as any,
          externalStatusHash: derivedMeta.externalStatusHash,
          externalOrderUrl: derivedMeta.externalOrderUrl,
          total: normalized.total,
          currency: normalized.currency,
          customerEmail: normalized.customer?.email,
          customerName: normalized.customer?.name,
          rawPayload: normalized.rawPayload as any,
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
          platformStatusRaw: derivedMeta.platformStatusRaw as any,
          externalStatusHash: derivedMeta.externalStatusHash,
          externalOrderUrl: derivedMeta.externalOrderUrl,
          total: normalized.total,
          currency: normalized.currency,
          customerEmail: normalized.customer?.email,
          customerName: normalized.customer?.name,
          rawPayload: normalized.rawPayload as any,
          internalStatus,
          updatedAt: new Date(),
          externalCreatedAt: normalized.createdAt,
          externalUpdatedAt: derivedMeta.externalUpdatedAt,
          lastSeenAt: derivedMeta.lastSeenAt,
        },
      });

      const seenExternalItemIds = new Set<string>();
      for (const lineItem of normalized.lineItems) {
        if (lineItem.externalId) seenExternalItemIds.add(lineItem.externalId);

        const productLink =
          lineItem.externalProductId
            ? await prisma.productLink.findFirst({
                where: {
                  integrationId: integration.id,
                  externalProductId: lineItem.externalProductId,
                  externalVariantId: lineItem.externalVariantId ?? null,
                },
              })
            : null;

        const existingItem = await prisma.externalOrderItem.findFirst({
          where: {
            orderId: externalOrder.id,
            externalItemId: lineItem.externalId,
          },
        });

        if (existingItem) {
          await prisma.externalOrderItem.update({
            where: { id: existingItem.id },
            data: {
              name: lineItem.name,
              sku: lineItem.sku,
              quantity: lineItem.quantity,
              price: lineItem.unitPrice,
              productLinkId: productLink?.id,
              isMapped: !!productLink,
            },
          });
        } else {
          await prisma.externalOrderItem.create({
            data: {
              orderId: externalOrder.id,
              externalItemId: lineItem.externalId,
              externalProductId: lineItem.externalProductId || "",
              externalVariantId: lineItem.externalVariantId,
              name: lineItem.name,
              sku: lineItem.sku,
              quantity: lineItem.quantity,
              price: lineItem.unitPrice,
              productLinkId: productLink?.id,
              isMapped: !!productLink,
            },
          });
        }
      }

      if (seenExternalItemIds.size > 0) {
        await prisma.externalOrderItem.deleteMany({
          where: {
            orderId: externalOrder.id,
            AND: [
              { externalItemId: { not: null } },
              { externalItemId: { notIn: Array.from(seenExternalItemIds) } },
            ],
          },
        });
      }

      upserted += 1;
    } catch (error) {
      skipped += 1;
      const message = error instanceof Error ? error.message : "Unknown error";
      const externalId = order?.id ? String(order.id) : undefined;
      errors.push({ externalId, message });
    }
  }

  const now = new Date();
  await prisma.integration.update({
    where: { id: integration.id },
    data: { lastSyncAt: now },
  });

  return {
    integrationId: integration.id,
    platform,
    since: sinceDate.toISOString(),
    fetched: remoteOrders.length,
    upserted,
    skipped,
    deleted: 0,
    errors: errors.slice(0, 20),
    lastSyncAt: now.toISOString(),
  };
}
