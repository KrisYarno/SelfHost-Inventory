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
} from '../core/types';
import { extractWooCommerceHeaders, verifyWooCommerceWebhook } from './webhooks';

/**
 * Lane 6: the SHAPE of a WooCommerce write, with no ability to perform one.
 *
 * These are inert descriptions. Turning one into an actual HTTP request requires
 * lib/platforms/egress, which owns the credentials, the gate, the audit row, and
 * the only fetch() permitted to reach a platform host.
 */
export type WooStockWriteRequest =
  | {
      op: 'products_batch';
      updates: Array<{ id: string; stock_status: 'instock' | 'outofstock' }>;
    }
  | {
      op: 'variations_batch';
      parentId: string;
      updates: Array<{ id: string; stock_status: 'instock' | 'outofstock' }>;
    };

export type WooOrderStatusWriteRequest = {
  op: 'order_status';
  externalOrderId: string;
  status: 'processing' | 'completed';
};

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

const WooCommerceLineItemMetaSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  display_key: z.string().optional(),
  display_value: z.string().optional(),
}).passthrough();

const WooCommerceLineItemSchema = z.object({
  id: z.number(),
  product_id: z.number().nullable(),
  variation_id: z.number().nullable(), // WooCommerce uses variation_id instead of variant_id
  name: z.string(),
  sku: z.string().nullable(),
  quantity: z.number().int().positive(),
  price: z.union([z.number(), z.string()]), // Can be number or string depending on sender/plugin
  total: z.string(), // But total is a string
  // Variation attributes are in meta_data with keys like "pa_size"
  meta_data: z.array(WooCommerceLineItemMetaSchema).optional().default([]),
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
  // Write REQUEST SHAPING (Lane 6). PURE — no I/O, no credentials, no fetch.
  //
  // This adapter used to OPEN THE SOCKET: it held `fetch(url, {method:'POST'})`
  // and `fetch(url, {method:'PUT'})` with a Basic-auth header built from
  // credentials passed in by any caller. Those two call sites were the entire
  // write surface toward the live store, and nothing between a route and the wire
  // could stop them.
  //
  // The adapter now only says WHAT a WooCommerce stock/order write LOOKS like.
  // Whether it is permitted, whether it is audited, and whether a single byte
  // leaves the process is decided exclusively by lib/platforms/egress — which is
  // the only module in the codebase that may talk to a platform host.
  // ---------------------------------------------------------------------------

  /**
   * Shape a set of stock-status updates into WooCommerce wire requests.
   *
   * Amendment 11: stock_status ONLY ("instock" | "outofstock"). Never
   * manage_stock, never stock_quantity.
   * Amendment 6: simple products batch through /products/batch; variations batch
   * per-parent through /products/{parentId}/variations/batch.
   * Batch size: 50 per request (WooCommerce's practical batch limit).
   */
  buildStockStatusRequests(
    updates: Array<{
      externalProductId: string;
      externalVariationId?: string;
      inStock: boolean;
    }>
  ): WooStockWriteRequest[] {
    const status = (inStock: boolean): 'instock' | 'outofstock' =>
      inStock ? 'instock' : 'outofstock';

    const simple: Array<{ id: string; stock_status: 'instock' | 'outofstock' }> = [];
    const byParent = new Map<
      string,
      Array<{ id: string; stock_status: 'instock' | 'outofstock' }>
    >();

    for (const u of updates) {
      if (u.externalVariationId) {
        // A variation: externalProductId is the PARENT.
        const group = byParent.get(u.externalProductId) ?? [];
        group.push({
          id: u.externalVariationId,
          stock_status: status(u.inStock),
        });
        byParent.set(u.externalProductId, group);
      } else {
        simple.push({
          id: u.externalProductId,
          stock_status: status(u.inStock),
        });
      }
    }

    const chunk = <T>(arr: T[], size: number): T[][] => {
      const out: T[][] = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    };

    const BATCH_SIZE = 50;
    const requests: WooStockWriteRequest[] = [];

    for (const batch of chunk(simple, BATCH_SIZE)) {
      requests.push({ op: 'products_batch', updates: batch });
    }
    for (const [parentId, variations] of Array.from(byParent.entries())) {
      for (const batch of chunk(variations, BATCH_SIZE)) {
        requests.push({ op: 'variations_batch', parentId, updates: batch });
      }
    }

    return requests;
  }

  /** Shape an order-status write. Pure. */
  buildOrderStatusRequest(
    externalOrderId: string,
    status: 'processing' | 'completed'
  ): WooOrderStatusWriteRequest {
    return { op: 'order_status', externalOrderId, status };
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
    const isVariation = item.variation_id != null && item.variation_id > 0;

    // Extract variant name. Three sources in order of reliability:
    //   1. The " - " suffix in item.name (e.g., "Tirz - 5mg")
    //   2. The display_value fields in meta_data for variation attributes
    //      (keys starting with "pa_" are product attributes in WC)
    //   3. The raw value fields in meta_data as a last resort
    let variantName: string | null = null;
    let baseName = item.name;

    if (isVariation) {
      // Try source 1: name split
      const nameParts = item.name.split(' - ');
      if (nameParts.length > 1) {
        baseName = nameParts[0];
        variantName = nameParts.slice(1).join(' - ');
      }

      // If that didn't yield a variant name, try source 2: meta_data
      if (!variantName && item.meta_data && item.meta_data.length > 0) {
        const attrValues = item.meta_data
          .filter((m) =>
            // Variation attributes have keys like "pa_size", "pa_color"
            m.key.startsWith('pa_') ||
            // Or use display_key when it's a readable attribute name
            (m.display_key && m.display_value && !m.key.startsWith('_'))
          )
          .map((m) =>
            typeof m.display_value === 'string' && m.display_value
              ? m.display_value
              : typeof m.value === 'string' ? m.value : ''
          )
          .filter(Boolean);

        if (attrValues.length > 0) {
          variantName = attrValues.join(' / ');
        }
      }
    }

    return {
      externalId: item.id.toString(),
      externalProductId: item.product_id?.toString() || null,
      externalVariantId: isVariation ? item.variation_id!.toString() : null,
      name: baseName.trim(),
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
