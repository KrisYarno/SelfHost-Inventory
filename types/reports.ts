// Report Types

// Stock status for reorder recommendations (simplified - based on user-set minimums)
export type StockStatus = 'CRITICAL' | 'NEED_ORDER' | 'RUNNING_LOW' | 'OKAY';

// Trend direction
export type TrendDirection = 'up' | 'down' | 'stable';

// Key metrics for dashboard
export interface DashboardMetrics {
  // Legacy metrics (keep for backwards compatibility)
  totalProducts: number;
  activeProducts: number;
  totalInventoryValue: number;
  totalInventoryCostValue: number;
  totalInventoryRetailValue: number;
  totalStockQuantity: number;
  lowStockProducts: number;
  recentActivityCount: number;
  lastUpdated: Date;

  // New warehouse decision metrics
  orderNowCount: number;        // Products with daysOfSupply < leadTime (14 days)
  orderSoonCount: number;       // Products with daysOfSupply < leadTime * 1.5 (21 days)
  daysOfSupplyAvg: number;      // Average across products with movement
  monthlyCarryingCost: number;  // (totalInventoryCostValue * 0.25) / 12
  deadStockValue: number;       // Cost value of products with 0 movement in 90 days
  stockoutRiskCount: number;    // Products with currentStock = 0 or daysOfSupply < 7
  reorderHealthScore: number;   // % of products in OK status (0-100)

  // Trend data (calculated, not hardcoded)
  lowStockTrend?: { value: number; direction: TrendDirection };
}

// Activity timeline item
export interface ActivityItem {
  id: string;
  timestamp: Date;
  type: 'stock_in' | 'stock_out' | 'adjustment' | 'product_created' | 'product_updated';
  description: string;
  user: {
    id: number;
    username: string;
  };
  product?: {
    id: number;
    name: string;
  };
  location?: {
    id: number;
    name: string;
  };
  metadata?: {
    quantityChange?: number;
    orderNumber?: string;
    reason?: string;
    notes?: string;
  };
}

// Product performance data
export interface ProductPerformance {
  productId: number;
  productName: string;
  currentStock: number;
  stockMovement30Days: number;
  turnoverRate: number;
  lastActivity: Date;
  trend: 'up' | 'down' | 'stable';
}

// User activity summary
export interface UserActivitySummary {
  userId: number;
  username: string;
  totalTransactions: number;
  stockInCount: number;
  stockOutCount: number;
  adjustmentCount: number;
  lastActivity: Date | null;
}

// Low stock alert
export interface LowStockAlert {
  productId: number;
  productName: string;
  currentStock: number;
  threshold: number;
  percentageRemaining: number;
  // null = usage UNKNOWN (no qualifying outbound movement), never a fabricated 0/day
  // (spec §2 D4). `usageKnown` distinguishes a measured 0 from an unknown rate.
  averageDailyUsage: number | null;
  usageKnown: boolean;
  daysUntilEmpty: number | null;
}

// Chart data types
export interface StockLevelChartData {
  date: string;
  quantity: number;
}

export interface ProductMovementChartData {
  product: string;
  stockIn: number;
  stockOut: number;
  net: number;
}

export interface ActivityChartData {
  date: string;
  stockIn: number;
  stockOut: number;
  adjustments: number;
}

// Date range filter
export interface DateRangeFilter {
  startDate: Date;
  endDate: Date;
  preset?: 'today' | 'yesterday' | 'last7days' | 'last30days' | 'thisMonth' | 'lastMonth' | 'custom';
}

// API Response types
export interface MetricsResponse {
  metrics: DashboardMetrics;
}

export interface ActivityResponse {
  activities: ActivityItem[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface LowStockResponse {
  alerts: LowStockAlert[];
  threshold: number;
  // Definition of the per-row usage rate (spec §2 D3 = OUTBOUND_USAGE_DEFINITION).
  velocityDefinition: string;
}

export interface UserActivityResponse {
  users: UserActivitySummary[];
}

export interface ProductPerformanceResponse {
  products: ProductPerformance[];
  dateRange: DateRangeFilter;
}


// Server-side aggregated product movement summary (replaces 5000-log client fetch)
export interface ProductMovementSummary {
  productId: number;
  productName: string;
  currentStock: number;
  stockIn: number;
  stockOut: number;
  netMovement: number;
  transactionCount: number;
  trend: TrendDirection;
  lastActivityDate: Date | null;
}


// Response from product movement summary API
export interface ProductMovementSummaryResponse {
  products: ProductMovementSummary[];
  period: {
    days: number;
    startDate: Date;
    endDate: Date;
  };
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

// ============================================
// Reorder report types
// ============================================
//
// The demand-based reorder report supersedes the old threshold-based
// ReorderRecommendation shape (which converted unknown cost to $0). Its
// discriminated-row + coverage types live with the computation in
// `lib/reports/reorder.ts`; consumers `import type { ReorderRow, ReorderReport }`
// from there.
