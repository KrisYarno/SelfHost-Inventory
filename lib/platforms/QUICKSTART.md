# Platform Adapters Quick Start Guide

Get up and running with Shopify and WooCommerce webhooks in 5 minutes.

## Step 1: Set Up Environment Variables

```bash
# Generate an encryption key
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Add to your .env file
ENCRYPTION_KEY=<generated_key>
SHOPIFY_WEBHOOK_SECRET=<your_shopify_secret>
WOOCOMMERCE_WEBHOOK_SECRET=<your_woocommerce_secret>
```

## Step 2: Create Webhook Endpoint

Create `/app/api/webhooks/shopify/orders/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { getPlatformAdapter } from '@/lib/platforms';
import prisma from '@/lib/prisma';

export async function POST(request: NextRequest) {
  try {
    // Get raw body (IMPORTANT: Don't use request.json()!)
    const rawBody = await request.text();

    // Get Shopify adapter
    const adapter = getPlatformAdapter('SHOPIFY');

    // Extract and verify webhook
    const headers = adapter.extractWebhookHeaders(request.headers);
    const verification = adapter.verifyWebhook(
      rawBody,
      headers,
      process.env.SHOPIFY_WEBHOOK_SECRET!
    );

    if (!verification.isValid) {
      console.error('Webhook verification failed:', verification.error);
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse order
    const order = adapter.parseOrderWebhook(rawBody);

    // Save to database
    await prisma.order.create({
      data: {
        externalId: order.externalId,
        externalOrderNumber: order.externalOrderNumber,
        platform: order.platform,
        status: order.nativeStatus,
        financialStatus: order.financialStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        total: order.total,
        currency: order.currency,
        customerEmail: order.customer?.email,
        customerName: order.customer?.name,
      },
    });

    // Process line items
    for (const item of order.lineItems) {
      // Update inventory, create order items, etc.
      console.log(`Processing: ${item.quantity}x ${item.name}`);
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    return Response.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
```

## Step 3: Create WooCommerce Endpoint

Create `/app/api/webhooks/woocommerce/orders/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { getPlatformAdapter } from '@/lib/platforms';

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const adapter = getPlatformAdapter('WOOCOMMERCE');

  const headers = adapter.extractWebhookHeaders(request.headers);
  const verification = adapter.verifyWebhook(
    rawBody,
    headers,
    process.env.WOOCOMMERCE_WEBHOOK_SECRET!
  );

  if (!verification.isValid) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const order = adapter.parseOrderWebhook(rawBody);
  // Process order (same code as Shopify!)...

  return Response.json({ success: true });
}
```

## Step 4: Configure Platform Webhooks

### Shopify
1. Go to: Settings → Notifications → Webhooks
2. Create webhook:
   - Event: `Order creation`
   - Format: `JSON`
   - URL: `https://yourdomain.com/api/webhooks/shopify/orders`
   - Webhook API version: `2025-10` (or later)

### WooCommerce
1. Go to: WooCommerce → Settings → Advanced → Webhooks
2. Add webhook:
   - Topic: `Order created`
   - Delivery URL: `https://yourdomain.com/api/webhooks/woocommerce/orders`
   - Secret: (copy to your `.env`)
   - API Version: Latest

## Step 5: Test Your Webhooks

### Local Testing (with ngrok)

```bash
# Install ngrok
npm install -g ngrok

# Start your Next.js app
npm run dev

# In another terminal, create tunnel
ngrok http 3000

# Use the ngrok URL in your webhook configuration
# Example: https://abc123.ngrok.io/api/webhooks/shopify/orders
```

### Test with Sample Data

```typescript
// Create test file: /scripts/test-webhook.ts
import { generateTestWebhookExample } from '@/lib/platforms/examples';

const testData = generateTestWebhookExample();

fetch('http://localhost:3000/api/webhooks/shopify/orders', {
  method: 'POST',
  headers: testData.headers,
  body: testData.body,
});
```

## Step 6: Store Platform Credentials (Optional)

```typescript
import { encryptValue } from '@/lib/encryption';
import prisma from '@/lib/prisma';

// Store Shopify credentials
await prisma.platformConfig.create({
  data: {
    platform: 'SHOPIFY',
    shopDomain: 'mystore.myshopify.com',
    apiKeyEncrypted: encryptValue('shpat_abc123...'),
    apiSecretEncrypted: encryptValue('shpss_xyz789...'),
    webhookSecretEncrypted: encryptValue('your-webhook-secret'),
    isActive: true,
  },
});
```

## Common Issues

### Issue: "Missing X-Shopify-Hmac-Sha256 header"
**Solution:** Ensure you're hitting the correct endpoint and Shopify has the right URL configured.

### Issue: "HMAC signature mismatch"
**Solutions:**
- Verify `SHOPIFY_WEBHOOK_SECRET` matches Shopify's webhook configuration
- Ensure you're reading raw body (`await request.text()`), not parsing JSON first
- Check for middleware that might modify the request body

### Issue: "Invalid JSON in webhook payload"
**Solution:** Log the raw body to ensure it's valid JSON. Platform may be sending malformed data.

### Issue: "ENCRYPTION_KEY environment variable is not set"
**Solution:** Generate key and add to `.env` (see Step 1)

## Monitoring and Debugging

### Add Logging

```typescript
console.log('Webhook received:', {
  platform: 'SHOPIFY',
  topic: headers.topic,
  eventId: headers.eventId,
  orderId: order.externalId,
});
```

### Add Error Tracking

```typescript
try {
  // Process webhook
} catch (error) {
  // Send to error tracking service (Sentry, etc.)
  console.error('Webhook error:', error);

  // Save failed webhook for retry
  await prisma.failedWebhook.create({
    data: {
      platform: 'SHOPIFY',
      rawBody,
      error: error.message,
    },
  });
}
```

## Next Steps

- [ ] Set up webhook deduplication (use `eventId`)
- [ ] Add retry mechanism for failed webhooks
- [ ] Implement rate limiting
- [ ] Add webhook signature verification tests
- [ ] Set up monitoring and alerts
- [ ] Create admin UI for webhook logs

## Need Help?

- See `/lib/platforms/README.md` for detailed documentation
- Check `/lib/platforms/examples.ts` for more code examples
- Review `/lib/platforms/IMPLEMENTATION_SUMMARY.md` for technical details
