// Report Types

// Key metrics for dashboard
export interface DashboardMetrics {
  totalProducts: number;
  activeProducts: number;
  totalInventoryValue: number;
  totalInventoryCostValue: number;
  totalInventoryRetailValue: number;
  totalStockQuantity: number;
  lowStockProducts: number;
  recentActivityCount: number;
  lastUpdated: Date;
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
