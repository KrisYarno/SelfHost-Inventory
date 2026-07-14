import prisma from "@/lib/prisma";
import { platformRead } from "@/lib/platforms/egress";
import { recordChange, newBatchId } from "@/lib/change-tracking";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PriceSyncResult = {
  synced: number;
  skipped: number;
  failed: Array<{ productId: number; productName: string; error: string }>;
};

// ---------------------------------------------------------------------------
// fetchExternalProductPrice
// ---------------------------------------------------------------------------

/**
 * Fetch the current regular_price for a single external product from WC.
 * Returns null if the price is missing, empty, or zero (we never want to
 * zero out a retailPrice from a bad WC response).
 *
 * For simple products: GET /wp-json/wc/v3/products/{id}
 * For variations:      GET /wp-json/wc/v3/products/{parentId}/variations/{variantId}
 */
export async function fetchExternalProductPrice(
  integrationId: string,
  externalProductId: string,
  externalVariantId?: string | null
): Promise<{ regularPrice: number | null; error?: string }> {
  // Lane 6: the sixth egress path (codex #8). It used to hand-roll its own Basic
  // auth header from `getIntegrationClient().credentials` and call fetch — one of
  // three independent "authenticate and call the store" patterns. It now uses the
  // READ credential through the chokepoint.
  const path = externalVariantId
    ? `/wp-json/wc/v3/products/${encodeURIComponent(externalProductId)}/variations/${encodeURIComponent(externalVariantId)}`
    : `/wp-json/wc/v3/products/${encodeURIComponent(externalProductId)}`;

  try {
    const resp = await platformRead(integrationId, path, undefined, {
      timeoutMs: 10_000,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return {
        regularPrice: null,
        error: `HTTP ${resp.status}: ${body.slice(0, 200)}`,
      };
    }

    const data = (await resp.json()) as Record<string, unknown>;
    const raw = data.regular_price;

    // WC sends regular_price as a string. Parse and validate.
    if (raw === undefined || raw === null || raw === "") {
      return { regularPrice: null, error: "regular_price is empty" };
    }

    const parsed = typeof raw === "number" ? raw : parseFloat(String(raw));

    if (!Number.isFinite(parsed) || parsed <= 0) {
      return {
        regularPrice: null,
        error: `regular_price is invalid or zero: ${String(raw)}`,
      };
    }

    return { regularPrice: parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { regularPrice: null, error: message };
  }
}

// ---------------------------------------------------------------------------
// syncPricesForIntegration
// ---------------------------------------------------------------------------

/**
 * Bulk-sync retail prices for all products that have a priceSourceLink
 * belonging to the given integration. Fetches each product's regular_price
 * from WC and updates retailPrice. Best-effort: individual failures do not
 * abort the batch.
 *
 * Change-tracking (D10, R-D2): unlike mass-update, a price sync has NO per-row
 * ledger fallback — the recorded event is the ONLY record of a money-field
 * change — so each changed product records a PRODUCT_UPDATE via `recordChange`
 * INSIDE its own per-product transaction (hard-abort per product; the batch
 * stays best-effort because a per-product throw only fails that product). The
 * actor kind follows the trigger: `{ userId }` → USER (manual admin route),
 * `{}` → SYSTEM (a future cron caller).
 */
export async function syncPricesForIntegration(
  integrationId: string,
  actor: { userId?: number } = {}
): Promise<PriceSyncResult> {
  // Find all products whose price source points at this integration
  const products = await prisma.product.findMany({
    where: {
      priceSourceLinkId: { not: null },
      priceSourceLink: {
        integrationId,
      },
      deletedAt: null,
      // Provisional products are never pushed outward to external platforms.
      approvalStatus: "APPROVED",
    },
    include: {
      priceSourceLink: {
        select: {
          id: true,
          externalProductId: true,
          externalVariantId: true,
          externalTitle: true,
        },
      },
    },
  });

  if (products.length === 0) {
    return { synced: 0, skipped: 0, failed: [] };
  }

  // Platform label for the human-readable action string (one query per run).
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { platform: true },
  });
  const platform = integration?.platform ?? "external platform";

  // ONE batch id groups every price-change event from this run (R-D14 grouping).
  const batchId = newBatchId();

  let synced = 0;
  let skipped = 0;
  const failed: PriceSyncResult["failed"] = [];

  for (const product of products) {
    const link = product.priceSourceLink!;

    try {
      const { regularPrice, error } = await fetchExternalProductPrice(
        integrationId,
        link.externalProductId,
        link.externalVariantId
      );

      if (regularPrice === null) {
        skipped++;
        if (error) {
          console.warn(
            `[price-sync] Skipping ${product.name} (${product.id}): ${error}`
          );
        }
        continue;
      }

      // ER-B9 no-op rule: if the retail price already matches, skip entirely —
      // no update, no event. Normalize both sides via String() so a Prisma
      // Decimal never false-differs from the parsed number.
      const fromValue = String(product.retailPrice);
      const toValue = String(regularPrice);
      if (fromValue === toValue) {
        skipped++;
        continue;
      }

      // Update retailPrice + record the change on the SAME per-product tx
      // (R-D2 hard-abort per product; a throw lands this product in failed[]
      // and the loop continues — the batch stays best-effort).
      await prisma.$transaction(async (tx) => {
        await tx.product.update({
          where: { id: product.id },
          data: { retailPrice: regularPrice },
        });
        await recordChange(tx, {
          actor: actor.userId ? { userId: actor.userId } : { kind: "SYSTEM" },
          actionType: "PRODUCT_UPDATE",
          entityType: "PRODUCT",
          entityId: product.id,
          action: `Synced retail price for "${product.name}" from ${platform}`,
          changes: { retailPrice: { from: fromValue, to: toValue } },
          details: {
            trigger: actor.userId ? "manual" : "cron",
            integrationId,
          },
          batchId,
        });
      });

      synced++;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      failed.push({
        productId: product.id,
        productName: product.name,
        error: message,
      });
    }
  }

  return { synced, skipped, failed };
}
