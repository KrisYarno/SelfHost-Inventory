import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getSession } from '@/lib/auth';
import prisma from '@/lib/prisma';

// Test endpoint for webhook configuration
// Only accessible by admins
export async function POST(request: NextRequest) {
  try {
    // Check if user is admin
    const session = await getSession();
    if (!session?.user?.isAdmin) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { action } = body;

    switch (action) {
      case 'generate-signature':
        return generateSignature(body);
      case 'list-events':
        return listEvents();
      case 'replay-event':
        return replayEvent(body);
      case 'test-payload':
        return testPayload();
      default:
        return NextResponse.json(
          { error: 'Invalid action' },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('Webhook test error:', error);
    return NextResponse.json(
      { error: 'Test failed', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// Generate a test signature for a payload
async function generateSignature(body: any) {
  const { payload, secret } = body;
  
  if (!payload || !secret) {
    return NextResponse.json(
      { error: 'Payload and secret required' },
      { status: 400 }
    );
  }

  const signature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload), 'utf8')
    .digest('base64');

  return NextResponse.json({
    signature,
    headers: {
      'x-wc-webhook-signature': signature,
      'x-wc-webhook-id': '1',
      'x-wc-webhook-delivery-id': `test-${Date.now()}`,
      'x-wc-webhook-event': 'created',
      'x-wc-webhook-resource': 'order',
      'x-wc-webhook-topic': 'order.created',
    },
  });
}

// List recent webhook events
async function listEvents() {
  const events = await prisma.webhookEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      eventType: true,
      webhookId: true,
      resourceId: true,
      status: true,
      attempts: true,
      error: true,
      createdAt: true,
      processedAt: true,
    },
  });

  return NextResponse.json({ events });
}

// Replay a webhook event
async function replayEvent(body: any) {
  const { eventId } = body;
  
  if (!eventId) {
    return NextResponse.json(
      { error: 'Event ID required' },
      { status: 400 }
    );
  }

  // Reset event to pending
  const event = await prisma.webhookEvent.update({
    where: { id: parseInt(eventId) },
    data: {
      status: 'PENDING',
      attempts: 0,
      error: null,
    },
  });

  return NextResponse.json({
    message: 'Event reset for replay',
    event: {
      id: event.id,
      eventType: event.eventType,
      status: event.status,
    },
  });
}

// Generate a test payload
function testPayload() {
  const testOrder = {
    id: 99999,
    order_key: 'wc_order_test123',
    status: 'processing',
    currency: 'USD',
    total: '100.00',
    date_created: new Date().toISOString(),
    date_modified: new Date().toISOString(),
    line_items: [
      {
        id: 1,
        name: 'Test Product',
        product_id: 123,
        variation_id: 0,
        quantity: 2,
        price: '50.00',
        sku: 'TEST-SKU-001',
        meta_data: [],
      },
    ],
    meta_data: [],
    // Include fields that should be stripped
    billing: {
      first_name: 'Test',
      last_name: 'User',
      email: 'test@example.com',
    },
    customer_id: 1,
    customer_ip_address: '127.0.0.1',
  };

  return NextResponse.json({
    payload: testOrder,
    instructions: [
      '1. Copy the payload above',
      '2. Use the generate-signature action with your webhook secret',
      '3. Send a POST request to /api/woocommerce/webhook with the payload and headers',
      '4. Check the webhook events list to see if it was received',
    ],
  });
}

// GET endpoint to show available test actions
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.user?.isAdmin) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  return NextResponse.json({
    message: 'WooCommerce Webhook Test Endpoint',
    availableActions: [
      {
        action: 'generate-signature',
        description: 'Generate a webhook signature for a payload',
        requiredFields: ['payload', 'secret'],
      },
      {
        action: 'list-events',
        description: 'List recent webhook events',
        requiredFields: [],
      },
      {
        action: 'replay-event',
        description: 'Reset an event for replay',
        requiredFields: ['eventId'],
      },
      {
        action: 'test-payload',
        description: 'Get a test order payload',
        requiredFields: [],
      },
    ],
  });
}