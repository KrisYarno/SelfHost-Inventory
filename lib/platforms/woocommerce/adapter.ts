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
 * WooCommerce order webhook payload schemas
 * Reference: https://woocommerce.github.io/woocommerce-rest-api-docs/#order-properties
 */

const WooCommerceBillingSchema = z.object({
  first_name: z.string(),
  last_name: z.string(),
  email: z.string().email(),
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
  date_created: z.string(), // ISO 8601 timestamp
  date_created_gmt: z.string().optional(),
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
    } catch (error) {
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
      createdAt: new Date(order.date_created),
      customer: this.normalizeCustomer(order),
      lineItems: order.line_items.map(item => this.normalizeLineItem(item)),
      currency: order.currency,
      total: parseFloat(order.total),
      rawPayload: parsed,
    };
  }

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
    // WooCommerce uses customer_id: 0 for guest orders
    if (order.customer_id === 0 && !order.billing.email) {
      return null;
    }

    // Build full name from billing info
    const nameParts = [order.billing.first_name, order.billing.last_name].filter(Boolean);
    const name = nameParts.length > 0 ? nameParts.join(' ') : order.billing.email;

    return {
      email: order.billing.email,
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
