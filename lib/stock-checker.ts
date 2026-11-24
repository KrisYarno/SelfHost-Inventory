import prisma from '@/lib/prisma';
import { emailService, LowStockItem } from '@/lib/email';
import type { DeliveryNotSentReason, DeliveryResult } from '@/lib/email';
import type { CombinedMinBreach, LocationMinBreach } from '@/types/inventory';
import {
  getLowStockDefault,
  effectiveLowStockThreshold,
  isLowStock,
} from '@/lib/stock-threshold';
import { outboundVelocity } from '@/lib/reports/demand';

/**
 * N0 (C3/D1): what a notification run actually did, per email (one per user).
 *   - emailsSent      deliver returned { sent: true };
 *   - emailsNotSent   deliver returned anything else (the switch withheld it);
 *   - emailsFailed    the provider threw;
 *   - notSentReasons  emailsNotSent, by reason.
 * NotificationHistory (the 24 h dedupe) is written ONLY for sent email, so a run
 * the switch withheld never silences the next one.
 */
export interface EmailRunCounts {
  emailsSent: number;
  emailsNotSent: number;
  emailsFailed: number;
  notSentReasons: Record<DeliveryNotSentReason, number>;
}

function emptyEmailRunCounts(): EmailRunCounts {
  return {
    emailsSent: 0,
    emailsNotSent: 0,
    emailsFailed: 0,
    notSentReasons: { unconfigured: 0, off: 0, not_allowlisted: 0 },
  };
}

// N0 FR3 G6: a failure's code for a log line — Prisma's `code`, else its
// `errorCode` (an initialization error), else the error's name. Never the message.
function errorCodeOrName(error: unknown): string {
  const failure = error as { code?: unknown; errorCode?: unknown; name?: unknown } | null | undefined;
  if (typeof failure?.code === 'string') return failure.code;
  if (typeof failure?.errorCode === 'string') return failure.errorCode;
  if (typeof failure?.name === 'string') return failure.name;
  return 'unknown';
}

// Fail-closed: anything other than exactly { sent: true } is "not sent".
function countNotSent(counts: EmailRunCounts, result: DeliveryResult | undefined): void {
  counts.emailsNotSent++;
  const reason = result && result.sent === false ? result.reason : undefined;
  if (reason && reason in counts.notSentReasons) counts.notSentReasons[reason]++;
  console.log(`email not sent (${reason ?? 'no delivery result'})`);
}

export interface LowStockProduct {
  id: number;
  name: string;
  currentStock: number;
  threshold: number;
  daysUntilEmpty: number | null;
}

/**
 * Days until a product runs out, from a precomputed average daily outflow.
 * Pure so callers can batch the outflow read once and map over the result.
 * 0 stock -> 0 days; no measurable outflow -> null (unknown).
 */
function daysUntilEmptyFrom(currentQuantity: number, avgDailyOutflow: number): number | null {
  if (currentQuantity <= 0) return 0;
  if (avgDailyOutflow <= 0) return null;
  return Math.floor(currentQuantity / avgDailyOutflow);
}

export class StockChecker {
  /**
   * Check all products for low stock and return those below threshold
   */
  async checkLowStock(): Promise<LowStockProduct[]> {
    // Get all products with their thresholds and current quantities.
    // Exclude soft-deleted products so deleted products don't trigger alerts
    // (matches checkMinimums behavior — current-state reports skip deleted).
    // NOTE: no `lowStockThreshold > 0` SQL prefilter anymore — a NULL threshold
    // now INHERITS the configurable system default (R-L13), so those products
    // must be evaluated too. The shared `isLowStock` predicate (INCLUSIVE ≤) is
    // the single notification boundary; a 0 effective threshold disables alerts.
    const systemDefault = await getLowStockDefault();
    const products = await prisma.product.findMany({
      where: {
        deletedAt: null,
        // Provisional (PENDING_REVIEW) products are excluded from operational
        // alerts until an admin approves them.
        approvalStatus: 'APPROVED',
      },
      include: {
        product_locations: true,
      },
    });

    // First pass: identify low products via the shared predicate.
    const lowCandidates: Array<{ id: number; name: string; total: number; threshold: number }> = [];
    for (const product of products) {
      const totalQuantity = product.product_locations.reduce(
        (sum, location) => sum + location.quantity,
        0
      );
      const threshold = effectiveLowStockThreshold(product.lowStockThreshold, systemDefault);
      if (isLowStock(totalQuantity, threshold)) {
        lowCandidates.push({
          id: product.id,
          name: product.name,
          total: totalQuantity,
          threshold,
        });
      }
    }

    // Batch the outflow-usage read for ALL low products in ONE groupBy (R-L12 —
    // replaces the former per-product query N+1). daysUntilEmpty is outflow-based
    // (includes transfers and corrections), not SALE-only.
    const usageByProduct = await this.batchAvgDailyOutflow(lowCandidates.map((c) => c.id));

    const lowStockProducts: LowStockProduct[] = lowCandidates.map((c) => ({
      id: c.id,
      name: c.name,
      currentStock: c.total,
      threshold: c.threshold,
      daysUntilEmpty: daysUntilEmptyFrom(c.total, usageByProduct.get(c.id) ?? 0),
    }));

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
    // Combined-minimum breaches key on lowStockThreshold, which now INHERITS the
    // system default when NULL (R-L13) — preserving the pre-migration behavior of
    // the seeded 10 for products that were reset to NULL by the migration.
    const systemDefault = await getLowStockDefault();
    const products = await prisma.product.findMany({
      where: { deletedAt: null, approvalStatus: 'APPROVED' },
      include: {
        product_locations: {
          include: { locations: true },
        },
      },
    });

    const locationBreaches: LocationMinBreach[] = [];
    // Build combined breaches first WITHOUT daysUntilEmpty, collect ids, then
    // batch the outflow-usage read (R-L12 — no per-product query N+1).
    const combinedPending: Array<{
      productId: number;
      productName: string;
      totalQuantity: number;
      combinedMinimum: number;
    }> = [];

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

      const combinedMin = effectiveLowStockThreshold(product.lowStockThreshold, systemDefault);
      if (combinedMin > 0 && totalQuantity < combinedMin) {
        combinedPending.push({
          productId: product.id,
          productName: product.name,
          totalQuantity,
          combinedMinimum: combinedMin,
        });
      }
    }

    const usageByProduct = await this.batchAvgDailyOutflow(
      combinedPending.map((c) => c.productId)
    );
    const combinedBreaches: CombinedMinBreach[] = combinedPending.map((c) => ({
      ...c,
      daysUntilEmpty: daysUntilEmptyFrom(c.totalQuantity, usageByProduct.get(c.productId) ?? 0),
    }));

    return { locationBreaches, combinedBreaches };
  }

  /**
   * Check per-location minimum breaches for a single location.
   * Returns items sorted by shortage (largest first).
   */
  async checkLocationMinimums(locationId: number): Promise<{
    items: Array<{
      productId: number;
      productName: string;
      locationId: number;
      locationName: string;
      currentQuantity: number;
      minQuantity: number;
      shortage: number;
    }>;
  }> {
    const rows = await prisma.product_locations.findMany({
      where: { locationId },
      include: {
        products: { select: { id: true, name: true } },
        locations: { select: { name: true } },
      },
    });

    const items = rows
      .filter((row) => (row.minQuantity ?? 0) > 0 && row.quantity < row.minQuantity!)
      .map((row) => ({
        productId: row.productId,
        productName: row.products.name,
        locationId: row.locationId,
        locationName: row.locations.name,
        currentQuantity: row.quantity,
        minQuantity: row.minQuantity ?? 0,
        shortage: Math.max((row.minQuantity ?? 0) - row.quantity, 0),
      }))
      .sort((a, b) => b.shortage - a.shortage);

    return { items };
  }

  /**
   * Batch the 30-day average daily OUTFLOW for many products via the ONE shared
   * units-out velocity (lib/reports/demand.ts). Outflow = negative deltas that are NOT
   * internal transfers (Lane 6 / review M2 / D-T5): a transfer between our own
   * locations is not consumption, and counting it here (this method drives the
   * low-stock ALERT EMAILS via checkLowStock) shortened every runway. The shared
   * definition also brings the truthful days-covered denominator (reorder-points Task 2
   * — a DELIBERATE change from the former flat /30). Products with no outflow are absent
   * from the map (callers treat that as "no usage" -> null days).
   */
  private async batchAvgDailyOutflow(productIds: number[]): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (productIds.length === 0) return map;

    const velocity = await outboundVelocity(productIds, 30);
    velocity.forEach((demand, id) => {
      if (demand.avgDailyDemand != null) map.set(id, demand.avgDailyDemand);
    });
    return map;
  }

  /**
   * Send low stock notifications to users who have opted in
   */
  async sendLowStockNotifications(lowStockProducts: LowStockProduct[]): Promise<EmailRunCounts> {
    const counts = emptyEmailRunCounts();
    if (lowStockProducts.length === 0) return counts;

    // Get users who have opted in for email alerts (never a soft-deleted user — N0 C1)
    const users = await prisma.user.findMany({
      where: {
        emailAlerts: true,
        isApproved: true,
        deletedAt: null,
      },
    });

    if (users.length === 0) return counts;

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

      // Send email
      const emailItems: LowStockItem[] = productsToNotify.map(p => ({
        productName: p.name,
        currentStock: p.currentStock,
        threshold: p.threshold,
        daysUntilEmpty: p.daysUntilEmpty,
      }));

      let result: DeliveryResult | undefined;
      try {
        result = await emailService.sendLowStockDigest(
          user.email,
          {
            recipientName: user.username,
            items: emailItems,
          }
        );
      } catch (error) {
        counts.emailsFailed++;
        // N0 FR2 F2: the message only (cut at 200), never the error object.
        console.error(
          `Failed to send low stock notification (user ${user.id}):`,
          error instanceof Error ? error.message.slice(0, 200) : "unknown"
        );
        continue;
      }

      if (result?.sent !== true) {
        countNotSent(counts, result);
        continue;
      }
      counts.emailsSent++;

      try {
        // Record notification history — only for the items in an email actually sent
        await prisma.notificationHistory.createMany({
          data: productsToNotify.map(p => ({
            userId: user.id,
            productId: p.id,
            notificationType: 'low_stock',
          })),
        });

        console.log(`Sent low stock notification (user ${user.id}) for ${productsToNotify.length} products`);
      } catch (error) {
        // N0 FR3 G6: the context and the error's code or name — never the object
        // (a Prisma message can name the database host or user).
        console.error(
          `Failed to record low stock notification history (user ${user.id}) (${errorCodeOrName(error)})`
        );
      }
    }

    return counts;
  }

  /**
   * Send notifications for minimum breaches via email
   */
  async sendMinimumNotifications(
    locationBreaches: LocationMinBreach[],
    combinedBreaches: CombinedMinBreach[]
  ): Promise<EmailRunCounts> {
    const counts = emptyEmailRunCounts();
    if (!locationBreaches.length && !combinedBreaches.length) {
      return counts;
    }

    // Never a soft-deleted user (N0 C1).
    const users = await prisma.user.findMany({
      where: {
        isApproved: true,
        deletedAt: null,
        OR: [
          { minLocationEmailAlerts: true },
          { minCombinedEmailAlerts: true },
          { emailAlerts: true },
        ],
      },
    });

    if (!users.length) return counts;

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

      // The items THIS user's email includes (by their flags).
      const locationIncluded = user.minLocationEmailAlerts ? locToNotify : [];
      const combinedIncluded =
        user.minCombinedEmailAlerts || user.emailAlerts ? combinedToNotify : [];

      // Email notifications. A flag mismatch (no email attempted) writes no history.
      // NOTE (N0 C3b): this loop deliberately has no try/catch yet — a provider throw
      // still ends the run, as before; per-recipient isolation is N1 (RC-11).
      if (
        (user.minLocationEmailAlerts && locToNotify.length > 0) ||
        (user.minCombinedEmailAlerts && combinedToNotify.length > 0) ||
        (user.emailAlerts && combinedToNotify.length > 0)
      ) {
        const result: DeliveryResult | undefined = await emailService.sendMinimumsDigest(
          user.email,
          {
            recipientName: user.username,
            locationItems: locationIncluded,
            combinedItems: combinedIncluded,
          }
        );

        if (result?.sent !== true) {
          countNotSent(counts, result);
          continue;
        }
        counts.emailsSent++;

        // History ONLY for the items included in an email actually sent.
        await prisma.notificationHistory.createMany({
          data: [
            ...locationIncluded.map((item) => ({
              userId: user.id,
              productId: item.productId,
              locationId: item.locationId,
              notificationType: "LOW_STOCK_LOCATION",
            })),
            ...combinedIncluded.map((item) => ({
              userId: user.id,
              productId: item.productId,
              locationId: null,
              notificationType: "LOW_STOCK_COMBINED",
            })),
          ],
        });
      }
    }

    return counts;
  }

  /**
   * Run the complete stock check and notification process
   */
  async runDailyCheck(): Promise<{ lowStockCount: number } & EmailRunCounts> {
    console.log('Starting daily stock check...');
    
    const lowStockProducts = await this.checkLowStock();
    console.log(`Found ${lowStockProducts.length} products below threshold`);

    const counts =
      lowStockProducts.length > 0
        ? await this.sendLowStockNotifications(lowStockProducts)
        : emptyEmailRunCounts();

    return {
      lowStockCount: lowStockProducts.length,
      ...counts,
    };
  }

  /**
   * Run combined + location minimum checks and notify
   */
  async runMinimumsCheck(): Promise<
    { locationBreaches: number; combinedBreaches: number } & EmailRunCounts
  > {
    const { locationBreaches, combinedBreaches } =
      await this.checkMinimums();
    const counts = await this.sendMinimumNotifications(
      locationBreaches,
      combinedBreaches
    );
    return {
      locationBreaches: locationBreaches.length,
      combinedBreaches: combinedBreaches.length,
      ...counts,
    };
  }
}

// Export singleton instance
export const stockChecker = new StockChecker();
