import { StockStatus } from "@/types/reports";

// Configuration constants
export const DEFAULT_LEAD_TIME_DAYS = 14;
export const HOLDING_COST_RATE = 0.25; // 25% annual
export const DEAD_STOCK_DAYS = 90;
export const STOCKOUT_RISK_THRESHOLD_DAYS = 7;

/**
 * Calculate days of supply for a product
 * @param currentStock - Current inventory quantity
 * @param avgDailyUsage - Average daily outbound movement
 * @returns Days of supply (Infinity if no usage)
 */
export function calculateDaysOfSupply(
  currentStock: number,
  avgDailyUsage: number
): number {
  if (avgDailyUsage <= 0) return Infinity; // No movement = infinite supply (dead stock)
  if (currentStock <= 0) return 0; // No stock = 0 days
  return currentStock / avgDailyUsage;
}

/**
 * Determine order status based on days of supply vs lead time
 * @param daysOfSupply - Calculated days of supply
 * @param leadTimeDays - Lead time for orders (default: 14 days)
 * @returns Order status category
 */
export function getOrderStatus(
  daysOfSupply: number,
  leadTimeDays: number = DEFAULT_LEAD_TIME_DAYS
): StockStatus {
  // Dead stock (infinite supply) is technically "OKAY" from ordering perspective
  // but should be flagged separately for discontinuation review
  if (daysOfSupply === Infinity) return "OKAY";

  if (daysOfSupply < leadTimeDays) return "CRITICAL";
  if (daysOfSupply < leadTimeDays * 1.5) return "NEED_ORDER"; // < 21 days for 14-day lead
  if (daysOfSupply < leadTimeDays * 2) return "RUNNING_LOW"; // < 28 days for 14-day lead
  return "OKAY";
}

/**
 * Calculate monthly carrying cost (inventory holding cost)
 * Based on industry standard: 25% of inventory value annually
 * @param totalCostValue - Total inventory value at cost
 * @param annualRate - Annual holding cost rate (default: 0.25)
 * @returns Monthly carrying cost
 */
export function calculateMonthlyCarryingCost(
  totalCostValue: number,
  annualRate: number = HOLDING_COST_RATE
): number {
  return (totalCostValue * annualRate) / 12;
}

/**
 * Calculate reorder health score (0-100)
 * Represents percentage of products in healthy stock position
 * @param statusCounts - Count of products in each status category
 * @returns Health score percentage (0-100)
 */
export function calculateReorderHealthScore(statusCounts: {
  orderNow: number;
  orderSoon: number;
  watch: number;
  ok: number;
}): number {
  const total =
    statusCounts.orderNow +
    statusCounts.orderSoon +
    statusCounts.watch +
    statusCounts.ok;

  if (total === 0) return 100; // No products = 100% healthy (edge case)

  // Health score = percentage of products in OK or WATCH status
  // (WATCH products are being monitored but not urgent)
  const healthyCount = statusCounts.ok + statusCounts.watch;
  return Math.round((healthyCount / total) * 100);
}

/**
 * Calculate trend percentage between two values
 * @param current - Current period value
 * @param previous - Previous period value
 * @returns Object with value (percentage) and direction
 */
export function calculateTrend(
  current: number,
  previous: number
): { value: number; direction: "up" | "down" | "stable" } {
  if (previous === 0) {
    if (current === 0) return { value: 0, direction: "stable" };
    return { value: 100, direction: "up" }; // From 0 to something = 100% increase
  }

  const percentChange = Math.round(((current - previous) / previous) * 100);

  if (percentChange > 0) return { value: percentChange, direction: "up" };
  if (percentChange < 0) return { value: Math.abs(percentChange), direction: "down" };
  return { value: 0, direction: "stable" };
}

/**
 * Check if a product is considered dead stock
 * @param hasRecentMovement - Whether product had any movement in tracking period
 * @param currentStock - Current stock quantity
 * @returns True if dead stock
 */
export function isDeadStock(
  hasRecentMovement: boolean,
  currentStock: number
): boolean {
  // Dead stock = has inventory but no movement
  // Products with 0 stock are not dead stock (they're out of stock)
  return !hasRecentMovement && currentStock > 0;
}

/**
 * Check if a product is at stockout risk
 * @param currentStock - Current stock quantity
 * @param daysOfSupply - Calculated days of supply
 * @returns True if at stockout risk
 */
export function isStockoutRisk(
  currentStock: number,
  daysOfSupply: number
): boolean {
  // Stockout risk = already out OR very low supply
  if (currentStock <= 0) return true;
  if (daysOfSupply < STOCKOUT_RISK_THRESHOLD_DAYS) return true;
  return false;
}
