import { PrismaClient } from '@prisma/client';

// WooCommerce Order Types
export interface WooCommerceLineItem {
  id: number;
  name: string;
  product_id: number;
  variation_id: number;
  quantity: number;
  tax_class: string;
  subtotal: string;
  subtotal_tax: string;
  total: string;
  total_tax: string;
  taxes: any[];
  meta_data: Array<{
    id: number;
    key: string;
    value: any;
    display_key?: string;
    display_value?: string;
  }>;
  sku: string;
  price: number;
  parent_name?: string | null;
  composite_parent?: string | null;
  composite_children?: string[];
  bundled_by?: string;
  bundled_item_id?: number;
  bundled_items?: number[];
}

export interface WooCommerceOrder {
  id: number;
  parent_id: number;
  status: string;
  currency: string;
  version: string;
  prices_include_tax: boolean;
  date_created: string;
  date_modified: string;
  discount_total: string;
  discount_tax: string;
  shipping_total: string;
  shipping_tax: string;
  cart_tax: string;
  total: string;
  total_tax: string;
  customer_id: number;
  order_key: string;
  billing: any;
  shipping: any;
  payment_method: string;
  payment_method_title: string;
  transaction_id: string;
  customer_ip_address: string;
  customer_user_agent: string;
  created_via: string;
  customer_note: string;
  date_completed: string | null;
  date_paid: string | null;
  cart_hash: string;
  number: string;
  meta_data: any[];
  line_items: WooCommerceLineItem[];
  tax_lines: any[];
  shipping_lines: any[];
  fee_lines: any[];
  coupon_lines: any[];
  refunds: any[];
  payment_url: string;
  is_editable: boolean;
  needs_payment: boolean;
  needs_processing: boolean;
  date_created_gmt: string;
  date_modified_gmt: string;
  date_completed_gmt: string | null;
  date_paid_gmt: string | null;
  currency_symbol: string;
  _links: any;
}

// Sanitized types for our database
export interface SanitizedOrder {
  orderNumber: string;
  total: number;
  currency: string;
  status: string;
  dateCreated: Date;
  dateModified: Date;
}

export interface SanitizedOrderItem {
  productId: number;
  variationId: number;
  name: string;
  sku: string;
  quantity: number;
  price: number;
  bundleParentId?: number;
  isBundleParent: boolean;
  bundleChildren?: number[];
}

// Environment variables validation
function getWooCommerceConfig() {
  const url = process.env.WOOCOMMERCE_URL;
  const consumerKey = process.env.WOOCOMMERCE_CONSUMER_KEY;
  const consumerSecret = process.env.WOOCOMMERCE_CONSUMER_SECRET;

  if (!url || !consumerKey || !consumerSecret) {
    throw new Error('Missing WooCommerce configuration. Please set WOOCOMMERCE_URL, WOOCOMMERCE_CONSUMER_KEY, and WOOCOMMERCE_CONSUMER_SECRET environment variables.');
  }

  return { url, consumerKey, consumerSecret };
}

// Retry logic wrapper
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delay: number = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      console.error(`Attempt ${i + 1} failed:`, error);
      
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
      }
    }
  }

  throw lastError;
}

// Fetch orders from WooCommerce API
async function fetchProcessingOrders(page: number = 1, perPage: number = 100): Promise<WooCommerceOrder[]> {
  const { url, consumerKey, consumerSecret } = getWooCommerceConfig();
  
  const apiUrl = new URL(`${url}/wp-json/wc/v3/orders`);
  apiUrl.searchParams.append('status', 'processing');
  apiUrl.searchParams.append('page', page.toString());
  apiUrl.searchParams.append('per_page', perPage.toString());
  apiUrl.searchParams.append('consumer_key', consumerKey);
  apiUrl.searchParams.append('consumer_secret', consumerSecret);

  const response = await fetch(apiUrl.toString(), {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`WooCommerce API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

// Remove personal customer data from order
export function sanitizeOrderData(order: WooCommerceOrder): SanitizedOrder {
  return {
    orderNumber: order.number,
    total: parseFloat(order.total),
    currency: order.currency,
    status: order.status,
    dateCreated: new Date(order.date_created),
    dateModified: new Date(order.date_modified),
  };
}

// Extract product information from line items
export function mapOrderItems(lineItems: WooCommerceLineItem[]): SanitizedOrderItem[] {
  return lineItems.map(item => {
    const bundleInfo = detectBundleItem(item, lineItems);
    
    return {
      productId: item.product_id,
      variationId: item.variation_id,
      name: item.name,
      sku: item.sku,
      quantity: item.quantity,
      price: item.price,
      bundleParentId: bundleInfo.parentId,
      isBundleParent: bundleInfo.isParent,
      bundleChildren: bundleInfo.childIds,
    };
  });
}

// Detect bundle parent/child relationships
export function detectBundleItems(lineItems: WooCommerceLineItem[]): Map<number, { isParent: boolean; parentId?: number; childIds?: number[] }> {
  const bundleRelationships = new Map<number, { isParent: boolean; parentId?: number; childIds?: number[] }>();

  lineItems.forEach(item => {
    // Check if item is bundled by another item
    if (item.bundled_by) {
      const parentId = parseInt(item.bundled_by);
      bundleRelationships.set(item.id, { isParent: false, parentId });
      
      // Update parent's children list
      const parentRelation = bundleRelationships.get(parentId) || { isParent: true, childIds: [] };
      parentRelation.isParent = true;
      parentRelation.childIds = [...(parentRelation.childIds || []), item.id];
      bundleRelationships.set(parentId, parentRelation);
    }
    
    // Check if item has bundled items
    if (item.bundled_items && item.bundled_items.length > 0) {
      const relation = bundleRelationships.get(item.id) || { isParent: true, childIds: [] };
      relation.isParent = true;
      relation.childIds = [...(relation.childIds || []), ...item.bundled_items];
      bundleRelationships.set(item.id, relation);
    }

    // Check meta_data for bundle information
    item.meta_data?.forEach(meta => {
      if (meta.key === '_bundled_by' && meta.value) {
        const parentId = parseInt(meta.value);
        bundleRelationships.set(item.id, { isParent: false, parentId });
      }
    });
  });

  return bundleRelationships;
}

// Helper function for single item bundle detection
function detectBundleItem(item: WooCommerceLineItem, allItems: WooCommerceLineItem[]): { isParent: boolean; parentId?: number; childIds?: number[] } {
  const bundleMap = detectBundleItems(allItems);
  return bundleMap.get(item.id) || { isParent: false };
}

// Main sync function
export async function syncProcessingOrders(prisma: PrismaClient): Promise<{ ordersProcessed: number; itemsProcessed: number; errors: string[] }> {
  const errors: string[] = [];
  let ordersProcessed = 0;
  let itemsProcessed = 0;
  let page = 1;
  let hasMore = true;

  // Get last sync time
  const lastSync = await prisma.syncLog.findFirst({
    where: { syncType: 'woocommerce_orders' },
    orderBy: { syncedAt: 'desc' },
  });

  const syncStartTime = new Date();

  try {
    while (hasMore) {
      try {
        const orders = await withRetry(() => fetchProcessingOrders(page));
        
        if (orders.length === 0) {
          hasMore = false;
          break;
        }

        for (const order of orders) {
          try {
            // Skip if order hasn't been modified since last sync
            if (lastSync && new Date(order.date_modified) <= lastSync.syncedAt) {
              continue;
            }

            const sanitizedOrder = sanitizeOrderData(order);
            const sanitizedItems = mapOrderItems(order.line_items);

            // Upsert order
            await prisma.order.upsert({
              where: { orderNumber: sanitizedOrder.orderNumber },
              update: {
                total: sanitizedOrder.total,
                currency: sanitizedOrder.currency,
                status: sanitizedOrder.status,
                dateModified: sanitizedOrder.dateModified,
              },
              create: {
                orderNumber: sanitizedOrder.orderNumber,
                total: sanitizedOrder.total,
                currency: sanitizedOrder.currency,
                status: sanitizedOrder.status,
                dateCreated: sanitizedOrder.dateCreated,
                dateModified: sanitizedOrder.dateModified,
              },
            });

            // Delete existing order items for this order
            await prisma.orderItem.deleteMany({
              where: { order: { orderNumber: sanitizedOrder.orderNumber } },
            });

            // Insert new order items
            for (const item of sanitizedItems) {
              await prisma.orderItem.create({
                data: {
                  order: { connect: { orderNumber: sanitizedOrder.orderNumber } },
                  productId: item.productId,
                  variationId: item.variationId,
                  name: item.name,
                  sku: item.sku,
                  quantity: item.quantity,
                  price: item.price,
                  bundleParentId: item.bundleParentId,
                  isBundleParent: item.isBundleParent,
                  bundleChildren: item.bundleChildren,
                },
              });
              itemsProcessed++;
            }

            ordersProcessed++;
          } catch (error) {
            const errorMessage = `Failed to process order ${order.number}: ${error instanceof Error ? error.message : 'Unknown error'}`;
            errors.push(errorMessage);
            console.error(errorMessage);
          }
        }

        page++;
        
        // If we got less than the requested amount, we've reached the end
        if (orders.length < 100) {
          hasMore = false;
        }
      } catch (error) {
        const errorMessage = `Failed to fetch page ${page}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        errors.push(errorMessage);
        console.error(errorMessage);
        hasMore = false; // Stop pagination on error
      }
    }

    // Record sync log
    await prisma.syncLog.create({
      data: {
        syncType: 'woocommerce_orders',
        syncedAt: syncStartTime,
        recordsProcessed: ordersProcessed,
        errors: errors.length > 0 ? errors : undefined,
        success: errors.length === 0,
      },
    });

    return { ordersProcessed, itemsProcessed, errors };
  } catch (error) {
    const errorMessage = `Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    errors.push(errorMessage);
    
    // Record failed sync
    await prisma.syncLog.create({
      data: {
        syncType: 'woocommerce_orders',
        syncedAt: syncStartTime,
        recordsProcessed: ordersProcessed,
        errors: errors,
        success: false,
      },
    });

    throw new Error(errorMessage);
  }
}

// Utility function to manually trigger sync
export async function triggerOrderSync(): Promise<{ ordersProcessed: number; itemsProcessed: number; errors: string[] }> {
  const prisma = new PrismaClient();
  
  try {
    return await syncProcessingOrders(prisma);
  } finally {
    await prisma.$disconnect();
  }
}