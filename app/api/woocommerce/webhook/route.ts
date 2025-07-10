import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import prisma from '@/lib/prisma';
import { ipRateLimiter } from '@/lib/rate-limit/rate-limiter';
import { z } from 'zod';

// Rate limiter for webhook endpoint - stricter limits
const rateLimiter = ipRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute per IP
  message: 'Too many webhook requests',
});

// Webhook payload schema
const webhookPayloadSchema = z.object({
  id: z.number(),
  order_key: z.string().optional(),
  status: z.string(),
  currency: z.string(),
  total: z.string(),
  date_created: z.string(),
  date_modified: z.string(),
  line_items: z.array(z.any()).optional(),
  meta_data: z.array(z.any()).optional(),
});

// Verify webhook signature
function verifyWebhookSignature(
  body: string,
  signature: string,
  secret: string
): boolean {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('base64');
  
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// Sanitize order data to remove personal information
function sanitizeOrderData(order: any) {
  // Create a copy to avoid mutating the original
  const sanitized = JSON.parse(JSON.stringify(order));
  
  // Remove personal customer data
  delete sanitized.billing;
  delete sanitized.shipping;
  delete sanitized.customer_id;
  delete sanitized.customer_ip_address;
  delete sanitized.customer_user_agent;
  delete sanitized.customer_note;
  
  // Remove payment details
  delete sanitized.payment_method;
  delete sanitized.payment_method_title;
  delete sanitized.transaction_id;
  
  // Keep only essential order data
  return {
    id: sanitized.id,
    order_key: sanitized.order_key,
    status: sanitized.status,
    currency: sanitized.currency,
    total: sanitized.total,
    date_created: sanitized.date_created,
    date_modified: sanitized.date_modified,
    line_items: sanitized.line_items?.map((item: any) => ({
      id: item.id,
      name: item.name,
      product_id: item.product_id,
      variation_id: item.variation_id,
      quantity: item.quantity,
      price: item.price,
      sku: item.sku,
      meta_data: item.meta_data,
    })),
    meta_data: sanitized.meta_data,
  };
}

export async function POST(request: NextRequest) {
  try {
    // Apply rate limiting
    const rateLimitResponse = await rateLimiter.limit(request);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    // Get webhook secret from environment
    const webhookSecret = process.env.WOOCOMMERCE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('WOOCOMMERCE_WEBHOOK_SECRET not configured');
      return NextResponse.json(
        { error: 'Webhook secret not configured' },
        { status: 500 }
      );
    }

    // Get the raw body for signature verification
    const rawBody = await request.text();
    
    // Get signature from headers
    const signature = request.headers.get('x-wc-webhook-signature');
    if (!signature) {
      console.error('Missing webhook signature');
      return NextResponse.json(
        { error: 'Missing webhook signature' },
        { status: 401 }
      );
    }

    // Verify signature
    if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
      console.error('Invalid webhook signature');
      return NextResponse.json(
        { error: 'Invalid webhook signature' },
        { status: 401 }
      );
    }

    // Parse the body
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch (error) {
      console.error('Invalid JSON in webhook body');
      return NextResponse.json(
        { error: 'Invalid JSON payload' },
        { status: 400 }
      );
    }

    // Get webhook metadata from headers
    const webhookId = request.headers.get('x-wc-webhook-id');
    const webhookDeliveryId = request.headers.get('x-wc-webhook-delivery-id');
    const webhookEvent = request.headers.get('x-wc-webhook-event');
    const webhookResource = request.headers.get('x-wc-webhook-resource');
    const webhookTopic = request.headers.get('x-wc-webhook-topic');

    // Validate webhook topic
    const supportedTopics = ['order.created', 'order.updated', 'order.deleted'];
    if (!webhookTopic || !supportedTopics.includes(webhookTopic)) {
      console.log(`Unsupported webhook topic: ${webhookTopic}`);
      return NextResponse.json({ message: 'Topic not supported' }, { status: 200 });
    }

    // Check for idempotency using delivery ID
    if (webhookDeliveryId) {
      const existingEvent = await prisma.webhookEvent.findUnique({
        where: { webhookId: webhookDeliveryId },
      });

      if (existingEvent) {
        console.log(`Webhook already processed: ${webhookDeliveryId}`);
        return NextResponse.json({ message: 'Already processed' }, { status: 200 });
      }
    }

    // Validate payload structure
    let validatedOrder;
    try {
      validatedOrder = webhookPayloadSchema.parse(body);
    } catch (error) {
      console.error('Invalid webhook payload structure:', error);
      return NextResponse.json(
        { error: 'Invalid payload structure' },
        { status: 400 }
      );
    }

    // Sanitize the order data
    const sanitizedPayload = sanitizeOrderData(body);

    // Queue the webhook event for processing
    await prisma.webhookEvent.create({
      data: {
        eventType: webhookTopic,
        webhookId: webhookDeliveryId || `${webhookId}-${Date.now()}`,
        resourceId: validatedOrder.id,
        payload: sanitizedPayload,
        status: 'PENDING',
      },
    });

    console.log(`Webhook queued: ${webhookTopic} for order ${validatedOrder.id}`);

    // Return success immediately
    return NextResponse.json({ message: 'Webhook received' }, { status: 200 });

  } catch (error) {
    // Log error but return success to avoid webhook retries
    console.error('Webhook processing error:', error);
    
    // Still return 200 to prevent WooCommerce from retrying
    return NextResponse.json(
      { message: 'Webhook acknowledged' },
      { status: 200 }
    );
  }
}

// Health check endpoint
export async function GET(request: NextRequest) {
  return NextResponse.json({
    status: 'healthy',
    endpoint: 'woocommerce-webhook',
    timestamp: new Date().toISOString(),
  });
}