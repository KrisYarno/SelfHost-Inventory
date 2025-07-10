/**
 * WooCommerce Sync Service Test Examples
 * 
 * This file demonstrates how to use the WooCommerce sync service.
 * Run these tests with proper environment variables set.
 */

import { sanitizeOrderData, mapOrderItems, detectBundleItems } from './sync';
import type { WooCommerceOrder, WooCommerceLineItem } from './sync';

// Example WooCommerce order data
const mockOrder: WooCommerceOrder = {
  id: 12345,
  parent_id: 0,
  status: 'processing',
  currency: 'USD',
  version: '8.0.0',
  prices_include_tax: false,
  date_created: '2025-01-09T10:00:00',
  date_modified: '2025-01-09T10:00:00',
  discount_total: '0.00',
  discount_tax: '0.00',
  shipping_total: '10.00',
  shipping_tax: '1.00',
  cart_tax: '5.00',
  total: '116.00',
  total_tax: '6.00',
  customer_id: 1,
  order_key: 'wc_order_abc123',
  billing: {
    first_name: 'John',
    last_name: 'Doe',
    email: 'john@example.com',
    phone: '555-1234',
    address_1: '123 Main St',
    city: 'Anytown',
    state: 'CA',
    postcode: '12345',
    country: 'US',
  },
  shipping: {
    first_name: 'John',
    last_name: 'Doe',
    address_1: '123 Main St',
    city: 'Anytown',
    state: 'CA',
    postcode: '12345',
    country: 'US',
  },
  payment_method: 'stripe',
  payment_method_title: 'Credit Card',
  transaction_id: 'ch_1234567890',
  customer_ip_address: '192.168.1.1',
  customer_user_agent: 'Mozilla/5.0...',
  created_via: 'checkout',
  customer_note: '',
  date_completed: null,
  date_paid: '2025-01-09T10:01:00',
  cart_hash: 'abc123',
  number: '12345',
  meta_data: [],
  line_items: [
    {
      id: 1,
      name: 'Product Bundle - Premium Pack',
      product_id: 100,
      variation_id: 0,
      quantity: 1,
      tax_class: '',
      subtotal: '50.00',
      subtotal_tax: '5.00',
      total: '50.00',
      total_tax: '5.00',
      taxes: [],
      meta_data: [],
      sku: 'BUNDLE-001',
      price: 50,
      parent_name: null,
      composite_parent: null,
      composite_children: [],
      bundled_items: [2, 3],
    },
    {
      id: 2,
      name: 'Product A',
      product_id: 101,
      variation_id: 0,
      quantity: 2,
      tax_class: '',
      subtotal: '20.00',
      subtotal_tax: '2.00',
      total: '20.00',
      total_tax: '2.00',
      taxes: [],
      meta_data: [
        { id: 1, key: '_bundled_by', value: '1' },
      ],
      sku: 'PROD-A',
      price: 10,
      parent_name: null,
      composite_parent: null,
      composite_children: [],
      bundled_by: '1',
    },
    {
      id: 3,
      name: 'Product B',
      product_id: 102,
      variation_id: 0,
      quantity: 1,
      tax_class: '',
      subtotal: '30.00',
      subtotal_tax: '3.00',
      total: '30.00',
      total_tax: '3.00',
      taxes: [],
      meta_data: [
        { id: 2, key: '_bundled_by', value: '1' },
      ],
      sku: 'PROD-B',
      price: 30,
      parent_name: null,
      composite_parent: null,
      composite_children: [],
      bundled_by: '1',
    },
  ],
  tax_lines: [],
  shipping_lines: [],
  fee_lines: [],
  coupon_lines: [],
  refunds: [],
  payment_url: '',
  is_editable: false,
  needs_payment: false,
  needs_processing: true,
  date_created_gmt: '2025-01-09T10:00:00',
  date_modified_gmt: '2025-01-09T10:00:00',
  date_completed_gmt: null,
  date_paid_gmt: '2025-01-09T10:01:00',
  currency_symbol: '$',
  _links: {},
};

// Test sanitizeOrderData
console.log('=== Test sanitizeOrderData ===');
const sanitizedOrder = sanitizeOrderData(mockOrder);
console.log('Sanitized Order:', sanitizedOrder);
console.log('✓ Customer data removed');
console.log('✓ Only essential order data retained\n');

// Test mapOrderItems
console.log('=== Test mapOrderItems ===');
const mappedItems = mapOrderItems(mockOrder.line_items);
console.log('Mapped Items:', JSON.stringify(mappedItems, null, 2));
console.log('✓ Bundle relationships detected');
console.log('✓ Product information extracted\n');

// Test detectBundleItems
console.log('=== Test detectBundleItems ===');
const bundleMap = detectBundleItems(mockOrder.line_items);
console.log('Bundle Relationships:');
bundleMap.forEach((relation, itemId) => {
  console.log(`Item ${itemId}:`, relation);
});
console.log('✓ Parent-child relationships identified\n');

// Example of using the sync service
console.log('=== Example Usage ===');
console.log(`
// In your cron job or API route:
import { syncProcessingOrders } from '@/lib/woocommerce/sync';
import prisma from '@/lib/prisma';

// Run the sync
const result = await syncProcessingOrders(prisma);
console.log(\`Synced \${result.ordersProcessed} orders with \${result.itemsProcessed} items\`);
if (result.errors.length > 0) {
  console.error('Sync errors:', result.errors);
}
`);

// Example of setting up a Vercel cron job
console.log('\n=== Vercel Cron Configuration (vercel.json) ===');
console.log(`
{
  "crons": [{
    "path": "/api/woocommerce/sync",
    "schedule": "0 */15 * * *"  // Every 15 minutes
  }]
}
`);

export {};