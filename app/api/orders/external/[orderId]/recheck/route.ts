import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { getPlatformAdapter } from "@/lib/platforms/core/registry";
import {
  decryptOrNull,
  hostFromStoreUrl,
  upsertOrderWithItems,
} from "@/lib/external-orders/shared";
import { recordChange } from "@/lib/change-tracking";
import type { PlatformType } from "@/lib/platforms/core/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

  await requireCSRF(request);

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

  // With stockedOut separation, internalStatus is purely WC-derived.
  // Recheck always uses compute mode — no need for reconcileStatus since
  // stockedOut handles the deduction truth independently.
  //
  // P-B2 (USER tier): a human clicked recheck, so record via `onRecorded`
  // INSIDE the upsert transaction (R-D2 hard-abort — an unrecordable recheck
  // aborts the whole upsert). No change => callback not invoked => no event.
  const result = await upsertOrderWithItems(prisma, {
    integrationId: order.integration.id,
    companyId: order.companyId,
    storeUrl: order.integration.storeUrl,
    normalized,
    status: { statusMode: "compute", platform },
    onRecorded: (tx, summary) =>
      recordChange(tx, {
        actor: { userId: user.id },
        actionType: summary.created
          ? "EXTERNAL_ORDER_CREATE"
          : "EXTERNAL_ORDER_UPDATE",
        entityType: "ORDER",
        entityId: summary.orderId,
        companyId: order.integration.companyId,
        action: `Rechecked order ${summary.orderNumber ?? summary.orderId} against ${platform}`,
        changes: summary.changes,
        details: { trigger: "recheck", prunedItems: summary.prunedItems },
      }),
  });

  return NextResponse.json({
    success: true,
    orderId: result.orderId,
    itemsProcessed: result.itemsProcessed,
    itemsMapped: result.itemsMapped,
  });
});
