"use client";

import { useState, useCallback, useEffect } from "react";
import { Package, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalOrderCard } from "@/components/orders/external-order-card";
import { OrderFilters } from "@/components/orders/order-filters";
import { OrderDetailsSheet } from "@/components/orders/order-details-sheet";
import { useExternalOrders, useUserCompanies } from "@/hooks/use-external-orders";
import { cn } from "@/lib/utils";
import type { ExternalOrder, PlatformType, InternalOrderStatus } from "@/types/external-orders";

export default function OrdersPage() {
  // State for filters
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [platform, setPlatform] = useState<PlatformType | "ALL">("ALL");
  const [status, setStatus] = useState<InternalOrderStatus | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedOrder, setSelectedOrder] = useState<ExternalOrder | null>(null);
  const [isSheetOpen, setIsSheetOpen] = useState(false);

  // Fetch user's companies
  const { data: companiesData, isLoading: companiesLoading } = useUserCompanies();
  const companies = companiesData?.companies || [];

  // Set default company when companies are loaded
  useEffect(() => {
    if (companies.length > 0 && !selectedCompanyId) {
      setSelectedCompanyId(companies[0].id);
    }
  }, [companies, selectedCompanyId]);

  // Fetch orders with filters
  const {
    data: ordersData,
    isLoading: ordersLoading,
    error: ordersError,
    refetch,
    isFetching,
  } = useExternalOrders({
    companyId: selectedCompanyId || undefined,
    platform,
    status,
    search: searchQuery,
    page: 1,
    pageSize: 50,
  });

  const orders = ordersData?.orders || [];
  const hasMore = ordersData?.hasMore || false;

  // Handle order selection
  const handleOrderSelect = useCallback((order: ExternalOrder) => {
    setSelectedOrder(order);
    setIsSheetOpen(true);
  }, []);

  // Handle refresh
  const handleRefresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  // Loading state
  if (companiesLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // No companies state
  if (companies.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-center px-4">
        <Package className="h-16 w-16 text-muted-foreground/50 mb-4" />
        <h2 className="text-2xl font-semibold mb-2">No Companies Found</h2>
        <p className="text-muted-foreground max-w-md">
          You need to be associated with a company to view orders. Please contact your administrator.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Orders</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage external orders from Shopify and WooCommerce
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={isFetching}
          className="gap-2"
        >
          <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </div>

      {/* Filters */}
      <OrderFilters
        companies={companies}
        selectedCompanyId={selectedCompanyId}
        onCompanyChange={setSelectedCompanyId}
        platform={platform}
        onPlatformChange={setPlatform}
        status={status}
        onStatusChange={setStatus}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />

      {/* Orders List */}
      <div className="space-y-4">
        {ordersLoading ? (
          // Loading skeleton
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-32 w-full rounded-lg" />
            ))}
          </div>
        ) : ordersError ? (
          // Error state
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Package className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-semibold mb-2">Failed to Load Orders</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Please check your connection and try again
            </p>
            <Button onClick={handleRefresh} variant="outline">
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </div>
        ) : orders.length === 0 ? (
          // Empty state
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Package className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Orders Found</h3>
            <p className="text-sm text-muted-foreground">
              {searchQuery
                ? "No orders match your search criteria"
                : status !== "all"
                ? `No ${status} orders found`
                : "No orders available"}
            </p>
          </div>
        ) : (
          // Orders grid
          <>
            <div className="grid gap-3 grid-cols-1 lg:grid-cols-2 xl:grid-cols-3">
              {orders.map((order) => (
                <ExternalOrderCard
                  key={order.id}
                  order={order}
                  onSelect={handleOrderSelect}
                />
              ))}
            </div>

            {/* Load More (if needed) */}
            {hasMore && (
              <div className="flex justify-center pt-4">
                <Button variant="outline" size="sm">
                  Load More
                </Button>
              </div>
            )}

            {/* Results summary */}
            <div className="text-center text-sm text-muted-foreground py-4">
              Showing {orders.length} of {ordersData?.total || 0} orders
            </div>
          </>
        )}
      </div>

      {/* Order Details Sheet */}
      {selectedOrder && (
        <OrderDetailsSheet
          order={selectedOrder as any}
          open={isSheetOpen}
          onOpenChange={setIsSheetOpen}
        />
      )}
    </div>
  );
}
