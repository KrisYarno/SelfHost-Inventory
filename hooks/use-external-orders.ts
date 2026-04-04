"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebounce } from "./use-debounce";
import type {
  ExternalOrder,
  ExternalOrderFilters,
  ExternalOrdersResponse,
  PlatformType,
  InternalOrderStatus,
} from "@/types/external-orders";

/**
 * Custom hook for fetching external orders with filtering and pagination
 * Follows the same pattern as use-products.ts
 */
export function useExternalOrders(filters: ExternalOrderFilters) {
  const debouncedSearch = useDebounce(filters.search || "", 300);

  const queryKey = [
    "external-orders",
    {
      ...filters,
      search: debouncedSearch,
    },
  ];

  return useQuery<ExternalOrdersResponse>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();

      if (filters.companyId) params.set("companyId", filters.companyId);
      if (filters.platform && filters.platform !== "ALL") params.set("platform", filters.platform);
      if (filters.status && filters.status !== "all") params.set("status", filters.status);
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (filters.page) params.set("page", filters.page.toString());
      if (filters.pageSize) params.set("pageSize", filters.pageSize.toString());
      if (filters.cursor) params.set("cursor", filters.cursor);

      const response = await fetch(`/api/orders/external?${params}`);
      if (!response.ok) {
        throw new Error("Failed to fetch external orders");
      }

      return response.json();
    },
    // Keep previous data while fetching new data (prevents flickering)
    placeholderData: (previousData) => previousData,
    // Auto-refresh every 30 seconds to catch new orders
    refetchInterval: 30 * 1000,
    // Consider data fresh for 10 seconds
    staleTime: 10 * 1000,
  });
}

/**
 * Get details for a specific external order
 */
export function useExternalOrder(orderId: string | null) {
  return useQuery<ExternalOrder>({
    queryKey: ["external-order", orderId],
    queryFn: async () => {
      if (!orderId) throw new Error("No order ID provided");

      const response = await fetch(`/api/orders/external/${orderId}`);
      if (!response.ok) {
        throw new Error("Failed to fetch order details");
      }

      return response.json();
    },
    enabled: !!orderId,
  });
}

/**
 * Hook to get user's companies for filtering
 */
export function useUserCompanies() {
  return useQuery({
    queryKey: ["user-companies"],
    queryFn: async () => {
      const response = await fetch("/api/companies/user");
      if (!response.ok) {
        throw new Error("Failed to fetch user companies");
      }
      return response.json();
    },
    // Cache companies data for longer since it changes infrequently
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Get order statistics/counts by status
 */
export function useOrderStats(companyId: string | null, platform?: PlatformType | "ALL") {
  return useQuery({
    queryKey: ["order-stats", companyId, platform],
    queryFn: async () => {
      if (!companyId) return null;

      const params = new URLSearchParams();
      params.set("companyId", companyId);
      if (platform && platform !== "ALL") params.set("platform", platform);

      const response = await fetch(`/api/orders/external/stats?${params}`);
      if (!response.ok) {
        throw new Error("Failed to fetch order stats");
      }

      return response.json();
    },
    enabled: !!companyId,
    refetchInterval: 30 * 1000,
  });
}
