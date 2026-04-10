import prisma from "@/lib/prisma";
import { getIntegrationClient } from "@/lib/external-orders/shared";
import type { PlatformType } from "@/lib/platforms/core/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StockSyncResult = {
  integrationId: string;
  platform: PlatformType;
  synced: number;
  failed: number;
  errors: Array<{ productId: string; error: string }>;
};

// ---------------------------------------------------------------------------
// syncStockToExternal
// ---------------------------------------------------------------------------

/**
 * Push internal stock quantities (as stock_status) to an external platform.
 *
 * Amendment 3:  Single Prisma query for all ProductLinks + product_locations.
 * Amendment 6:  batchUpdateProductStock on the adapter handles simple/variant split.
 * Amendment 8:  syncLocationId narrows stock to one location when set.
 * Amendment 11: Push stock_status only (instock/outofstock), never stock_quantity.
 */
export async function syncStockToExternal(
  integrationId: string
): Promise<StockSyncResult> {
  // 1. Load integration + adapter via shared helper (Amendment 1)
  const { adapter, storeUrl, credentials, integration } =
    await getIntegrationClient(integrationId);

  const platform = integration.platform as PlatformType;

  // 2. Check stockSyncEnabled — skip if false
  if (!integration.stockSyncEnabled) {
    return {
      integrationId,
      platform,
      synced: 0,
      failed: 0,
      errors: [{ productId: "*", error: "Stock sync is disabled for this integration" }],
    };
  }

  // 3. Single query: all ProductLinks with internal product + product_locations (Amendment 3)
  const productLinks = await prisma.productLink.findMany({
    where: { integrationId },
    include: {
      internalProduct: {
        include: {
          product_locations: true,
        },
      },
    },
  });

  if (productLinks.length === 0) {
    // Nothing to sync — update timestamp and return
    await prisma.integration.update({
      where: { id: integrationId },
      data: {
        lastStockSyncAt: new Date(),
        lastStockSyncError: null,
      },
    });

    return { integrationId, platform, synced: 0, failed: 0, errors: [] };
  }

  // 4. Compute stock per ProductLink
  //    Amendment 8: if syncLocationId is set, only count stock from that location.
  //    Amendment 11: map to stock_status string (instock / outofstock).
  const updates: Array<{
    productId: string;
    variantId?: string;
    stockStatus: 'instock' | 'outofstock';
  }> = [];

  for (const link of productLinks) {
    const locations = link.internalProduct.product_locations;

    let totalStock: number;
    if (integration.syncLocationId != null) {
      const loc = locations.find((pl) => pl.locationId === integration.syncLocationId);
      totalStock = loc?.quantity ?? 0;
    } else {
      totalStock = locations.reduce((sum, pl) => sum + pl.quantity, 0);
    }

    updates.push({
      productId: link.externalProductId,
      variantId: link.externalVariantId ?? undefined,
      stockStatus: totalStock > 0 ? 'instock' : 'outofstock',
    });
  }

  // 5. Call adapter.batchUpdateProductStock (handles simple/variant split per Amendment 6)
  if (!adapter.batchUpdateProductStock) {
    const errorMsg = `Adapter for ${platform} does not support batchUpdateProductStock`;
    await prisma.integration.update({
      where: { id: integrationId },
      data: { lastStockSyncError: errorMsg },
    });

    return {
      integrationId,
      platform,
      synced: 0,
      failed: updates.length,
      errors: [{ productId: "*", error: errorMsg }],
    };
  }

  try {
    const batchResult = await adapter.batchUpdateProductStock(
      storeUrl,
      credentials,
      updates
    );

    // 6. Update integration timestamps
    const now = new Date();
    if (batchResult.failed.length === 0) {
      // Full success — clear error
      await prisma.integration.update({
        where: { id: integrationId },
        data: {
          lastStockSyncAt: now,
          lastStockSyncError: null,
        },
      });
    } else {
      // Partial failure — record failed product IDs
      const errorJson = JSON.stringify({
        failedProducts: batchResult.failed.slice(0, 50),
        timestamp: now.toISOString(),
      });
      await prisma.integration.update({
        where: { id: integrationId },
        data: {
          lastStockSyncAt: now,
          lastStockSyncError: errorJson,
        },
      });
    }

    return {
      integrationId,
      platform,
      synced: batchResult.succeeded,
      failed: batchResult.failed.length,
      errors: batchResult.failed.map((f) => ({
        productId: f.productId,
        error: f.error,
      })),
    };
  } catch (error) {
    // 7. Total failure — store error on integration
    const message = error instanceof Error ? error.message : "Unknown error";
    const errorJson = JSON.stringify({
      message,
      timestamp: new Date().toISOString(),
    });

    await prisma.integration.update({
      where: { id: integrationId },
      data: { lastStockSyncAt: new Date(), lastStockSyncError: errorJson },
    });

    return {
      integrationId,
      platform,
      synced: 0,
      failed: updates.length,
      errors: [{ productId: "*", error: message }],
    };
  }
}

// ---------------------------------------------------------------------------
// pushStockForProducts — fire-and-forget after fulfill/unfulfill
// ---------------------------------------------------------------------------

/**
 * Push stock status for specific internal productIds to the external platform.
 * Looks up all ProductLinks for each product on the given integration, computes
 * the current stock status (instock/outofstock), and calls the adapter's
 * batchUpdateProductStock. Best-effort — callers fire-and-forget.
 *
 * Phase 7f: triggered by the fulfill and unfulfill routes after inventory
 * changes so WC reflects outofstock immediately instead of waiting for the
 * periodic stock sync cron.
 */
export async function pushStockForProducts(
  integrationId: string,
  internalProductIds: number[]
): Promise<void> {
  if (internalProductIds.length === 0) return;

  const { adapter, storeUrl, credentials, integration } =
    await getIntegrationClient(integrationId);

  if (!integration.stockSyncEnabled) return;
  if (!adapter.batchUpdateProductStock) return;

  // Find all ProductLinks for these products on this integration
  const links = await prisma.productLink.findMany({
    where: {
      integrationId,
      internalProductId: { in: internalProductIds },
    },
    include: {
      internalProduct: {
        include: {
          product_locations: true,
        },
      },
    },
  });

  if (links.length === 0) return;

  // Compute stock status per link, using the same logic as the full sync
  const updates: Array<{
    productId: string;
    variantId?: string;
    stockStatus: 'instock' | 'outofstock';
  }> = [];

  for (const link of links) {
    const locations = link.internalProduct.product_locations;

    let totalStock: number;
    if (integration.syncLocationId != null) {
      const loc = locations.find(
        (pl) => pl.locationId === integration.syncLocationId
      );
      totalStock = loc?.quantity ?? 0;
    } else {
      totalStock = locations.reduce((sum, pl) => sum + pl.quantity, 0);
    }

    updates.push({
      productId: link.externalProductId,
      variantId: link.externalVariantId ?? undefined,
      stockStatus: totalStock > 0 ? 'instock' : 'outofstock',
    });
  }

  if (updates.length === 0) return;

  const result = await adapter.batchUpdateProductStock(
    storeUrl,
    credentials,
    updates
  );

  if (result.failed.length > 0) {
    console.warn(
      `[stock push] ${result.failed.length} product(s) failed for integration ${integrationId}:`,
      result.failed.slice(0, 5)
    );
  } else {
    console.log(
      `[stock push] Pushed ${result.succeeded} stock status(es) for integration ${integrationId}`
    );
  }
}
