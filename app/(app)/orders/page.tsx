"use client";

import { useState, useCallback, useEffect } from "react";
import { Package, Grid3X3, List, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { OrderCard } from "@/components/orders/order-card";
import { OrderDetailsSheet } from "@/components/orders/order-details-sheet";
import { useOrders } from "@/hooks/use-orders";
import { Order } from "@/types/orders";
import { cn } from "@/lib/utils";

type ViewMode = 'grid' | 'list';
type OrderStatus = 'all' | 'pending' | 'in_progress' | 'completed';

export default function OrderPackerPage() {
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [statusFilter, setStatusFilter] = useState<OrderStatus>('all');
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSheetOpen, setIsSheetOpen] = useState(false);

  // Use TanStack Query for data fetching
  const { data, isLoading, error, refetch } = useOrders({ 
    status: statusFilter,
    limit: 20 
  });

  // Pull-to-refresh functionality
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await refetch();
    setIsRefreshing(false);
    
    // Haptic feedback
    if ('vibrate' in navigator) {
      navigator.vibrate(10);
    }
  }, [refetch]);

  // Handle order selection
  const handleOrderSelect = useCallback((order: Order) => {
    setSelectedOrder(order);
    setIsSheetOpen(true);
    
    // Haptic feedback
    if ('vibrate' in navigator) {
      navigator.vibrate(10);
    }
  }, []);

  // Handle swipe action
  const handleOrderSwipe = useCallback((order: Order) => {
    handleOrderSelect(order);
  }, [handleOrderSelect]);

  // Sync status indicator
  const lastSyncTime = new Date().toLocaleTimeString('en-US', { 
    hour: '2-digit', 
    minute: '2-digit' 
  });

  // Count orders by status
  const orderCounts = data?.orders.reduce((
    acc: Record<string, number>,
    order: Order
  ) => {
    acc[order.status] = (acc[order.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>) || {};

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b">
        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold">Order Packer</h1>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Synced {lastSyncTime}
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleRefresh}
                disabled={isRefreshing}
                className="h-8 w-8"
              >
                <RefreshCw className={cn(
                  "h-4 w-4",
                  isRefreshing && "animate-spin"
                )} />
              </Button>
            </div>
          </div>

          {/* Filters and View Toggle */}
          <div className="flex items-center justify-between gap-4">
            <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as OrderStatus)}>
              <TabsList className="h-9">
                <TabsTrigger value="all" className="text-xs">
                  All
                  {orderCounts.pending || orderCounts.in_progress ? (
                    <Badge variant="secondary" className="ml-1.5 px-1.5 min-w-[20px] h-5">
                      {(orderCounts.pending || 0) + (orderCounts.in_progress || 0)}
                    </Badge>
                  ) : null}
                </TabsTrigger>
                <TabsTrigger value="pending" className="text-xs">
                  Pending
                  {orderCounts.pending ? (
                    <Badge variant="secondary" className="ml-1.5 px-1.5 min-w-[20px] h-5">
                      {orderCounts.pending}
                    </Badge>
                  ) : null}
                </TabsTrigger>
                <TabsTrigger value="in_progress" className="text-xs">
                  In Progress
                  {orderCounts.in_progress ? (
                    <Badge variant="secondary" className="ml-1.5 px-1.5 min-w-[20px] h-5">
                      {orderCounts.in_progress}
                    </Badge>
                  ) : null}
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {/* View mode toggle - hidden on mobile */}
            <div className="hidden md:flex">
              <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)}>
                <TabsList className="h-9">
                  <TabsTrigger value="list" className="px-2">
                    <List className="h-4 w-4" />
                  </TabsTrigger>
                  <TabsTrigger value="grid" className="px-2">
                    <Grid3X3 className="h-4 w-4" />
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {isLoading ? (
          <div className={cn(
            viewMode === 'grid' 
              ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
              : "space-y-3"
          )}>
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-lg" />
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Package className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-semibold">Failed to load orders</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Please check your connection and try again
            </p>
            <Button onClick={handleRefresh} className="mt-4">
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </div>
        ) : !data?.orders.length ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Package className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-semibold">No orders found</h3>
            <p className="text-sm text-muted-foreground mt-1">
              {statusFilter === 'all' 
                ? "There are no orders to pack right now"
                : `No ${statusFilter.replace('_', ' ')} orders`}
            </p>
          </div>
        ) : (
          <div className={cn(
            viewMode === 'grid' && "hidden md:grid md:grid-cols-2 lg:grid-cols-3 gap-4",
            viewMode === 'list' && "space-y-3"
          )}>
            {data.orders.map((order) => (
              <OrderCard
                key={order.id}
                order={order}
                onSelect={handleOrderSelect}
                onSwipe={handleOrderSwipe}
              />
            ))}
          </div>
        )}

        {data?.hasMore && (
          <div className="flex justify-center py-4">
            <Button variant="outline" size="sm">
              Load More
            </Button>
          </div>
        )}
      </div>

      {/* Order Details Sheet */}
      <OrderDetailsSheet
        order={selectedOrder}
        open={isSheetOpen}
        onOpenChange={setIsSheetOpen}
      />
    </div>
  );
}
