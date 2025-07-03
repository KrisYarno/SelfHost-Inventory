import { QueryClient } from '@tanstack/react-query';

// Cache key prefixes for organization
export const CACHE_KEYS = {
  PRODUCTS: 'products',
  INVENTORY: 'inventory',
  LOCATIONS: 'locations',
  REPORTS: 'reports',
  USERS: 'users',
  LOGS: 'logs',
} as const;

// Cache times in milliseconds
export const CACHE_TIMES = {
  // Static data - cache for 1 hour
  LOCATIONS: 60 * 60 * 1000,
  USERS: 60 * 60 * 1000,
  
  // Semi-static data - cache for 15 minutes
  PRODUCTS: 15 * 60 * 1000,
  
  // Dynamic data - cache for 5 minutes
  INVENTORY: 5 * 60 * 1000,
  REPORTS: 5 * 60 * 1000,
  
  // Frequently changing data - cache for 1 minute
  LOGS: 60 * 1000,
} as const;

// Query key factories for consistent cache keys
export const queryKeys = {
  // Products
  products: {
    all: [CACHE_KEYS.PRODUCTS] as const,
    list: (filters?: any) => [CACHE_KEYS.PRODUCTS, 'list', filters] as const,
    detail: (id: number) => [CACHE_KEYS.PRODUCTS, 'detail', id] as const,
    search: (query: string) => [CACHE_KEYS.PRODUCTS, 'search', query] as const,
  },
  
  // Inventory
  inventory: {
    all: [CACHE_KEYS.INVENTORY] as const,
    current: (locationId?: number) => [CACHE_KEYS.INVENTORY, 'current', locationId] as const,
    product: (productId: number, locationId?: number) => 
      [CACHE_KEYS.INVENTORY, 'product', productId, locationId] as const,
    lowStock: (threshold?: number) => [CACHE_KEYS.INVENTORY, 'lowStock', threshold] as const,
  },
  
  // Locations
  locations: {
    all: [CACHE_KEYS.LOCATIONS] as const,
    detail: (id: number) => [CACHE_KEYS.LOCATIONS, 'detail', id] as const,
  },
  
  // Reports
  reports: {
    all: [CACHE_KEYS.REPORTS] as const,
    metrics: (filters?: any) => [CACHE_KEYS.REPORTS, 'metrics', filters] as const,
    activity: (filters?: any) => [CACHE_KEYS.REPORTS, 'activity', filters] as const,
    userActivity: (userId?: number) => [CACHE_KEYS.REPORTS, 'userActivity', userId] as const,
  },
  
  // Logs
  logs: {
    all: [CACHE_KEYS.LOGS] as const,
    list: (filters?: any) => [CACHE_KEYS.LOGS, 'list', filters] as const,
    product: (productId: number) => [CACHE_KEYS.LOGS, 'product', productId] as const,
  },
} as const;

// Optimized query client configuration
export const createQueryClient = () => new QueryClient({
  defaultOptions: {
    queries: {
      // Default cache time
      staleTime: CACHE_TIMES.INVENTORY,
      // Keep in cache for twice the stale time
      gcTime: CACHE_TIMES.INVENTORY * 2,
      // Retry configuration
      retry: (failureCount, error: any) => {
        // Don't retry on 4xx errors
        if (error?.status >= 400 && error?.status < 500) {
          return false;
        }
        // Retry up to 2 times for other errors
        return failureCount < 2;
      },
      // Don't refetch on window focus by default
      refetchOnWindowFocus: false,
      // Refetch on mount only if stale
      refetchOnMount: 'always',
    },
    mutations: {
      // Optimistic updates retry configuration
      retry: 1,
    },
  },
});

// Cache invalidation helpers
export const cacheInvalidators = {
  // Invalidate all product-related queries
  invalidateProducts: (queryClient: QueryClient) => {
    queryClient.invalidateQueries({ queryKey: queryKeys.products.all });
    queryClient.invalidateQueries({ queryKey: queryKeys.inventory.all });
  },
  
  // Invalidate specific product
  invalidateProduct: (queryClient: QueryClient, productId: number) => {
    queryClient.invalidateQueries({ queryKey: queryKeys.products.detail(productId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.inventory.product(productId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.logs.product(productId) });
  },
  
  // Invalidate inventory data
  invalidateInventory: (queryClient: QueryClient, locationId?: number) => {
    if (locationId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.inventory.current(locationId) });
    } else {
      queryClient.invalidateQueries({ queryKey: queryKeys.inventory.all });
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.reports.all });
  },
  
  // Invalidate reports
  invalidateReports: (queryClient: QueryClient) => {
    queryClient.invalidateQueries({ queryKey: queryKeys.reports.all });
  },
};

// Prefetch helpers for common navigation patterns
export const prefetchHelpers = {
  // Prefetch dashboard data
  prefetchDashboard: async (queryClient: QueryClient, locationId: number) => {
    await Promise.all([
      queryClient.prefetchQuery({
        queryKey: queryKeys.inventory.current(locationId),
        staleTime: CACHE_TIMES.INVENTORY,
      }),
      queryClient.prefetchQuery({
        queryKey: queryKeys.reports.metrics({ locationId }),
        staleTime: CACHE_TIMES.REPORTS,
      }),
      queryClient.prefetchQuery({
        queryKey: queryKeys.inventory.lowStock(),
        staleTime: CACHE_TIMES.REPORTS,
      }),
    ]);
  },
  
  // Prefetch product details
  prefetchProductDetails: async (queryClient: QueryClient, productId: number) => {
    await Promise.all([
      queryClient.prefetchQuery({
        queryKey: queryKeys.products.detail(productId),
        staleTime: CACHE_TIMES.PRODUCTS,
      }),
      queryClient.prefetchQuery({
        queryKey: queryKeys.logs.product(productId),
        staleTime: CACHE_TIMES.LOGS,
      }),
    ]);
  },
};