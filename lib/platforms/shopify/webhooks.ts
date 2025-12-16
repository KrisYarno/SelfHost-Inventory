/**
 * Shopify webhook verification utilities
 * Implements HMAC-SHA256 signature verification for Shopify webhooks
 * Reference: https://shopify.dev/docs/apps/build/webhooks/subscribe/https#step-5-verify-the-webhook
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { WebhookHeaders, WebhookVerificationResult } from '../core/types';

/**
 * Extract Shopify-specific webhook headers from HTTP request
 */
export function extractShopifyHeaders(headers: Headers): WebhookHeaders {
  return {
    signature: headers.get('X-Shopify-Hmac-Sha256'),
    topic: headers.get('X-Shopify-Topic') || undefined,
    eventId: headers.get('X-Shopify-Webhook-Id') || undefined,
    source: headers.get('X-Shopify-Shop-Domain') || undefined,
    apiVersion:
      headers.get('X-Shopify-Api-Version') ||
      headers.get('X-Shopify-API-Version') ||
      undefined,
  };
}

/**
 * Verify Shopify webhook signature using HMAC-SHA256
 * Shopify sends the signature as a base64-encoded HMAC-SHA256 hash
 *
 * @param rawBody - Raw request body (must not be parsed)
 * @param headers - Extracted webhook headers
 * @param secret - Shopify webhook secret from app settings
 * @returns Verification result
 */
export function verifyShopifyWebhook(
  rawBody: string | Buffer,
  headers: WebhookHeaders,
  secret: string
): WebhookVerificationResult {
  // Validate inputs
  const receivedSignature = headers.signature?.trim();
  if (!receivedSignature) {
    return {
      isValid: false,
      error: 'Missing X-Shopify-Hmac-Sha256 header',
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
