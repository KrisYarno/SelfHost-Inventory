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
  lastActivity: Date;
}

// Low stock alert
export interface LowStockAlert {
  productId: number;
  productName: string;
  currentStock: number;
  threshold: number;
  percentageRemaining: number;
  averageDailyUsage: number;
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
// Reorder Recommendations Types (Simplified)
// ============================================

// Reorder recommendation for a product (based on user-set minimums)
export interface ReorderRecommendation {
  productId: number;
  productName: string;

  // Variant fields for sorting
  baseName: string | null;           // Base product name (e.g., "T-Shirt")
  variant: string | null;            // Variant descriptor (e.g., "Large", "Red")
  numericValue: number | null;       // Numeric value for size sorting (e.g., 1.5, 3.0)

  // Simple status based on minimum threshold
  status: StockStatus;

  // Stock info
  currentStock: number;
  minimum: number | null;            // lowStockThreshold value
  stockToMinimumRatio: number;       // currentStock / minimum (Infinity if no minimum)

  // For display
  costPrice: number;
  estimatedOrderValue: number;       // (minimum - currentStock) * costPrice if below minimum
}

// Summary of reorder recommendations
export interface ReorderSummary {
  criticalCount: number;
  needOrderCount: number;
  runningLowCount: number;
  okayCount: number;
  totalOrderValue: number;           // Sum for CRITICAL + NEED_ORDER
}

// Response from reorder recommendations API
export interface ReorderRecommendationsResponse {
  recommendations: ReorderRecommendation[];
  summary: ReorderSummary;
}
