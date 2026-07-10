import prisma from "@/lib/prisma";
import { getIntegrationClient } from "@/lib/external-orders/shared";
import { computeBundleStockStatus } from "@/lib/stock-sync/compute-bundle-status";
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

  // 3. Fetch single-product links and bundle links in parallel.
  //    Single links: include product_locations for stock computation.
  //    Bundle links: no internalProduct needed — status comes from components.
  const [productLinks, bundleLinks] = await Promise.all([
    prisma.productLink.findMany({
      where: {
        integrationId,
        isBundle: false,
        // Provisional (PENDING_REVIEW) internal products are never pushed
        // outward to external platforms.
        internalProduct: { is: { approvalStatus: 'APPROVED' } },
      },
      include: {
        internalProduct: {
          include: {
            product_locations: true,
          },
        },
      },
    }),
    prisma.productLink.findMany({
      where: { integrationId, isBundle: true },
    }),
  ]);

  if (productLinks.length === 0 && bundleLinks.length === 0) {
    // R-D16 EXEMPT-with-reason: the `integration.update` calls in this function
    // write ONLY telemetry fields (lastStockSyncAt / lastStockSyncError) — job
    // plumbing, not business state — so by spec they carry NO change-tracking
    // record. (The business changes — outward stock_status pushes — are the
    // external platform's own state; nothing internal mutates here.)
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

  // 4. Compute stock per single-product ProductLink
  //    Amendment 8: if syncLocationId is set, only count stock from that location.
  //    Amendment 11: map to stock_status string (instock / outofstock).
  const updates: Array<{
    productId: string;
    variantId?: string;
    stockStatus: 'instock' | 'outofstock';
  }> = [];

  for (const link of productLinks) {
    // Query filters on isBundle: false so internalProduct is always set in
    // practice, but TypeScript can't narrow through the schema-level nullability.
    if (!link.internalProduct) continue;
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

  const bundleHealthWarnings: Array<{
    productLinkId: string;
    warning: { kind: string; internalProductId: number };
  }> = [];

  for (const bl of bundleLinks) {
    const result = await computeBundleStockStatus(bl.id, integration.syncLocationId ?? null);
    updates.push({
      productId: bl.externalProductId,
      variantId: bl.externalVariantId ?? undefined,
      stockStatus: result.status,
    });
    if (result.warning) {
      bundleHealthWarnings.push({ productLinkId: bl.id, warning: result.warning });
    }
  }

  if (bundleHealthWarnings.length > 0) {
    console.warn(
      `[stock-sync] ${bundleHealthWarnings.length} bundle(s) have orphan components:`,
      JSON.stringify(bundleHealthWarnings)
    );
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

  // Find all ProductLinks for these products on this integration.
  // Provisional (PENDING_REVIEW) internal products are never pushed outward.
  const links = await prisma.productLink.findMany({
    where: {
      integrationId,
      internalProductId: { in: internalProductIds },
      internalProduct: { is: { approvalStatus: 'APPROVED' } },
    },
    include: {
      internalProduct: {
        include: {
          product_locations: true,
        },
      },
    },
  });

  // Compute stock status per link, using the same logic as the full sync
  const updates: Array<{
    productId: string;
    variantId?: string;
    stockStatus: 'instock' | 'outofstock';
  }> = [];

  for (const link of links) {
    // Same isBundle: false guarantee as above; defensive null narrowing.
    if (!link.internalProduct) continue;
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

  // P0-3: Also push bundle stock for any bundles that contain the deducted components.
  // Single-product links are covered above; this handles the bundle case where the
  // WC bundle product's stock_status must be updated immediately after fulfillment.
  const positiveIds = internalProductIds.filter((id) => id > 0);
  if (positiveIds.length > 0) {
    // A bundle ProductLink has internalProductId = null, so the APPROVED
    // relation filter applies at the COMPONENT level: only re-push a bundle on
    // account of an APPROVED deducted component. (computeBundleStockStatus
    // independently forces outofstock for any bundle that contains a
    // PENDING_REVIEW component — see compute-bundle-status.ts.)
    const bundleLinks = await prisma.productLink.findMany({
      where: {
        integrationId,
        isBundle: true,
        bundleComponents: {
          some: {
            internalProductId: { in: positiveIds },
            internalProduct: { is: { approvalStatus: 'APPROVED' } },
          },
        },
      },
      select: {
        id: true,
        externalProductId: true,
        externalVariantId: true,
      },
    });

    for (const bundleLink of bundleLinks) {
      // Reuse computeBundleStockStatus — identical semantics to the full periodic sync.
      // It checks each component's on-hand ≥ component.quantity (at syncLocationId if
      // set, else sum across all locations), and returns outofstock if any component
      // is short or soft-deleted.
      const bundleStatus = await computeBundleStockStatus(
        bundleLink.id,
        integration.syncLocationId ?? null
      );
      updates.push({
        productId: bundleLink.externalProductId,
        variantId: bundleLink.externalVariantId ?? undefined,
        stockStatus: bundleStatus.status,
      });
      if (bundleStatus.warning) {
        console.warn(
          `[stock push] Bundle ${bundleLink.id} has orphan component:`,
          bundleStatus.warning
        );
      }
    }
  }

  if (updates.length === 0) return;

  // FIX I (P2): Dedup updates by (externalProductId, externalVariantId). If
  // two component IDs map to the same external product (rare but possible —
  // e.g., two ProductLinks pointing at the same WC product, or a bundle
  // referencing a component that is also externally linked), we'd otherwise
  // make redundant WC API calls.
  const seenUpdates = new Set<string>();
  const deduped: typeof updates = [];
  for (const u of updates) {
    const key = `${u.productId}::${u.variantId ?? ''}`;
    if (seenUpdates.has(key)) continue;
    seenUpdates.add(key);
    deduped.push(u);
  }

  const result = await adapter.batchUpdateProductStock(
    storeUrl,
    credentials,
    deduped
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
