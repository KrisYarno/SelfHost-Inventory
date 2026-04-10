import prisma from "@/lib/prisma";
import { getIntegrationClient } from "@/lib/external-orders/shared";

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
  const { storeUrl, credentials } = await getIntegrationClient(integrationId);

  const auth = Buffer.from(
    `${credentials.key}:${credentials.secret}`
  ).toString("base64");

  // Build the URL: simple product or specific variation
  const path = externalVariantId
    ? `/wp-json/wc/v3/products/${externalProductId}/variations/${externalVariantId}`
    : `/wp-json/wc/v3/products/${externalProductId}`;

  const url = new URL(path, storeUrl).toString();

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
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
 */
export async function syncPricesForIntegration(
  integrationId: string
): Promise<PriceSyncResult> {
  // Find all products whose price source points at this integration
  const products = await prisma.product.findMany({
    where: {
      priceSourceLinkId: { not: null },
      priceSourceLink: {
        integrationId,
      },
      deletedAt: null,
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

      // Update retailPrice
      await prisma.product.update({
        where: { id: product.id },
        data: { retailPrice: regularPrice },
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
