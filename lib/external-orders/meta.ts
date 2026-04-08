import { createHash } from "crypto";
import type { PlatformType } from "@/lib/platforms/core/types";

type NormalizedLike = {
  nativeStatus: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
};

function safeDate(value: unknown): Date | null {
  if (!value) return null;
  const date = new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date;
}

function safeHostFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

function buildExternalOrderUrl(
  platform: PlatformType,
  storeUrl: string,
  rawPayload: any,
  externalId: string
): string | null {
  if (platform === "SHOPIFY") {
    const host = safeHostFromUrl(storeUrl);
    if (host && host.endsWith(".myshopify.com")) {
      return `https://${host}/admin/orders/${externalId}`;
    }
    const orderStatusUrl = typeof rawPayload?.order_status_url === "string" ? rawPayload.order_status_url : null;
    if (orderStatusUrl) return orderStatusUrl;
    if (host) return `https://${host}/admin/orders/${externalId}`;
    return null;
  }

  if (platform === "WOOCOMMERCE") {
    try {
      const base = new URL(storeUrl);
      return `${base.origin}/wp-admin/admin.php?page=wc-orders&action=edit&id=${externalId}`;
    } catch {
      return null;
    }
  }

  return null;
}

function buildPlatformStatusRaw(platform: PlatformType, rawPayload: any, normalized: NormalizedLike): any | null {
  if (platform === "SHOPIFY") {
    return {
      financial_status: rawPayload?.financial_status ?? normalized.financialStatus,
      fulfillment_status: rawPayload?.fulfillment_status ?? normalized.fulfillmentStatus,
      cancelled_at: rawPayload?.cancelled_at ?? null,
    };
  }

  if (platform === "WOOCOMMERCE") {
    return {
      status: rawPayload?.status ?? normalized.nativeStatus,
    };
  }

  return null;
}

function computeStatusHash(
  platform: PlatformType,
  normalized: NormalizedLike,
  platformStatusRaw: any | null,
  externalUpdatedAt: Date | null
): string {
  const payload = {
    platform,
    nativeStatus: normalized.nativeStatus,
    financialStatus: normalized.financialStatus,
    fulfillmentStatus: normalized.fulfillmentStatus,
    platformStatusRaw,
    externalUpdatedAt: externalUpdatedAt ? externalUpdatedAt.toISOString() : null,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function deriveExternalOrderMeta(options: {
  platform: PlatformType;
  storeUrl: string;
  externalId: string;
  normalized: NormalizedLike;
  rawPayload: any;
}) {
  const { platform, storeUrl, externalId, normalized, rawPayload } = options;
  const platformStatusRaw = buildPlatformStatusRaw(platform, rawPayload, normalized);
  const externalUpdatedAt =
    platform === "SHOPIFY"
      ? safeDate(rawPayload?.updated_at ?? rawPayload?.processed_at)
      : safeDate(rawPayload?.date_modified ?? rawPayload?.date_modified_gmt);
  const externalOrderUrl = buildExternalOrderUrl(platform, storeUrl, rawPayload, externalId);
  const externalStatusHash = computeStatusHash(platform, normalized, platformStatusRaw, externalUpdatedAt);
  const lastSeenAt = new Date();

  return {
    platformStatusRaw,
    externalUpdatedAt,
    externalOrderUrl,
    externalStatusHash,
    lastSeenAt,
  };
}

