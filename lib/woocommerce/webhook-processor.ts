import prisma from '@/lib/prisma';
import { WebhookEventStatus } from '@prisma/client';

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000; // 5 seconds

interface WebhookPayload {
  id: number;
  order_key?: string;
  status: string;
  currency: string;
  total: string;
  date_created: string;
  date_modified: string;
  line_items?: Array<{
    id: number;
    name: string;
    product_id: number;
    variation_id: number;
    quantity: number;
    price: string;
    sku?: string;
    meta_data?: any[];
  }>;
  meta_data?: any[];
}

export class WebhookProcessor {
  /**
   * Process pending webhook events
   * This should be called from a background job/cron
   */
  static async processPendingEvents(limit: number = 10): Promise<void> {
    // Get pending events, oldest first
    const events = await prisma.webhookEvent.findMany({
      where: {
        status: 'PENDING',
        attempts: { lt: MAX_RETRY_ATTEMPTS },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    // Process events in parallel with controlled concurrency
    const results = await Promise.allSettled(
      events.map(event => this.processEvent(event.id))
    );

    // Log results
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    
    if (events.length > 0) {
      console.log(`Processed ${events.length} webhook events: ${successful} successful, ${failed} failed`);
    }
  }

  /**
   * Process a single webhook event
   */
  static async processEvent(eventId: number): Promise<void> {
    const event = await prisma.webhookEvent.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      throw new Error(`Webhook event ${eventId} not found`);
    }

    // Skip if already processed
    if (event.status === 'COMPLETED' || event.status === 'SKIPPED') {
      return;
    }

    // Update status to processing
    await prisma.webhookEvent.update({
      where: { id: eventId },
      data: {
        status: 'PROCESSING',
        lastAttemptAt: new Date(),
        attempts: { increment: 1 },
      },
    });

    try {
      const payload = event.payload as unknown as WebhookPayload;

      switch (event.eventType) {
        case 'order.created':
          await this.handleOrderCreated(payload);
          break;
        case 'order.updated':
          await this.handleOrderUpdated(payload);
          break;
        case 'order.deleted':
          await this.handleOrderDeleted(payload);
          break;
        default:
          throw new Error(`Unknown event type: ${event.eventType}`);
      }

      // Mark as completed
      await prisma.webhookEvent.update({
        where: { id: eventId },
        data: {
          status: 'COMPLETED',
          processedAt: new Date(),
          error: null,
        },
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Error processing webhook event ${eventId}:`, error);

      // Check if we should retry
      const shouldRetry = event.attempts < MAX_RETRY_ATTEMPTS;
      
      await prisma.webhookEvent.update({
        where: { id: eventId },
        data: {
          status: shouldRetry ? 'PENDING' : 'FAILED',
          error: errorMessage,
        },
      });

      if (!shouldRetry) {
        // TODO: Send alert about failed webhook
        console.error(`Webhook event ${eventId} failed after ${MAX_RETRY_ATTEMPTS} attempts`);
      }

      throw error;
    }
  }

  /**
   * Handle order created event
   */
  private static async handleOrderCreated(payload: WebhookPayload): Promise<void> {
    // Check if order already exists
    const existingOrder = await prisma.externalOrder.findUnique({
      where: { wooOrderId: payload.id },
    });

    if (existingOrder) {
      console.log(`Order ${payload.id} already exists, skipping creation`);
      return;
    }

    // Create the order
    await prisma.$transaction(async (tx) => {
      const order = await tx.externalOrder.create({
        data: {
          wooOrderId: payload.id,
          orderNumber: payload.order_key || `WOO-${payload.id}`,
          status: this.mapOrderStatus(payload.status),
          orderTotal: parseFloat(payload.total),
          currency: payload.currency,
          jsonData: payload as any,
          syncedAt: new Date(),
        },
      });

      // Create order items
      if (payload.line_items && payload.line_items.length > 0) {
        for (const item of payload.line_items) {
          // Find matching product by WooCommerce IDs
          let product = await tx.product.findFirst({
            where: {
              wooProductId: item.product_id,
              wooVariationId: item.variation_id || 0,
            },
          });

          // If not found and has SKU, try finding by SKU
          if (!product && item.sku) {
            product = await tx.product.findUnique({
              where: { wooSku: item.sku },
            });
          }

          // Check if this is a bundle product by examining meta_data
          const isBundleParent = item.meta_data?.some((meta: any) => 
            meta.key === '_woosb_ids' || meta.key === '_bundle_data'
          );

          await tx.externalOrderItem.create({
            data: {
              orderId: order.id,
              productId: product?.id || null,
              wooProductId: item.product_id,
              wooVariationId: item.variation_id || 0,
              productName: item.name,
              quantity: item.quantity,
              price: parseFloat(item.price),
              metaData: item.meta_data || undefined,
            },
          });

          // Log warning if product not found
          if (!product) {
            console.warn(`Product not found for WooCommerce item: ${item.name} (ID: ${item.product_id}, SKU: ${item.sku})`);
          }
        }
      }
    });

    console.log(`Created order ${payload.id} with ${payload.line_items?.length || 0} items`);
  }

  /**
   * Handle order updated event
   */
  private static async handleOrderUpdated(payload: WebhookPayload): Promise<void> {
    const existingOrder = await prisma.externalOrder.findUnique({
      where: { wooOrderId: payload.id },
      include: { orderItems: true },
    });

    if (!existingOrder) {
      // Order doesn't exist, create it
      console.log(`Order ${payload.id} not found, creating it`);
      await this.handleOrderCreated(payload);
      return;
    }

    // Update the order
    await prisma.$transaction(async (tx) => {
      await tx.externalOrder.update({
        where: { id: existingOrder.id },
        data: {
          status: this.mapOrderStatus(payload.status),
          orderTotal: parseFloat(payload.total),
          currency: payload.currency,
          jsonData: payload as any,
          syncedAt: new Date(),
        },
      });

      // Delete existing items and recreate
      // This ensures we capture any changes to line items
      await tx.externalOrderItem.deleteMany({
        where: { orderId: existingOrder.id },
      });

      if (payload.line_items && payload.line_items.length > 0) {
        for (const item of payload.line_items) {
          // Find matching product by WooCommerce IDs
          let product = await tx.product.findFirst({
            where: {
              wooProductId: item.product_id,
              wooVariationId: item.variation_id || 0,
            },
          });

          // If not found and has SKU, try finding by SKU
          if (!product && item.sku) {
            product = await tx.product.findUnique({
              where: { wooSku: item.sku },
            });
          }

          await tx.externalOrderItem.create({
            data: {
              orderId: existingOrder.id,
              productId: product?.id || null,
              wooProductId: item.product_id,
              wooVariationId: item.variation_id || 0,
              productName: item.name,
              quantity: item.quantity,
              price: parseFloat(item.price),
              metaData: item.meta_data || undefined,
            },
          });

          // Log warning if product not found
          if (!product) {
            console.warn(`Product not found for WooCommerce item: ${item.name} (ID: ${item.product_id}, SKU: ${item.sku})`);
          }
        }
      }
    });

    console.log(`Updated order ${payload.id}`);
  }

  /**
   * Handle order deleted event
   */
  private static async handleOrderDeleted(payload: WebhookPayload): Promise<void> {
    const existingOrder = await prisma.externalOrder.findUnique({
      where: { wooOrderId: payload.id },
    });

    if (!existingOrder) {
      console.log(`Order ${payload.id} not found, nothing to delete`);
      return;
    }

    // Check if order has been packed
    if (existingOrder.packedAt) {
      console.log(`Order ${payload.id} has been packed, marking as cancelled instead of deleting`);
      await prisma.externalOrder.update({
        where: { id: existingOrder.id },
        data: {
          status: 'cancelled',
          syncedAt: new Date(),
        },
      });
    } else {
      // Delete the order and its items (cascade will handle items)
      await prisma.externalOrder.delete({
        where: { id: existingOrder.id },
      });
      console.log(`Deleted order ${payload.id}`);
    }
  }

  /**
   * Map WooCommerce order status to our internal status
   */
  private static mapOrderStatus(wooStatus: string): string {
    const statusMap: Record<string, string> = {
      'pending': 'processing',
      'processing': 'processing',
      'on-hold': 'processing',
      'completed': 'packed',
      'cancelled': 'cancelled',
      'refunded': 'cancelled',
      'failed': 'cancelled',
      'checkout-draft': 'processing',
    };

    return statusMap[wooStatus] || 'processing';
  }

  /**
   * Retry failed events
   * This can be called periodically to retry events that failed
   */
  static async retryFailedEvents(olderThanMinutes: number = 30): Promise<void> {
    const cutoffTime = new Date(Date.now() - olderThanMinutes * 60 * 1000);

    const failedEvents = await prisma.webhookEvent.updateMany({
      where: {
        status: 'FAILED',
        attempts: { lt: MAX_RETRY_ATTEMPTS },
        lastAttemptAt: { lt: cutoffTime },
      },
      data: {
        status: 'PENDING',
      },
    });

    if (failedEvents.count > 0) {
      console.log(`Reset ${failedEvents.count} failed webhook events for retry`);
    }
  }

  /**
   * Clean up old processed events
   * This can be called periodically to clean up the webhook_events table
   */
  static async cleanupOldEvents(daysToKeep: number = 30): Promise<void> {
    const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);

    const deleted = await prisma.webhookEvent.deleteMany({
      where: {
        status: { in: ['COMPLETED', 'SKIPPED'] },
        processedAt: { lt: cutoffDate },
      },
    });

    if (deleted.count > 0) {
      console.log(`Deleted ${deleted.count} old webhook events`);
    }
  }
}