/**
 * WooCommerce platform adapter
 * Implements the PlatformAdapter interface for WooCommerce webhooks and orders
 */

import { z } from 'zod';
import type {
  PlatformAdapter,
  WebhookHeaders,
  WebhookVerificationResult,
  NormalizedOrder,
  NormalizedLineItem,
  NormalizedCustomer,
  BatchStockUpdateResult,
  OrderStatusUpdateResult,
} from '../core/types';
import { extractWooCommerceHeaders, verifyWooCommerceWebhook } from './webhooks';

/**
 * WooCommerce order webhook payload schemas
 * Reference: https://woocommerce.github.io/woocommerce-rest-api-docs/#order-properties
 */

const WooCommerceBillingSchema = z.object({
  first_name: z.string().optional().default(""),
  last_name: z.string().optional().default(""),
  // Some WooCommerce setups/plugins can send empty/invalid emails; don't reject the whole order.
  email: z.string().optional().nullable(),
});

const WooCommerceLineItemSchema = z.object({
  id: z.number(),
  product_id: z.number().nullable(),
  variation_id: z.number().nullable(), // WooCommerce uses variation_id instead of variant_id
  name: z.string(),
  sku: z.string().nullable(),
  quantity: z.number().int().positive(),
  price: z.union([z.number(), z.string()]), // Can be number or string depending on sender/plugin
  total: z.string(), // But total is a string
});

const WooCommerceOrderSchema = z.object({
  id: z.number(),
  order_key: z.string(),
  number: z.string(), // Order number as string
  status: z.string(),
  // WC returns date_created WITHOUT a TZ suffix, interpreted in shop-local
  // time. Always prefer date_created_gmt which is true UTC.
  date_created: z.string(),
  date_created_gmt: z.string().optional(),
  date_modified: z.string().optional(),
  date_modified_gmt: z.string().optional(),
  currency: z.string(),
  total: z.string(), // Total as string
  customer_id: z.number(), // 0 for guest orders
  billing: WooCommerceBillingSchema,
  line_items: z.array(WooCommerceLineItemSchema),
  payment_method: z.string().optional(),
  payment_method_title: z.string().optional(),
  transaction_id: z.string().optional(),
  date_paid: z.string().nullable().optional(),
});

type WooCommerceOrder = z.infer<typeof WooCommerceOrderSchema>;
type WooCommerceLineItem = z.infer<typeof WooCommerceLineItemSchema>;

/**
 * Parse a WooCommerce date field, preferring the GMT variant when available.
 * WC's non-GMT fields are shop-local without a TZ suffix, which JavaScript
 * misinterprets as runtime-local. The `_gmt` variants are true UTC and we
 * append `Z` so Date parses them as UTC explicitly.
 */
function parseWooDate(gmt: string | undefined, fallback: string): Date {
  if (gmt && gmt.length > 0) {
    return new Date(gmt.endsWith("Z") ? gmt : gmt + "Z");
  }
  return new Date(fallback);
}

/**
 * WooCommerce platform adapter implementation
 */
export class WooCommerceAdapter implements PlatformAdapter {
  readonly platform = 'WOOCOMMERCE' as const;

  /**
   * Extract webhook headers from WooCommerce HTTP request
   */
  extractWebhookHeaders(headers: Headers): WebhookHeaders {
    return extractWooCommerceHeaders(headers);
  }

  /**
   * Verify WooCommerce webhook signature
   */
  verifyWebhook(
    rawBody: string | Buffer,
    headers: WebhookHeaders,
    secret: string
  ): WebhookVerificationResult {
    return verifyWooCommerceWebhook(rawBody, headers, secret);
  }

  /**
   * Parse WooCommerce order webhook into normalized format
   */
  parseOrderWebhook(rawBody: string): NormalizedOrder {
    let parsed: unknown;

    // Parse JSON
    try {
      parsed = JSON.parse(rawBody);
    } catch (_error) {
      throw new Error('Invalid JSON in webhook payload');
    }

    // Validate against schema
    const result = WooCommerceOrderSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Invalid WooCommerce order payload: ${result.error.message}`);
    }

    const order = result.data;

    return {
      externalId: order.id.toString(),
      externalOrderNumber: order.number,
      platform: this.platform,
      nativeStatus: order.status,
      financialStatus: this.mapFinancialStatus(order),
      fulfillmentStatus: this.mapFulfillmentStatus(order),
      // Issue 2 fix: WC `date_created` is in shop-local time without a TZ
      // suffix, so JavaScript's `new Date()` parses it in the runtime's local
      // TZ which is wrong. `date_created_gmt` is the authoritative UTC value;
      // we append `Z` so Date parses it correctly. Fall back to date_created
      // only if the GMT variant is missing (very old WC payloads).
      createdAt: parseWooDate(order.date_created_gmt, order.date_created),
      customer: this.normalizeCustomer(order),
      lineItems: order.line_items.map(item => this.normalizeLineItem(item)),
      currency: order.currency,
      total: parseFloat(order.total),
      rawPayload: parsed,
    };
  }

  // ---------------------------------------------------------------------------
  // Write methods (Phase D)
  // ---------------------------------------------------------------------------

  /**
   * Batch-update product stock status on WooCommerce.
   *
   * Amendment 11: pushes stock_status only ("instock" | "outofstock"). Never
   * sets manage_stock or stock_quantity.
   *
   * Amendment 6: splits updates into simple products (no variantId) and
   * per-parent variation groups. Simple products go through
   * POST /wp-json/wc/v3/products/batch, variations through
   * POST /wp-json/wc/v3/products/{parentId}/variations/batch.
   *
   * Amendment 10: on 429, reads Retry-After header (default 5 s), waits, retries
   * once. Continues remaining batches even if retry fails.
   *
   * Batch size: 50 max per request. 10-second timeout per request.
   */
  async batchUpdateProductStock(
    storeUrl: string,
    credentials: { key: string; secret: string },
    updates: Array<{ productId: string; variantId?: string; stockStatus: 'instock' | 'outofstock' }>
  ): Promise<BatchStockUpdateResult> {
    const auth = Buffer.from(`${credentials.key}:${credentials.secret}`).toString('base64');
    let succeeded = 0;
    const failed: Array<{ productId: string; variantId?: string; error: string }> = [];

    // Separate simple products from variations
    const simpleUpdates: Array<{ productId: string; stockStatus: 'instock' | 'outofstock' }> = [];
    const variationGroups = new Map<string, Array<{ variantId: string; stockStatus: 'instock' | 'outofstock' }>>();

    for (const u of updates) {
      if (u.variantId) {
        // variantId is present — this is a variation; productId is the parent
        const group = variationGroups.get(u.productId) || [];
        group.push({ variantId: u.variantId, stockStatus: u.stockStatus });
        variationGroups.set(u.productId, group);
      } else {
        simpleUpdates.push({ productId: u.productId, stockStatus: u.stockStatus });
      }
    }

    // Helper: chunk an array into batches of `size`
    const chunk = <T>(arr: T[], size: number): T[][] => {
      const chunks: T[][] = [];
      for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
      }
      return chunks;
    };

    // Helper: make a WC API request with 429-retry
    const wcFetch = async (url: string, body: unknown): Promise<Response> => {
      const doFetch = () =>
        fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });

      let resp = await doFetch();

      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get('Retry-After') || '', 10);
        const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5) * 1000;
        await new Promise(resolve => setTimeout(resolve, waitMs));
        resp = await doFetch();
      }

      return resp;
    };

    // --- Simple products: POST /wp-json/wc/v3/products/batch ---
    const BATCH_SIZE = 50;
    for (const batch of chunk(simpleUpdates, BATCH_SIZE)) {
      try {
        const url = new URL('/wp-json/wc/v3/products/batch', storeUrl).toString();
        const payload = {
          update: batch.map(item => ({
            id: parseInt(item.productId, 10),
            stock_status: item.stockStatus,
          })),
        };

        const resp = await wcFetch(url, payload);

        if (!resp.ok) {
          const body = await resp.text();
          for (const item of batch) {
            failed.push({ productId: item.productId, error: `HTTP ${resp.status}: ${body.slice(0, 200)}` });
          }
          continue;
        }

        const data = (await resp.json()) as { update?: Array<{ id?: number; error?: { message?: string } }> };
        const results = data.update || [];

        // P1-1: Match results back to batch items by ID, not array index.
        // WooCommerce does not guarantee response order, and items that fail
        // with errors may be omitted. Build a map keyed on the numeric ID.
        const responseById = new Map<number, { id?: number; error?: { message?: string } }>();
        for (const r of results) {
          if (r?.id != null) {
            responseById.set(r.id, r);
          }
        }

        for (const item of batch) {
          const numericId = parseInt(item.productId, 10);
          const result = responseById.get(numericId);
          if (!result) {
            // Item missing from response entirely
            failed.push({
              productId: item.productId,
              error: 'Missing from batch response',
            });
          } else if (result.error?.message) {
            failed.push({
              productId: item.productId,
              error: result.error.message,
            });
          } else {
            succeeded++;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        for (const item of batch) {
          failed.push({ productId: item.productId, error: message });
        }
      }
    }

    // --- Variations: POST /wp-json/wc/v3/products/{parentId}/variations/batch ---
    for (const [parentId, variations] of Array.from(variationGroups.entries())) {
      for (const batch of chunk(variations, BATCH_SIZE)) {
        try {
          const url = new URL(`/wp-json/wc/v3/products/${parentId}/variations/batch`, storeUrl).toString();
          const payload = {
            update: batch.map(item => ({
              id: parseInt(item.variantId, 10),
              stock_status: item.stockStatus,
            })),
          };

          const resp = await wcFetch(url, payload);

          if (!resp.ok) {
            const body = await resp.text();
            for (const item of batch) {
              // P1-7: Populate both productId (parent) and variantId so callers
              // can locate the failure in logs and UI without a lookup.
              failed.push({
                productId: parentId,
                variantId: item.variantId,
                error: `HTTP ${resp.status}: ${body.slice(0, 200)}`,
              });
            }
            continue;
          }

          const data = (await resp.json()) as { update?: Array<{ id?: number; error?: { message?: string } }> };
          const results = data.update || [];

          // P1-1: Match results by ID not index
          const responseById = new Map<number, { id?: number; error?: { message?: string } }>();
          for (const r of results) {
            if (r?.id != null) {
              responseById.set(r.id, r);
            }
          }

          for (const item of batch) {
            const numericVariantId = parseInt(item.variantId, 10);
            const result = responseById.get(numericVariantId);
            if (!result) {
              failed.push({
                productId: parentId,
                variantId: item.variantId,
                error: 'Missing from batch response',
              });
            } else if (result.error?.message) {
              failed.push({
                productId: parentId,
                variantId: item.variantId,
                error: result.error.message,
              });
            } else {
              succeeded++;
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          for (const item of batch) {
            failed.push({
              productId: parentId,
              variantId: item.variantId,
              error: message,
            });
          }
        }
      }
    }

    return { succeeded, failed };
  }

  /**
   * Update an order's status on WooCommerce.
   * PUT /wp-json/wc/v3/orders/{orderId} with { status }.
   * 10-second timeout. Basic Auth. Honors Retry-After on 429 and retries once.
   */
  async updateOrderStatus(
    storeUrl: string,
    credentials: { key: string; secret: string },
    orderId: string,
    status: string
  ): Promise<OrderStatusUpdateResult> {
    const auth = Buffer.from(`${credentials.key}:${credentials.secret}`).toString('base64');

    try {
      const url = new URL(`/wp-json/wc/v3/orders/${orderId}`, storeUrl).toString();

      const doFetch = () =>
        fetch(url, {
          method: 'PUT',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status }),
          signal: AbortSignal.timeout(10_000),
        });

      let resp = await doFetch();

      // Honor Retry-After on 429 (matches batchUpdateProductStock behavior)
      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get('Retry-After') || '', 10);
        const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5) * 1000;
        await new Promise(resolve => setTimeout(resolve, waitMs));
        resp = await doFetch();
      }

      if (!resp.ok) {
        const body = await resp.text();
        return { success: false, error: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
      }

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Map WooCommerce order status to financial status
   * WooCommerce statuses: pending, processing, on-hold, completed, cancelled, refunded, failed
   */
  private mapFinancialStatus(order: WooCommerceOrder): string | null {
    const status = order.status.toLowerCase();

    // Map to financial status equivalents
    switch (status) {
      case 'completed':
      case 'processing':
        return 'paid';
      case 'refunded':
        return 'refunded';
      case 'pending':
      case 'on-hold':
        return 'pending';
      case 'cancelled':
      case 'failed':
        return 'voided';
      default:
        return status;
    }
  }

  /**
   * Map WooCommerce order status to fulfillment status
   */
  private mapFulfillmentStatus(order: WooCommerceOrder): string | null {
    const status = order.status.toLowerCase();

    // Map to fulfillment status equivalents
    switch (status) {
      case 'completed':
        return 'fulfilled';
      case 'processing':
      case 'on-hold':
        return 'unfulfilled';
      case 'cancelled':
      case 'failed':
      case 'refunded':
        return 'cancelled';
      case 'pending':
        return 'unfulfilled';
      default:
        return null;
    }
  }

  /**
   * Normalize WooCommerce customer to common format
   */
  private normalizeCustomer(order: WooCommerceOrder): NormalizedCustomer | null {
    const email = (order.billing.email || "").trim();
    // WooCommerce uses customer_id: 0 for guest orders
    if (order.customer_id === 0 && !email) return null;
    if (!email) return null;

    // Build full name from billing info
    const nameParts = [order.billing.first_name, order.billing.last_name].filter(Boolean);
    const name = nameParts.length > 0 ? nameParts.join(' ') : email;

    return {
      email,
      name,
    };
  }

  /**
   * Normalize WooCommerce line item to common format
   */
  private normalizeLineItem(item: WooCommerceLineItem): NormalizedLineItem {
    // Extract variant name if it's a variation
    let variantName: string | null = null;
    if (item.variation_id && item.variation_id > 0) {
      // WooCommerce includes variation attributes in the name
      // e.g., "Product Name - Color: Blue, Size: Large"
      const nameParts = item.name.split(' - ');
      if (nameParts.length > 1) {
        variantName = nameParts.slice(1).join(' - ');
      }
    }

    return {
      externalId: item.id.toString(),
      externalProductId: item.product_id?.toString() || null,
      externalVariantId: item.variation_id && item.variation_id > 0 ? item.variation_id.toString() : null,
      name: item.name.split(' - ')[0], // Extract base product name
      variantName,
      sku: item.sku,
      quantity: item.quantity,
      unitPrice: typeof item.price === 'string' ? parseFloat(item.price) : item.price,
    };
  }
}

/**
 * Singleton instance
 */
export const wooCommerceAdapter = new WooCommerceAdapter();
