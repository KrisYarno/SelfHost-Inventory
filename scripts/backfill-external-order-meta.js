#!/usr/bin/env node
const { createHash } = require("crypto");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function safeHostFromUrl(value) {
  try {
    const url = new URL(value);
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

function buildExternalOrderUrl(platform, storeUrl, rawPayload, externalId) {
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
      return `${base.origin}/wp-admin/post.php?post=${externalId}&action=edit`;
    } catch {
      return null;
    }
  }

  return null;
}

function buildPlatformStatusRaw(platform, rawPayload, normalized) {
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

function computeStatusHash(platform, normalized, platformStatusRaw, externalUpdatedAt) {
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

function deriveExternalOrderMeta({ platform, storeUrl, externalId, normalized, rawPayload }) {
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

async function main() {
  const batchSize = 100;
  let cursor = null;
  let updated = 0;

  while (true) {
    const orders = await prisma.externalOrder.findMany({
      where: {
        OR: [
          { externalStatusHash: null },
          { externalUpdatedAt: null },
          { externalOrderUrl: null },
          { lastSeenAt: null },
        ],
      },
      include: {
        integration: { select: { platform: true, storeUrl: true } },
      },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: "asc" },
    });

    if (orders.length === 0) break;

    for (const order of orders) {
      const derived = deriveExternalOrderMeta({
        platform: order.integration.platform,
        storeUrl: order.integration.storeUrl,
        externalId: order.externalId,
        normalized: {
          nativeStatus: order.nativeStatus,
          financialStatus: order.financialStatus,
          fulfillmentStatus: order.fulfillmentStatus,
        },
        rawPayload: order.rawPayload,
      });

      await prisma.externalOrder.update({
        where: { id: order.id },
        data: {
          platformStatusRaw: derived.platformStatusRaw,
          externalStatusHash: derived.externalStatusHash,
          externalOrderUrl: derived.externalOrderUrl,
          externalUpdatedAt: derived.externalUpdatedAt,
          lastSeenAt: order.lastSeenAt ?? derived.lastSeenAt,
        },
      });
      updated += 1;
    }

    cursor = orders[orders.length - 1].id;
  }

  console.log(`Backfill complete. Updated ${updated} orders.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
