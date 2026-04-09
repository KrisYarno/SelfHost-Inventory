import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import { validateCSRFToken } from "@/lib/csrf";
import prisma from "@/lib/prisma";
import { getPlatformAdapter } from "@/lib/platforms/core/registry";
import {
  decryptOrNull,
  hostFromStoreUrl,
  reconcileStatus,
  upsertOrderWithItems,
  type InternalOrderStatus,
} from "@/lib/external-orders/shared";
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

  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
  }

  // Optional body: { mode: 'reconcile' | 'compute' }
  //   'reconcile' (default, safe): smart merge with local state protection
  //   'compute'  (force resync):   trust WC fully, overwrite local state
  // Force mode is intended for operators recovering from stuck state where
  // the local internalStatus no longer reflects reality (e.g., an order was
  // manually unfulfilled in Rebuild and the user wants to reset from WC).
  let mode: "reconcile" | "compute" = "reconcile";
  try {
    const body = await request.json().catch(() => null);
    if (body?.mode === "compute") {
      mode = "compute";
    }
  } catch {
    // no-op; empty body is fine
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

  // Status handling depends on mode:
  //   - reconcile (default): smart merge that protects local `fulfilled` and
  //     honors terminal cancellation. See reconcileStatus() for rules.
  //   - compute (force): trust WC fully, run the bare deriveInternalStatus
  //     via the upsert's compute branch. Used by Force Resync to recover
  //     from stuck state.
  const statusHandling =
    mode === "compute"
      ? ({ statusMode: "compute", platform } as const)
      : ({
          statusMode: "preserve",
          internalStatus: reconcileStatus(
            platform,
            order.internalStatus as InternalOrderStatus,
            normalized
          ),
        } as const);

  const result = await upsertOrderWithItems(prisma, {
    integrationId: order.integration.id,
    companyId: order.companyId,
    storeUrl: order.integration.storeUrl,
    normalized,
    status: statusHandling,
  });

  return NextResponse.json({
    success: true,
    mode,
    orderId: result.orderId,
    itemsProcessed: result.itemsProcessed,
    itemsMapped: result.itemsMapped,
  });
});
