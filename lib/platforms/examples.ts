/**
 * Example usage patterns for platform adapters
 * These examples demonstrate how to use the platform adapters in real-world scenarios
 */

import { getPlatformAdapter, type NormalizedOrder } from './core';
import { encryptValue, decryptValue } from '../encryption';

/**
 * Example 1: Webhook Handler
 * Process incoming webhooks from e-commerce platforms
 */
export async function handleWebhookExample(request: Request) {
  // Extract platform from URL or header
  const url = new URL(request.url);
  const platform = url.pathname.includes('shopify') ? 'SHOPIFY' : 'WOOCOMMERCE';

  // Get the appropriate adapter
  const adapter = getPlatformAdapter(platform);

  // Read raw body (IMPORTANT: Don't parse as JSON yet!)
  const rawBody = await request.text();

  // Extract webhook headers
  const webhookHeaders = adapter.extractWebhookHeaders(request.headers);

  // Get webhook secret from environment
  const webhookSecret = platform === 'SHOPIFY'
    ? process.env.SHOPIFY_WEBHOOK_SECRET!
    : process.env.WOOCOMMERCE_WEBHOOK_SECRET!;

  // Verify webhook signature
  const verification = adapter.verifyWebhook(rawBody, webhookHeaders, webhookSecret);

  if (!verification.isValid) {
    console.error('Webhook verification failed:', verification.error);
    return new Response(
      JSON.stringify({ error: 'Invalid webhook signature' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Parse the order webhook
  try {
    const normalizedOrder = adapter.parseOrderWebhook(rawBody);

    // Process the order (same code works for both platforms!)
    await processOrder(normalizedOrder);

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Failed to parse webhook:', error);
    return new Response(
      JSON.stringify({ error: 'Invalid webhook payload' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Example 2: Processing Normalized Orders
 * Handle orders consistently regardless of platform
 */
async function processOrder(order: NormalizedOrder) {
  console.log(`Processing ${order.platform} order ${order.externalOrderNumber}`);

  // Deduplication check using eventId from webhook
  // (You'd typically store this in your database)

  // Create order in your system
  // await prisma.order.create({
  //   data: {
  //     externalId: order.externalId,
  //     externalOrderNumber: order.externalOrderNumber,
  //     platform: order.platform,
  //     status: order.nativeStatus,
  //     financialStatus: order.financialStatus,
  //     fulfillmentStatus: order.fulfillmentStatus,
  //     currency: order.currency,
  //     total: order.total,
  //     customerEmail: order.customer?.email,
  //     customerName: order.customer?.name,
  //     rawPayload: order.rawPayload,
  //   },
  // });

  // Process line items
  for (const item of order.lineItems) {
    console.log(`- ${item.quantity}x ${item.name} (${item.sku || 'no SKU'})`);

    // Update inventory
    // await updateInventory(item.sku, -item.quantity);
  }

  // Send confirmation email to customer
  if (order.customer?.email) {
    // await sendOrderConfirmation(order.customer.email, order);
  }
}

/**
 * Example 3: Storing Encrypted Platform Credentials
 * Securely store API keys and secrets
 */
export async function savePlatformCredentialsExample(
  platform: 'SHOPIFY' | 'WOOCOMMERCE',
  credentials: {
    shopDomain?: string;
    apiKey: string;
    apiSecret: string;
    webhookSecret: string;
  }
) {
  // Encrypt sensitive credentials before storing
  const encryptedApiKey = encryptValue(credentials.apiKey);
  const encryptedApiSecret = encryptValue(credentials.apiSecret);
  const encryptedWebhookSecret = encryptValue(credentials.webhookSecret);

  // Store in database
  // await prisma.platformConfig.create({
  //   data: {
  //     platform,
  //     shopDomain: credentials.shopDomain,
  //     apiKeyEncrypted: encryptedApiKey,
  //     apiSecretEncrypted: encryptedApiSecret,
  //     webhookSecretEncrypted: encryptedWebhookSecret,
  //     isActive: true,
  //   },
  // });

  console.log(`${platform} credentials saved securely`);
}

/**
 * Example 4: Fetching Platform Data with Decrypted Credentials
 * Use encrypted credentials for API calls
 */
export async function fetchPlatformOrdersExample(platformConfigId: number) {
  // Retrieve encrypted configuration
  // const config = await prisma.platformConfig.findUnique({
  //   where: { id: platformConfigId },
  // });

  // For demonstration, simulating a config object
  const config = {
    platform: 'SHOPIFY' as const,
    shopDomain: 'example.myshopify.com',
    apiKeyEncrypted: 'encrypted_key_here',
  };

  // Decrypt API credentials just-in-time
  const apiKey = decryptValue(config.apiKeyEncrypted);

  // Use decrypted credentials
  if (config.platform === 'SHOPIFY') {
    const response = await fetch(
      `https://${config.shopDomain}/admin/api/2025-10/orders.json`,
      {
        headers: {
          'X-Shopify-Access-Token': apiKey,
          'Content-Type': 'application/json',
        },
      }
    );

    const data = await response.json();
    return data.orders;
  }

  // Similar logic for WooCommerce
  // if (config.platform === 'WOOCOMMERCE') { ... }
}

/**
 * Example 5: Multi-Platform Order Sync
 * Sync orders from multiple platforms into a unified system
 */
export async function syncOrdersFromAllPlatformsExample() {
  // Get all active platform configurations
  // const configs = await prisma.platformConfig.findMany({
  //   where: { isActive: true },
  // });

  const configs = [
    { id: 1, platform: 'SHOPIFY' as const },
    { id: 2, platform: 'WOOCOMMERCE' as const },
  ];

  for (const config of configs) {
    console.log(`Syncing orders from ${config.platform}...`);

    try {
      // Fetch orders from platform
      const orders = await fetchPlatformOrdersExample(config.id);

      // Process each order (they're already normalized!)
      // for (const order of orders) {
      //   const adapter = getPlatformAdapter(config.platform);
      //   const normalized = adapter.parseOrderWebhook(JSON.stringify(order));
      //   await processOrder(normalized);
      // }

      console.log(`Successfully synced ${config.platform} orders`);
    } catch (error) {
      console.error(`Failed to sync ${config.platform} orders:`, error);
    }
  }
}

/**
 * Example 6: Webhook Event Deduplication
 * Prevent processing duplicate webhooks using eventId
 */
export async function deduplicateWebhookExample(
  platform: 'SHOPIFY' | 'WOOCOMMERCE',
  headers: Headers
) {
  const adapter = getPlatformAdapter(platform);
  const webhookHeaders = adapter.extractWebhookHeaders(headers);

  if (!webhookHeaders.eventId) {
    console.warn('No event ID in webhook headers');
    return false;
  }

  // Check if we've already processed this event
  // const existing = await prisma.webhookEvent.findUnique({
  //   where: {
  //     platform_eventId: {
  //       platform,
  //       eventId: webhookHeaders.eventId,
  //     },
  //   },
  // });

  // if (existing) {
  //   console.log(`Duplicate webhook event ${webhookHeaders.eventId}, skipping`);
  //   return true; // Already processed
  // }

  // Store event ID to prevent future duplicates
  // await prisma.webhookEvent.create({
  //   data: {
  //     platform,
  //     eventId: webhookHeaders.eventId,
  //     topic: webhookHeaders.topic,
  //     processedAt: new Date(),
  //   },
  // });

  return false; // Not a duplicate
}

/**
 * Example 7: Testing Webhook Verification Locally
 * Generate test webhooks for development
 */
export function generateTestWebhookExample() {
  const { createHmac } = require('crypto');

  // Sample Shopify order payload
  const payload = JSON.stringify({
    id: 12345,
    order_number: 1001,
    name: '#1001',
    financial_status: 'paid',
    fulfillment_status: null,
    created_at: new Date().toISOString(),
    currency: 'USD',
    total_price: '99.99',
    customer: {
      id: 1,
      email: 'customer@example.com',
      first_name: 'John',
      last_name: 'Doe',
    },
    line_items: [
      {
        id: 1,
        product_id: 100,
        variant_id: 200,
        title: 'Test Product',
        variant_title: 'Large',
        sku: 'TEST-SKU-001',
        quantity: 2,
        price: '49.99',
      },
    ],
  });

  // Generate HMAC signature
  const secret = 'test-webhook-secret';
  const hmac = createHmac('sha256', secret);
  hmac.update(payload, 'utf8');
  const signature = hmac.digest('base64');

  // Create test request
  return {
    body: payload,
    headers: {
      'X-Shopify-Hmac-Sha256': signature,
      'X-Shopify-Topic': 'orders/create',
      'X-Shopify-Webhook-Id': 'test-webhook-123',
    },
  };
}
