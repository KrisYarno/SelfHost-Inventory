import prisma from "@/lib/prisma";
import { getPlatformAdapter } from "@/lib/platforms/core/registry";
import { decryptOrNull, hostFromStoreUrl, upsertOrderWithItems } from "@/lib/external-orders/shared";
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
// Widened from 10 → 60 min after a live-site bug where orders placed within
// the last hour were being dropped due to timezone interpretation quirks and
// clock skew. 60 min is still tight enough to be cheap on incremental syncs
// (typical stores see <100 orders/hour) and robust enough to survive minor
// outages of the incremental poller.
const LOOKBACK_SAFETY_MINUTES = 60;

function getEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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
    // CRITICAL: WC ignores the ISO `Z` suffix and interprets `modified_after`
    // in the shop's local timezone by default, which caused orders to be
    // silently dropped when the shop TZ was behind UTC. `dates_are_gmt=true`
    // forces WC to parse the query as UTC, matching what we actually send.
    url.searchParams.set("dates_are_gmt", "true");
    // `status=any` ensures checkout-draft, on-hold, and other non-default
    // statuses flow through — the default is `any` but we set it explicitly
    // so a future WC default change can't silently narrow our sync window.
    url.searchParams.set("status", "any");

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

  // P1-3 hardening: timestamp-based row lock instead of MySQL GET_LOCK.
  // GET_LOCK is session-scoped, so under Prisma's connection pooling the
  // RELEASE_LOCK call in finally could land on a different connection and
  // silently no-op. The row lock works across connections and has built-in
  // TTL: stale locks older than 5 minutes are re-acquirable, so a crashed
  // sync can't permanently block an integration.
  const lockAcquiredAt = new Date();
  const staleThreshold = new Date(lockAcquiredAt.getTime() - 5 * 60 * 1000);
  const acquireResult = await prisma.integration.updateMany({
    where: {
      id: integrationId,
      OR: [
        { syncLockedAt: null },
        { syncLockedAt: { lt: staleThreshold } },
      ],
    },
    data: { syncLockedAt: lockAcquiredAt },
  });

  if (acquireResult.count === 0) {
    console.warn(
      `[sync] Skipping integration ${integrationId}: another sync run holds the lock`
    );
    return {
      integrationId,
      platform,
      since: new Date().toISOString(),
      fetched: 0,
      upserted: 0,
      skipped: 0,
      deleted: 0,
      errors: [{ message: 'Sync skipped — another run is in progress' }],
      lastSyncAt: integration.lastSyncAt?.toISOString() ?? new Date(0).toISOString(),
    };
  }

  try {

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

      await upsertOrderWithItems(prisma, {
        integrationId: integration.id,
        companyId: integration.companyId,
        storeUrl: integration.storeUrl,
        normalized,
        status: { statusMode: "compute", platform },
      });

      upserted += 1;
    } catch (error) {
      skipped += 1;
      const message = error instanceof Error ? error.message : "Unknown error";
      const externalId = order?.id ? String(order.id) : undefined;
      errors.push({ externalId, message });
    }
  }

  // P1-2: Only advance lastSyncAt when at least one order successfully
  // upserted. On total failure, leave it unchanged so the next run retries
  // the same window rather than silently skipping the failed orders.
  const now = new Date();
  const shouldAdvanceCursor = upserted > 0 || remoteOrders.length === 0;
  if (shouldAdvanceCursor) {
    await prisma.integration.update({
      where: { id: integration.id },
      data: { lastSyncAt: now },
    });
  }

  return {
    integrationId: integration.id,
    platform,
    since: sinceDate.toISOString(),
    fetched: remoteOrders.length,
    upserted,
    skipped,
    deleted: 0,
    errors: errors.slice(0, 20),
    lastSyncAt: shouldAdvanceCursor
      ? now.toISOString()
      : integration.lastSyncAt?.toISOString() ?? now.toISOString(),
  };
  } finally {
    // Release the row lock. The `syncLockedAt: lockAcquiredAt` condition is a
    // fencing token: we only clear the lock if we're still the owner. If the
    // stale-lock threshold elapsed and another process acquired it, our
    // release no-ops and we don't stomp on their work.
    try {
      await prisma.integration.updateMany({
        where: {
          id: integrationId,
          syncLockedAt: lockAcquiredAt,
        },
        data: { syncLockedAt: null },
      });
    } catch (releaseError) {
      console.error(
        `[sync] Failed to release row lock for ${integrationId}:`,
        releaseError
      );
    }
  }
}
