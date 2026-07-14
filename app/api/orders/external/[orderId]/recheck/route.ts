import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler, requireCSRF, requireCompanyMembership } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { getPlatformAdapter } from "@/lib/platforms/core/registry";
import { upsertOrderWithItems } from "@/lib/external-orders/shared";
import { platformRead } from "@/lib/platforms/egress";
import { recordChange } from "@/lib/change-tracking";
import type { PlatformType } from "@/lib/platforms/core/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Lane 6: both recheck fetches go through the chokepoint (READ credential,
// origin-pinned, redirect-refusing). Neither can mutate the order it is checking.

async function fetchShopifyOrder(integrationId: string, externalId: string) {
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2025-10";
  const resp = await platformRead(
    integrationId,
    `/admin/api/${apiVersion}/orders/${encodeURIComponent(externalId)}.json`
  );
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Shopify API error ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { order?: any };
  if (!data.order) throw new Error("Shopify order not found");
  return data.order;
}

async function fetchWooOrder(integrationId: string, externalId: string) {
  const resp = await platformRead(
    integrationId,
    `/wp-json/wc/v3/orders/${encodeURIComponent(externalId)}`
  );
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

  // Ensure user is in the same company (admin can bypass). S6: anti-enumeration
  // 404 (not 403) so the response doesn't leak whether the order exists.
  await requireCompanyMembership(user.id, order.companyId, user.isAdmin);

  const platform = order.integration.platform as PlatformType;

  let remoteOrder: any;
  if (platform === "SHOPIFY") {
    remoteOrder = await fetchShopifyOrder(order.integration.id, order.externalId);
  } else if (platform === "WOOCOMMERCE") {
    remoteOrder = await fetchWooOrder(order.integration.id, order.externalId);
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
