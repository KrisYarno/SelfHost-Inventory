/**
 * Core type definitions for platform adapters
 * Provides a unified interface for handling webhooks from different e-commerce platforms
 */

export type PlatformType = 'SHOPIFY' | 'WOOCOMMERCE';

/**
 * Extracted webhook headers from platform-specific requests
 */
export interface WebhookHeaders {
  /** HMAC signature for verification */
  signature: string | null;
  /** Webhook topic/event type (e.g., "orders/create") */
  topic?: string;
  /** Unique event ID for deduplication */
  eventId?: string;
  /** Source shop/site identifier (Shopify: shop domain, Woo: site URL) */
  source?: string;
  /** Platform API version (when provided by sender) */
  apiVersion?: string;
}

/**
 * Result of webhook signature verification
 */
export interface WebhookVerificationResult {
  isValid: boolean;
  error?: string;
}

/**
 * Normalized customer information from platform orders
 */
export interface NormalizedCustomer {
  email: string;
  name: string;
}

/**
 * Normalized line item from platform orders
 * Standardizes product/variant information across platforms
 */
export interface NormalizedLineItem {
  /** Platform-specific line item ID */
  externalId: string;
  /** Platform-specific product ID */
  externalProductId: string | null;
  /** Platform-specific variant ID (Shopify: variant_id, WooCommerce: variation_id) */
  externalVariantId: string | null;
  /** Product name */
  name: string;
  /** Variant name/title (e.g., "Size: Large, Color: Blue") */
  variantName: string | null;
  /** SKU identifier */
  sku: string | null;
  /** Quantity ordered */
  quantity: number;
  /** Unit price (normalized to number) */
  unitPrice: number;
}

/**
 * Normalized order representation across all platforms
 * Standardizes order data for consistent processing
 */
export interface NormalizedOrder {
  /** Platform-specific order ID */
  externalId: string;
  /** Human-readable order number */
  externalOrderNumber: string;
  /** Source platform */
  platform: PlatformType;
  /** Platform-specific status (e.g., "open", "processing") */
  nativeStatus: string;
  /** Payment status (e.g., "paid", "pending", "refunded") */
  financialStatus: string | null;
  /** Fulfillment status (e.g., "fulfilled", "partial", "unfulfilled") */
  fulfillmentStatus: string | null;
  /** Order creation timestamp */
  createdAt: Date;
  /** Customer information (null for guest orders) */
  customer: NormalizedCustomer | null;
  /** Order line items */
  lineItems: NormalizedLineItem[];
  /** Currency code (e.g., "USD", "EUR") */
  currency: string;
  /** Total order amount */
  total: number;
  /** Original raw payload for reference */
  rawPayload: unknown;
}

/**
 * Platform adapter interface
 * Each platform (Shopify, WooCommerce) must implement this interface
 */
export interface PlatformAdapter {
  /** Platform identifier */
  readonly platform: PlatformType;

  /**
   * Extract webhook-specific headers from HTTP request
   * @param headers - HTTP request headers
   * @returns Extracted webhook headers
   */
  extractWebhookHeaders(headers: Headers): WebhookHeaders;

  /**
   * Verify webhook signature using HMAC
   * @param rawBody - Raw request body (must not be parsed or re-encoded)
   * @param headers - Extracted webhook headers
   * @param secret - Platform webhook secret
   * @returns Verification result
   */
  verifyWebhook(
    rawBody: string | Buffer,
    headers: WebhookHeaders,
    secret: string
  ): WebhookVerificationResult;

  /**
   * Parse order webhook payload into normalized format
   * @param rawBody - Raw webhook body
   * @returns Normalized order data
   * @throws Error if parsing fails
   */
  parseOrderWebhook(rawBody: string): NormalizedOrder;
}
