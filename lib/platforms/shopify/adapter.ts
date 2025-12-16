/**
 * Shopify platform adapter
 * Implements the PlatformAdapter interface for Shopify webhooks and orders
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
import { extractShopifyHeaders, verifyShopifyWebhook } from './webhooks';

/**
 * Shopify order webhook payload schemas
 * Reference: https://shopify.dev/docs/api/admin-rest/latest/resources/webhook#event-topics-orders-create
 */

const ShopifyCustomerSchema = z.object({
  id: z.number(),
  email: z.string().email().nullable(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
}).nullable();

const ShopifyLineItemSchema = z.object({
  id: z.number(),
  product_id: z.number().nullable(),
  variant_id: z.number().nullable(),
  title: z.string(),
  variant_title: z.string().nullable(),
  sku: z.string().nullable(),
  quantity: z.number().int().positive(),
  price: z.string(), // Shopify sends prices as strings
});

const ShopifyOrderSchema = z.object({
  id: z.number(),
  order_number: z.number(),
  name: z.string(), // e.g., "#1001"
  financial_status: z.string().nullable(),
  fulfillment_status: z.string().nullable(),
  created_at: z.string(), // ISO 8601 timestamp
  currency: z.string(),
  total_price: z.string(), // Shopify sends prices as strings
  customer: ShopifyCustomerSchema,
  line_items: z.array(ShopifyLineItemSchema),
});

type ShopifyOrder = z.infer<typeof ShopifyOrderSchema>;
type ShopifyLineItem = z.infer<typeof ShopifyLineItemSchema>;
type ShopifyCustomer = z.infer<typeof ShopifyCustomerSchema>;

/**
 * Shopify platform adapter implementation
 */
export class ShopifyAdapter implements PlatformAdapter {
  readonly platform = 'SHOPIFY' as const;

  /**
   * Extract webhook headers from Shopify HTTP request
   */
  extractWebhookHeaders(headers: Headers): WebhookHeaders {
    return extractShopifyHeaders(headers);
  }

  /**
   * Verify Shopify webhook signature
   */
  verifyWebhook(
    rawBody: string | Buffer,
    headers: WebhookHeaders,
    secret: string
  ): WebhookVerificationResult {
    return verifyShopifyWebhook(rawBody, headers, secret);
  }

  /**
   * Parse Shopify order webhook into normalized format
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
    const result = ShopifyOrderSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Invalid Shopify order payload: ${result.error.message}`);
    }

    const order = result.data;

    return {
      externalId: order.id.toString(),
      externalOrderNumber: order.name,
      platform: this.platform,
      nativeStatus: this.extractNativeStatus(order),
      financialStatus: order.financial_status,
      fulfillmentStatus: order.fulfillment_status,
      createdAt: new Date(order.created_at),
      customer: this.normalizeCustomer(order.customer),
      lineItems: order.line_items.map(item => this.normalizeLineItem(item)),
      currency: order.currency,
      total: parseFloat(order.total_price),
      rawPayload: parsed,
    };
  }

  /**
   * Extract native status from Shopify order
   * Shopify doesn't have a single "status" field, so we derive it from financial/fulfillment status
   */
  private extractNativeStatus(order: ShopifyOrder): string {
    // Prioritize fulfillment status if present
    if (order.fulfillment_status) {
      return order.fulfillment_status;
    }

    // Fall back to financial status
    if (order.financial_status) {
      return order.financial_status;
    }

    // Default to "open" (Shopify's default state)
    return 'open';
  }

  /**
   * Normalize Shopify customer to common format
   */
  private normalizeCustomer(customer: ShopifyCustomer): NormalizedCustomer | null {
    if (!customer) {
      return null;
    }

    // Shopify requires email for registered customers
    if (!customer.email) {
      return null;
    }

    // Build full name
    const nameParts = [customer.first_name, customer.last_name].filter(Boolean);
    const name = nameParts.length > 0 ? nameParts.join(' ') : customer.email;

    return {
      email: customer.email,
      name,
    };
  }

  /**
   * Normalize Shopify line item to common format
   */
  private normalizeLineItem(item: ShopifyLineItem): NormalizedLineItem {
    return {
      externalId: item.id.toString(),
      externalProductId: item.product_id?.toString() || null,
      externalVariantId: item.variant_id?.toString() || null,
      name: item.title,
      variantName: item.variant_title,
      sku: item.sku,
      quantity: item.quantity,
      unitPrice: parseFloat(item.price),
    };
  }
}

/**
 * Singleton instance
 */
export const shopifyAdapter = new ShopifyAdapter();
