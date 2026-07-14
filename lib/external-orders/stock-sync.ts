import prisma from "@/lib/prisma";
import { getIntegrationClient } from "@/lib/external-orders/shared";
import { pushStockStatus, type EgressResult } from "@/lib/platforms/egress";
import { computeBundleStockStatus } from "@/lib/stock-sync/compute-bundle-status";
import type { PlatformType } from "@/lib/platforms/core/types";

/**
 * Unpack WooCommerce's batch response into per-ITEM outcomes.
 *
 * WC answers a batch write with `{ update: [{ id, error? }, ...] }` and does NOT
 * guarantee response order, so items are matched by id, never by index. An item
 * omitted from the response entirely is a failure — we asked WC to change it and
 * WC did not say it did.
 */
function unpackBatchBody(
  body: unknown,
  requested: Array<{ externalProductId: string; externalVariationId?: string }>
): { succeeded: number; errors: Array<{ productId: string; error: string }> } | null {
  const update = (body as { update?: unknown })?.update;
  if (!Array.isArray(update)) return null;

  const byId = new Map<string, { id?: number; error?: { message?: string } }>();
  for (const row of update as Array<{ id?: number; error?: { message?: string } }>) {
    if (row?.id != null) byId.set(String(row.id), row);
  }

  let succeeded = 0;
  const errors: Array<{ productId: string; error: string }> = [];

  for (const item of requested) {
    // For a variation the WC batch is keyed on the VARIATION id; for a simple
    // product, on the product id.
    const wireId = item.externalVariationId ?? item.externalProductId;
    const row = byId.get(wireId);
    if (!row) {
      errors.push({
        productId: item.externalProductId,
        error: "Missing from batch response",
      });
    } else if (row.error?.message) {
      errors.push({ productId: item.externalProductId, error: row.error.message });
    } else {
      succeeded += 1;
    }
  }

  return { succeeded, errors };
}

/**
 * Lane 6: flatten an egress fan-out into this module's historical
 * {succeeded, failed} shape.
 *
 * `pushStockStatus` returns one result PER WIRE REQUEST (REV-2 #5) precisely so
 * that a partially-blocked push cannot be read as a success. We preserve that
 * here: a BLOCKED batch is reported as an error with its named reason, never as
 * a silent no-op, so `lastStockSyncError` tells the operator the truth ("blocked:
 * master_off") instead of pretending the store is in sync.
 *
 * Per-item fidelity is preserved too: a `sent` batch is unpacked so that
 * "WC rejected product 20" still reaches lastStockSyncError, exactly as it did
 * when the adapter parsed the response itself.
 */
function summarizeEgress(
  result: EgressResult,
  requested: Array<{ externalProductId: string; externalVariationId?: string }>
): {
  succeeded: number;
  errors: Array<{ productId: string; error: string }>;
} {
  const errors: Array<{ productId: string; error: string }> = [];
  let succeeded = 0;

  const walk = (r: EgressResult): void => {
    switch (r.status) {
      case "partial":
        r.results.forEach(walk);
        break;
      case "sent": {
        const unpacked = unpackBatchBody(r.body, requested);
        if (unpacked) {
          succeeded += unpacked.succeeded;
          errors.push(...unpacked.errors);
        } else {
          // Not a batch-shaped body (or an empty one). We know the wire call
          // succeeded; we cannot attribute it per item.
          succeeded += 1;
        }
        break;
      }
      case "blocked":
        errors.push({ productId: "*", error: `blocked: ${r.reason}` });
        break;
      case "dry_run":
        errors.push({
          productId: "*",
          error: `dry-run (nothing sent): ${r.wouldSend.method} ${r.wouldSend.url}`,
        });
        break;
      case "failed":
        errors.push({
          productId: "*",
          error: `failed: ${r.reason}${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ""}`,
        });
        break;
    }
  };

  walk(result);
  return { succeeded, errors };
}


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
 * Amendment 8:  syncLocationId narrows stock to one location when set.
 * Amendment 11: Push stock_status only (instock/outofstock), never stock_quantity.
 *
 * Lane 6: this function computes WHAT the stock statuses are and hands them to
 * `egress.pushStockStatus`, which decides whether a single byte may leave. The
 * `stockSyncEnabled` check below is an EARLY EXIT for efficiency and a clearer
 * error message — it is NOT the gate. The gate is inside egress and is
 * re-evaluated from a fresh DB read before every wire request, so removing this
 * check could not cause an unauthorized write.
 */
export async function syncStockToExternal(
  integrationId: string
): Promise<StockSyncResult> {
  // 1. Load integration metadata (no credentials — REV-2 #9)
  const { integration } = await getIntegrationClient(integrationId);

  const platform = integration.platform as PlatformType;

  // 2. Early exit when the integration's own flag is off. Not a security
  //    boundary (egress re-checks it); just don't do the work.
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
  //    Amendment 11: map to stock_status (instock / outofstock).
  const updates: Array<{
    externalProductId: string;
    externalVariationId?: string;
    inStock: boolean;
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
      externalProductId: link.externalProductId,
      externalVariationId: link.externalVariantId ?? undefined,
      inStock: totalStock > 0,
    });
  }

  const bundleHealthWarnings: Array<{
    productLinkId: string;
    warning: { kind: string; internalProductId: number };
  }> = [];

  for (const bl of bundleLinks) {
    const result = await computeBundleStockStatus(bl.id, integration.syncLocationId ?? null);
    updates.push({
      externalProductId: bl.externalProductId,
      externalVariationId: bl.externalVariantId ?? undefined,
      inStock: result.status === 'instock',
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

  // 5. Hand the computed statuses to the chokepoint. It gates, audits, and (only
  //    if every gate passes) sends. A non-WooCommerce integration is blocked here
  //    with `wrong_platform` rather than by a "not implemented" adapter stub.
  try {
    const result = await pushStockStatus(integrationId, updates);
    const { succeeded, errors } = summarizeEgress(result, updates);

    // 6. Update integration telemetry.
    const now = new Date();
    if (errors.length === 0) {
      await prisma.integration.update({
        where: { id: integrationId },
        data: {
          lastStockSyncAt: now,
          lastStockSyncError: null,
        },
      });
    } else {
      const errorJson = JSON.stringify({
        failedProducts: errors.slice(0, 50),
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
      synced: succeeded,
      failed: errors.length,
      errors,
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

  // Metadata only — no credentials (REV-2 #9).
  const { integration } = await getIntegrationClient(integrationId);

  // Early exit only. The real gate is inside egress (re-read per wire request).
  if (!integration.stockSyncEnabled) return;

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
    externalProductId: string;
    externalVariationId?: string;
    inStock: boolean;
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
      externalProductId: link.externalProductId,
      externalVariationId: link.externalVariantId ?? undefined,
      inStock: totalStock > 0,
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
        externalProductId: bundleLink.externalProductId,
        externalVariationId: bundleLink.externalVariantId ?? undefined,
        inStock: bundleStatus.status === 'instock',
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
    const key = `${u.externalProductId}::${u.externalVariationId ?? ''}`;
    if (seenUpdates.has(key)) continue;
    seenUpdates.add(key);
    deduped.push(u);
  }

  const result = await pushStockStatus(integrationId, deduped);
  const { succeeded, errors } = summarizeEgress(result, deduped);

  if (errors.length > 0) {
    // Includes BLOCKED batches. This is a fire-and-forget path, so the log is the
    // only surface — say plainly that nothing was sent rather than staying quiet
    // and letting the operator assume WooCommerce is in sync.
    console.warn(
      `[stock push] ${errors.length} batch(es) did not reach integration ${integrationId}:`,
      errors.slice(0, 5)
    );
  } else {
    console.log(
      `[stock push] Pushed ${succeeded} batch(es) of stock status for integration ${integrationId}`
    );
  }
}
