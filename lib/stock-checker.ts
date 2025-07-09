import prisma from '@/lib/prisma';
import { emailService, LowStockItem } from '@/lib/email';

export interface LowStockProduct {
  id: number;
  name: string;
  currentStock: number;
  threshold: number;
  daysUntilEmpty: number | null;
}

export class StockChecker {
  /**
   * Check all products for low stock and return those below threshold
   */
  async checkLowStock(): Promise<LowStockProduct[]> {
    // Get all products with their thresholds and current quantities
    const products = await prisma.product.findMany({
      where: {
        lowStockThreshold: {
          gt: 0, // Only check products with a threshold set
        },
      },
      include: {
        product_locations: true,
      },
    });

    const lowStockProducts: LowStockProduct[] = [];

    for (const product of products) {
      // Calculate total quantity across all locations
      const totalQuantity = product.product_locations.reduce(
        (sum, location) => sum + location.quantity,
        0
      );

      // Check if below threshold
      const threshold = product.lowStockThreshold || 10; // Default to 10 if null
      if (totalQuantity <= threshold) {
        // Calculate days until empty based on recent usage
        const daysUntilEmpty = await this.calculateDaysUntilEmpty(product.id, totalQuantity);
        
        lowStockProducts.push({
          id: product.id,
          name: product.name,
          currentStock: totalQuantity,
          threshold: threshold,
          daysUntilEmpty,
        });
      }
    }

    // Sort by criticality (days until empty, then by stock level)
    lowStockProducts.sort((a, b) => {
      if (a.daysUntilEmpty === null && b.daysUntilEmpty === null) {
        return a.currentStock - b.currentStock;
      }
      if (a.daysUntilEmpty === null) return 1;
      if (b.daysUntilEmpty === null) return -1;
      return a.daysUntilEmpty - b.daysUntilEmpty;
    });

    return lowStockProducts;
  }

  /**
   * Calculate days until a product runs out based on recent usage
   */
  private async calculateDaysUntilEmpty(
    productId: number,
    currentQuantity: number
  ): Promise<number | null> {
    if (currentQuantity === 0) return 0;

    // Get inventory logs from the last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const logs = await prisma.inventory_logs.findMany({
      where: {
        productId,
        changeTime: {
          gte: thirtyDaysAgo,
        },
        delta: {
          lt: 0, // Only negative changes (usage)
        },
      },
    });

    if (logs.length === 0) return null;

    // Calculate average daily usage
    const totalUsage = logs.reduce((sum, log) => sum + Math.abs(log.delta), 0);
    const daysCovered = 30;
    const avgDailyUsage = totalUsage / daysCovered;

    if (avgDailyUsage === 0) return null;

    // Calculate days until empty
    return Math.floor(currentQuantity / avgDailyUsage);
  }

  /**
   * Send low stock notifications to users who have opted in
   */
  async sendLowStockNotifications(lowStockProducts: LowStockProduct[]): Promise<void> {
    if (lowStockProducts.length === 0) return;

    // Get users who have opted in for email alerts
    const users = await prisma.user.findMany({
      where: {
        emailAlerts: true,
        isApproved: true,
      },
    });

    if (users.length === 0) return;

    // Check notification history to avoid spam
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    for (const user of users) {
      // Get products that haven't been notified about in the last 24 hours
      const recentNotifications = await prisma.notificationHistory.findMany({
        where: {
          userId: user.id,
          productId: {
            in: lowStockProducts.map(p => p.id),
          },
          notificationType: 'low_stock',
          sentAt: {
            gte: yesterday,
          },
        },
      });

      const notifiedProductIds = new Set(recentNotifications.map(n => n.productId));
      const productsToNotify = lowStockProducts.filter(
        p => !notifiedProductIds.has(p.id)
      );

      if (productsToNotify.length === 0) continue;

      try {
        // Send email
        const emailItems: LowStockItem[] = productsToNotify.map(p => ({
          productName: p.name,
          currentStock: p.currentStock,
          threshold: p.threshold,
          daysUntilEmpty: p.daysUntilEmpty,
        }));

        await emailService.sendLowStockDigest(
          user.email,
          {
            recipientName: user.username,
            items: emailItems,
          }
        );

        // Record notification history
        await prisma.notificationHistory.createMany({
          data: productsToNotify.map(p => ({
            userId: user.id,
            productId: p.id,
            notificationType: 'low_stock',
          })),
        });

        console.log(`Sent low stock notification to ${user.email} for ${productsToNotify.length} products`);
      } catch (error) {
        console.error(`Failed to send notification to ${user.email}:`, error);
      }
    }
  }

  /**
   * Run the complete stock check and notification process
   */
  async runDailyCheck(): Promise<{
    lowStockCount: number;
    notificationsSent: number;
  }> {
    console.log('Starting daily stock check...');
    
    const lowStockProducts = await this.checkLowStock();
    console.log(`Found ${lowStockProducts.length} products below threshold`);

    if (lowStockProducts.length > 0) {
      await this.sendLowStockNotifications(lowStockProducts);
    }

    return {
      lowStockCount: lowStockProducts.length,
      notificationsSent: lowStockProducts.length, // This could be more accurate
    };
  }
}

// Export singleton instance
export const stockChecker = new StockChecker();