# Platform Adapters

This directory contains platform-specific adapters for handling webhooks from different e-commerce platforms.

## Structure

```
lib/platforms/
├── core/
│   ├── types.ts          # Core type definitions and interfaces
│   ├── registry.ts       # Platform adapter registry/factory
│   └── index.ts          # Core exports
├── shopify/
│   ├── adapter.ts        # Shopify platform implementation
│   ├── webhooks.ts       # Shopify webhook verification
│   └── index.ts          # Shopify exports
├── woocommerce/
│   ├── adapter.ts        # WooCommerce platform implementation
│   ├── webhooks.ts       # WooCommerce webhook verification
│   └── index.ts          # WooCommerce exports
└── index.ts              # Main entry point
```

## Usage

### Getting a Platform Adapter

```typescript
import { getPlatformAdapter } from '@/lib/platforms';

// Get adapter by platform type
const adapter = getPlatformAdapter('SHOPIFY');
// or
const adapter = getPlatformAdapter('WOOCOMMERCE');
```

### Webhook Verification

```typescript
import { getPlatformAdapter } from '@/lib/platforms';

export async function POST(request: Request) {
  const rawBody = await request.text();
  const headers = request.headers;

  // Get the appropriate adapter
  const adapter = getPlatformAdapter('SHOPIFY');

  // Extract webhook headers
  const webhookHeaders = adapter.extractWebhookHeaders(headers);

  // Verify webhook signature
  const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET!;
  const verification = adapter.verifyWebhook(rawBody, webhookHeaders, webhookSecret);

  if (!verification.isValid) {
    return Response.json(
      { error: verification.error },
      { status: 401 }
    );
  }

  // Parse order webhook
  const normalizedOrder = adapter.parseOrderWebhook(rawBody);

  // Process the order...
}
```

### Parsing Order Webhooks

```typescript
import { shopifyAdapter, wooCommerceAdapter } from '@/lib/platforms';

// Parse a Shopify order
const shopifyOrder = shopifyAdapter.parseOrderWebhook(rawShopifyPayload);

// Parse a WooCommerce order
const wooOrder = wooCommerceAdapter.parseOrderWebhook(rawWooPayload);

// Both return NormalizedOrder with the same structure:
console.log(shopifyOrder.externalId);
console.log(shopifyOrder.lineItems);
console.log(shopifyOrder.customer);
```

## Webhook Security

Both platforms use **HMAC-SHA256** signature verification:

### Shopify
- Header: `X-Shopify-Hmac-Sha256`
- Algorithm: HMAC-SHA256, base64-encoded
- Secret: From Shopify App settings

### WooCommerce
- Header: `X-WC-Webhook-Signature`
- Algorithm: HMAC-SHA256, base64-encoded
- Secret: From WooCommerce webhook settings

Both implementations use `crypto.timingSafeEqual()` to prevent timing attacks.

## Platform Differences

### Field Mapping

| Field | Shopify | WooCommerce |
|-------|---------|-------------|
| Variant ID | `variant_id` | `variation_id` |
| Price Format | String ("19.99") | Number (19.99) |
| Guest Customer | `customer: null` | `customer_id: 0` |
| Status | Derived from financial/fulfillment | `status` field |

### Order Status Mapping

**WooCommerce → Financial Status:**
- `completed`, `processing` → `paid`
- `refunded` → `refunded`
- `pending`, `on-hold` → `pending`
- `cancelled`, `failed` → `voided`

**WooCommerce → Fulfillment Status:**
- `completed` → `fulfilled`
- `processing`, `on-hold` → `unfulfilled`
- `cancelled`, `failed`, `refunded` → `cancelled`

## Environment Variables

Required environment variables for webhook verification:

```env
# Shopify
SHOPIFY_WEBHOOK_SECRET=your_shopify_webhook_secret

# WooCommerce
WOOCOMMERCE_WEBHOOK_SECRET=your_woocommerce_webhook_secret

# API Credentials Encryption
ENCRYPTION_KEY=base64_encoded_32_byte_key
```

Generate an encryption key:
```typescript
import { generateEncryptionKey } from '@/lib/encryption';
console.log(generateEncryptionKey());
```

## Adding New Platforms

To add support for a new platform:

1. Create a new directory: `lib/platforms/newplatform/`
2. Implement `webhooks.ts` with verification logic
3. Implement `adapter.ts` implementing `PlatformAdapter` interface
4. Add to registry in `core/registry.ts`
5. Update `PlatformType` in `core/types.ts`

## Type Safety

All adapters are fully typed with TypeScript. The `NormalizedOrder` interface provides a unified structure regardless of the source platform, making it easy to process orders consistently.

```typescript
interface NormalizedOrder {
  externalId: string;
  externalOrderNumber: string;
  platform: 'SHOPIFY' | 'WOOCOMMERCE';
  nativeStatus: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  createdAt: Date;
  customer: NormalizedCustomer | null;
  lineItems: NormalizedLineItem[];
  currency: string;
  total: number;
  rawPayload: unknown; // Original payload for debugging
}
```
