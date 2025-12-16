/**
 * WooCommerce webhook verification utilities
 * Implements HMAC-SHA256 signature verification for WooCommerce webhooks
 * Reference: https://woocommerce.com/document/webhooks/#section-6
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { WebhookHeaders, WebhookVerificationResult } from '../core/types';

/**
 * Extract WooCommerce-specific webhook headers from HTTP request
 */
export function extractWooCommerceHeaders(headers: Headers): WebhookHeaders {
  return {
    signature: headers.get('X-WC-Webhook-Signature'),
    topic: headers.get('X-WC-Webhook-Topic') || undefined,
    eventId: headers.get('X-WC-Webhook-ID') || undefined,
    source: headers.get('X-WC-Webhook-Source') || undefined,
  };
}

/**
 * Verify WooCommerce webhook signature using HMAC-SHA256
 * WooCommerce sends the signature as a base64-encoded HMAC-SHA256 hash
 *
 * @param rawBody - Raw request body (must not be parsed)
 * @param headers - Extracted webhook headers
 * @param secret - WooCommerce webhook secret from webhook settings
 * @returns Verification result
 */
export function verifyWooCommerceWebhook(
  rawBody: string | Buffer,
  headers: WebhookHeaders,
  secret: string
): WebhookVerificationResult {
  // Validate inputs
  const receivedSignature = headers.signature?.trim();
  if (!receivedSignature) {
    return {
      isValid: false,
      error: 'Missing X-WC-Webhook-Signature header',
    };
  }

  if (!secret) {
    return {
      isValid: false,
      error: 'Webhook secret is not configured',
    };
  }

  if (!rawBody || (typeof rawBody === 'string' && rawBody.length === 0)) {
    return {
      isValid: false,
      error: 'Request body is empty',
    };
  }

  try {
    const receivedHash = Buffer.from(receivedSignature, 'base64');
    const computedHash = createHmac('sha256', secret).update(rawBody).digest();

    if (receivedHash.length !== computedHash.length) {
      return {
        isValid: false,
        error: 'Invalid signature length',
      };
    }

    if (!timingSafeEqual(computedHash, receivedHash)) {
      return {
        isValid: false,
        error: 'HMAC signature mismatch',
      };
    }

    return { isValid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      isValid: false,
      error: `Verification failed: ${message}`,
    };
  }
}
