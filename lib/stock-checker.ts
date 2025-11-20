import prisma from '@/lib/prisma';
import { emailService, LowStockItem } from '@/lib/email';
import { smsService } from '@/lib/sms';
import type { CombinedMinBreach, LocationMinBreach } from '@/types/inventory';

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
   * Compute per-location and combined minimum breaches
   */
  async checkMinimums(): Promise<{
    locationBreaches: LocationMinBreach[];
    combinedBreaches: CombinedMinBreach[];
  }> {
    const products = await prisma.product.findMany({
      where: { deletedAt: null },
      include: {
        product_locations: {
          include: { locations: true },
        },
      },
    });

    const locationBreaches: LocationMinBreach[] = [];
    const combinedBreaches: CombinedMinBreach[] = [];

    for (const product of products) {
      let totalQuantity = 0;

      for (const locationRow of product.product_locations) {
        totalQuantity += locationRow.quantity;
        const min = locationRow.minQuantity ?? 0;
        if (min > 0 && locationRow.quantity < min) {
          locationBreaches.push({
            productId: product.id,
            productName: product.name,
            locationId: locationRow.locationId,
            locationName: locationRow.locations.name,
            currentQuantity: locationRow.quantity,
            minQuantity: min,
          });
        }
      }

      const combinedMin = product.lowStockThreshold ?? 0;
      if (combinedMin > 0 && totalQuantity < combinedMin) {
        const daysUntilEmpty = await this.calculateDaysUntilEmpty(
          product.id,
          totalQuantity
        );
        combinedBreaches.push({
          productId: product.id,
          productName: product.name,
          totalQuantity,
          combinedMinimum: combinedMin,
          daysUntilEmpty,
        });
      }
    }

    return { locationBreaches, combinedBreaches };
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
   * Send notifications for minimum breaches via email/SMS
   */
  async sendMinimumNotifications(
    locationBreaches: LocationMinBreach[],
    combinedBreaches: CombinedMinBreach[]
  ): Promise<void> {
    if (!locationBreaches.length && !combinedBreaches.length) {
      return;
    }

    const users = await prisma.user.findMany({
      where: {
        isApproved: true,
        OR: [
          { minLocationEmailAlerts: true },
          { minLocationSmsAlerts: true },
          { minCombinedEmailAlerts: true },
          { minCombinedSmsAlerts: true },
          { emailAlerts: true },
        ],
      },
    });

    if (!users.length) return;

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    for (const user of users) {
      const locationItems = locationBreaches.filter(
        (breach) =>
          user.defaultLocationId &&
          breach.locationId === user.defaultLocationId
      );
      const combinedItems = combinedBreaches;

      const recent = await prisma.notificationHistory.findMany({
        where: {
          userId: user.id,
          sentAt: { gte: yesterday },
          notificationType: {
            in: ["LOW_STOCK_LOCATION", "LOW_STOCK_COMBINED"],
          },
        },
      });

      const seenLoc = new Set(
        recent
          .filter((n) => n.notificationType === "LOW_STOCK_LOCATION")
          .map((n) => `${n.productId}:${n.locationId ?? "none"}`)
      );
      const seenCombined = new Set(
        recent
          .filter((n) => n.notificationType === "LOW_STOCK_COMBINED")
          .map((n) => `${n.productId}`)
      );

      const locToNotify = locationItems.filter(
        (item) =>
          !seenLoc.has(`${item.productId}:${item.locationId}`)
      );
      const combinedToNotify = combinedItems.filter(
        (item) => !seenCombined.has(`${item.productId}`)
      );

      if (!locToNotify.length && !combinedToNotify.length) {
        continue;
      }

      // Email notifications
      if (
        (user.minLocationEmailAlerts && locToNotify.length > 0) ||
        (user.minCombinedEmailAlerts && combinedToNotify.length > 0) ||
        (user.emailAlerts && combinedToNotify.length > 0)
      ) {
        await emailService.sendMinimumsDigest(user.email, {
          recipientName: user.username,
          locationItems: user.minLocationEmailAlerts
            ? locToNotify
            : [],
          combinedItems:
            user.minCombinedEmailAlerts || user.emailAlerts
              ? combinedToNotify
              : [],
        });
      }

      // SMS notifications
      if (
        user.phoneNumber &&
        user.smsVerified &&
        ((user.minLocationSmsAlerts && locToNotify.length > 0) ||
          (user.minCombinedSmsAlerts && combinedToNotify.length > 0))
      ) {
        await smsService.sendMinimumsSummary(user.phoneNumber, {
          locationItems: user.minLocationSmsAlerts
            ? locToNotify
            : [],
          combinedItems: user.minCombinedSmsAlerts
            ? combinedToNotify
            : [],
        });
      }

      await prisma.notificationHistory.createMany({
        data: [
          ...locToNotify.map((item) => ({
            userId: user.id,
            productId: item.productId,
            locationId: item.locationId,
            notificationType: "LOW_STOCK_LOCATION",
          })),
          ...combinedToNotify.map((item) => ({
            userId: user.id,
            productId: item.productId,
            locationId: null,
            notificationType: "LOW_STOCK_COMBINED",
          })),
        ],
      });
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

  /**
   * Run combined + location minimum checks and notify
   */
  async runMinimumsCheck(): Promise<{
    locationBreaches: number;
    combinedBreaches: number;
  }> {
    const { locationBreaches, combinedBreaches } =
      await this.checkMinimums();
    await this.sendMinimumNotifications(
      locationBreaches,
      combinedBreaches
    );
    return {
      locationBreaches: locationBreaches.length,
      combinedBreaches: combinedBreaches.length,
    };
  }
}

// Export singleton instance
export const stockChecker = new StockChecker();
