import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import { validateCSRFToken } from "@/lib/csrf";
import prisma from "@/lib/prisma";
import { decryptValue, isEncrypted } from "@/lib/encryption";
import { getPlatformAdapter } from "@/lib/platforms/core/registry";
import type { PlatformType } from "@/lib/platforms/core/types";
import { deriveExternalOrderMeta } from "@/lib/external-orders/meta";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

async function fetchShopifyOrder(shopDomain: string, accessToken: string, externalId: string) {
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2025-10";
  const url = `https://${shopDomain}/admin/api/${apiVersion}/orders/${externalId}.json`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Shopify API error ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { order?: any };
  if (!data.order) throw new Error("Shopify order not found");
  return data.order;
}

async function fetchWooOrder(baseUrl: string, consumerKey: string, consumerSecret: string, externalId: string) {
  const url = new URL(`/wp-json/wc/v3/orders/${externalId}`, baseUrl);
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
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
    throw new Error(`WooCommerce API error ${resp.status}: ${body.slice(0, 200)}`);
  }
  return await resp.json();
}

export const POST = apiHandler(async (
  request: NextRequest,
  { params }: { params: { orderId: string } }
) => {
  const { user } = await requireApproved();

  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
  }

  const order = await prisma.externalOrder.findUnique({
    where: { id: params.orderId },
    include: {
      integration: true,
    },
  });

  if (!order || !order.integration) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  // Ensure user is in the same company (admin can bypass)
  if (!user.isAdmin) {
    const membership = await prisma.userCompany.findFirst({
      where: { userId: user.id, companyId: order.companyId },
    });
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const platform = order.integration.platform as PlatformType;
  const apiKey = decryptOrNull(order.integration.encryptedApiKey);
  const apiSecret = decryptOrNull(order.integration.encryptedApiSecret);

  let remoteOrder: any;
  if (platform === "SHOPIFY") {
    if (!apiKey) {
      return NextResponse.json({ error: "Missing Shopify Admin API token" }, { status: 400 });
    }
    const shopDomain = hostFromStoreUrl(order.integration.storeUrl);
    remoteOrder = await fetchShopifyOrder(shopDomain, apiKey, order.externalId);
  } else if (platform === "WOOCOMMERCE") {
    if (!apiKey || !apiSecret) {
      return NextResponse.json({ error: "Missing WooCommerce API credentials" }, { status: 400 });
    }
    remoteOrder = await fetchWooOrder(order.integration.storeUrl, apiKey, apiSecret, order.externalId);
  } else {
    return NextResponse.json({ error: "Unsupported platform" }, { status: 400 });
  }

  const adapter = getPlatformAdapter(platform);
  const normalized = adapter.parseOrderWebhook(JSON.stringify(remoteOrder));
  const derivedMeta = deriveExternalOrderMeta({
    platform,
    storeUrl: order.integration.storeUrl,
    externalId: normalized.externalId,
    normalized,
    rawPayload: normalized.rawPayload as any,
  });

  const externalOrder = await prisma.externalOrder.upsert({
    where: {
      integrationId_externalId: {
        integrationId: order.integration.id,
        externalId: normalized.externalId,
      },
    },
    create: {
      companyId: order.companyId,
      integrationId: order.integration.id,
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
      internalStatus: order.internalStatus,
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
      updatedAt: new Date(),
      externalCreatedAt: normalized.createdAt,
      externalUpdatedAt: derivedMeta.externalUpdatedAt,
      lastSeenAt: derivedMeta.lastSeenAt,
    },
  });

  return NextResponse.json({
    success: true,
    orderId: externalOrder.id,
    lastSeenAt: derivedMeta.lastSeenAt,
  });
});
