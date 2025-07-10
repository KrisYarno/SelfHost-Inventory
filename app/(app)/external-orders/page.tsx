"use client";

import { useState, useCallback } from "react";
import { Package, RefreshCw, AlertCircle, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PackingSheet } from "@/components/orders/packing-sheet";
import { useLocation } from "@/contexts/location-context";
import { toast } from "sonner";
import { useSession } from "next-auth/react";
import { addCSRFHeader } from "@/lib/csrf-client";
import type { ExternalOrderWithItems, ExternalOrderListItem } from "@/types/external-orders";
import type { OrderItem } from "@/types/orders";

export default function ExternalOrdersPage() {
  const { data: session } = useSession();
  const { selectedLocationId } = useLocation();
  const [orders, setOrders] = useState<ExternalOrderListItem[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<ExternalOrderWithItems | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isPackingOpen, setIsPackingOpen] = useState(false);

  // Fetch orders
  const fetchOrders = useCallback(async () => {
    if (!selectedLocationId) return;

    setIsLoading(true);
    try {
      const response = await fetch(`/api/orders/external?locationId=${selectedLocationId}&status=PROCESSING`, {
        headers: addCSRFHeader()
      });

      if (!response.ok) {
        throw new Error('Failed to fetch orders');
      }

      const data = await response.json();
      setOrders(data.orders);
    } catch (error) {
      console.error('Error fetching orders:', error);
      toast.error('Failed to load orders');
    } finally {
      setIsLoading(false);
    }
  }, [selectedLocationId]);

  // Refresh orders
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await fetchOrders();
    setIsRefreshing(false);
    toast.success('Orders refreshed');
  }, [fetchOrders]);

  // Lock order and open packing sheet
  const handleStartPacking = useCallback(async (orderId: string) => {
    if (!session?.user?.id || !selectedLocationId) return;

    try {
      // First, lock the order
      const lockResponse = await fetch(`/api/orders/external/${orderId}/lock`, {
        method: 'POST',
        headers: addCSRFHeader({
          'Content-Type': 'application/json'
        }),
        body: JSON.stringify({ locationId: selectedLocationId })
      });

      if (!lockResponse.ok) {
        const error = await lockResponse.json();
        throw new Error(error.error || 'Failed to lock order');
      }

      // Then fetch full order details
      const detailsResponse = await fetch(`/api/orders/external/${orderId}`, {
        headers: addCSRFHeader()
      });

      if (!detailsResponse.ok) {
        throw new Error('Failed to fetch order details');
      }

      const orderData: ExternalOrderWithItems = await detailsResponse.json();
      setSelectedOrder(orderData);
      setIsPackingOpen(true);
    } catch (error) {
      console.error('Error starting packing:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to start packing');
    }
  }, [session, selectedLocationId]);

  // Handle packing completion (not used directly, handled by PackingSheet)
  const handlePackingComplete = useCallback(async (packedItems: string[]) => {
    // This is handled internally by PackingSheet
    console.log('Packing completed with items:', packedItems);
  }, []);

  // Handle successful packing
  const handlePackingSuccess = useCallback(() => {
    // Refresh the orders list
    fetchOrders();
    // Clear selected order
    setSelectedOrder(null);
  }, [fetchOrders]);

  // Convert external order items to OrderItem format for PackingSheet
  const convertToOrderItems = (externalItems: ExternalOrderWithItems['items']): OrderItem[] => {
    return externalItems.map(item => ({
      id: item.id,
      name: item.productName,
      quantity: item.quantity,
      currentStock: 100, // This should come from actual inventory check
      productId: item.productId,
      isMapped: !!item.productId
    } as any));
  };

  // Initial load
  useState(() => {
    if (selectedLocationId) {
      fetchOrders();
    }
  });

  if (!selectedLocationId) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <AlertCircle className="h-12 w-12 text-muted-foreground/50 mb-4" />
          <h3 className="text-lg font-semibold">No Location Selected</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Please select a location to view orders
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">External Orders</h1>
          <p className="text-muted-foreground">
            Pack and fulfill orders from external systems
          </p>
        </div>
        <Button
          variant="outline"
          size="icon"
          onClick={handleRefresh}
          disabled={isRefreshing}
        >
          <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Orders Grid */}
      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-48" />
          ))}
        </div>
      ) : orders.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Package className="h-12 w-12 text-muted-foreground/50 mb-4" />
          <h3 className="text-lg font-semibold">No Orders to Pack</h3>
          <p className="text-sm text-muted-foreground mt-1">
            There are no processing orders at this location
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {orders.map((order) => (
            <Card key={order.id} className="relative">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">
                    Order #{order.externalOrderId}
                  </CardTitle>
                  <Badge variant="secondary">
                    {order.status}
                  </Badge>
                </div>
                <CardDescription>
                  {order.customerName}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span>Items:</span>
                    <span className="font-medium">{order.itemCount}</span>
                  </div>
                  {order.unmappedItemCount > 0 && (
                    <div className="flex items-center gap-2 text-sm text-orange-600 dark:text-orange-400">
                      <AlertCircle className="h-4 w-4" />
                      <span>{order.unmappedItemCount} unmapped items</span>
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    Created {new Date(order.orderDate).toLocaleDateString()}
                  </div>
                </div>
              </CardContent>
              <CardFooter>
                <Button
                  onClick={() => handleStartPacking(order.id)}
                  className="w-full"
                  disabled={order.packedAt !== null}
                >
                  {order.packedAt ? (
                    <>Packed</>
                  ) : (
                    <>
                      <Package className="h-4 w-4 mr-2" />
                      Start Packing
                    </>
                  )}
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      {/* Packing Sheet */}
      {selectedOrder && selectedLocationId && (
        <PackingSheet
          orderId={selectedOrder.id}
          orderNumber={selectedOrder.externalOrderId}
          items={convertToOrderItems(selectedOrder.items)}
          isOpen={isPackingOpen}
          onClose={() => setIsPackingOpen(false)}
          onComplete={handlePackingComplete}
          onSuccess={handlePackingSuccess}
          locationId={selectedLocationId}
        />
      )}
    </div>
  );
}