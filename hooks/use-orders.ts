"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Order, OrdersResponse, OrderLockRequest, OrderLockResponse } from "@/types/orders";
import { toast } from "sonner";

interface UseOrdersOptions {
  status?: 'all' | 'pending' | 'in_progress' | 'completed' | 'cancelled';
  limit?: number;
}

// Fetch orders with auto-refresh
export function useOrders({ status = 'all', limit = 10 }: UseOrdersOptions = {}) {
  return useQuery({
    queryKey: ['orders', { status, limit }],
    queryFn: async () => {
      const params = new URLSearchParams({
        status,
        limit: limit.toString(),
      });
      
      const response = await fetch(`/api/orders?${params}`);
      if (!response.ok) {
        throw new Error('Failed to fetch orders');
      }
      
      return response.json() as Promise<OrdersResponse>;
    },
    refetchInterval: 30 * 1000, // Auto-refresh every 30 seconds
    staleTime: 10 * 1000, // Consider data fresh for 10 seconds
  });
}

// Lock an order for packing
export function useLockOrder() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ orderId, userId }: OrderLockRequest) => {
      const response = await fetch(`/api/orders/${orderId}/lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      
      if (!response.ok) {
        throw new Error('Failed to lock order');
      }
      
      return response.json() as Promise<OrderLockResponse>;
    },
    onSuccess: (data, variables) => {
      // Optimistically update the order in the cache
      queryClient.setQueryData(
        ['orders'],
        (oldData: OrdersResponse | undefined) => {
          if (!oldData) return oldData;
          
          return {
            ...oldData,
            orders: oldData.orders.map(order =>
              order.id === variables.orderId
                ? { ...order, lockedBy: data.lockedBy, status: 'in_progress' as const }
                : order
            ),
          };
        }
      );
      
      // Invalidate and refetch
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      toast.success('Order locked for packing');
    },
    onError: (error) => {
      toast.error('Failed to lock order. It may be locked by another user.');
    },
  });
}

// Unlock an order
export function useUnlockOrder() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (orderId: string) => {
      const response = await fetch(`/api/orders/${orderId}/unlock`, {
        method: 'POST',
      });
      
      if (!response.ok) {
        throw new Error('Failed to unlock order');
      }
      
      return response.json();
    },
    onSuccess: (_, orderId) => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      toast.success('Order unlocked');
    },
    onError: () => {
      toast.error('Failed to unlock order');
    },
  });
}

// Complete an order
export function useCompleteOrder() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (orderId: string) => {
      const response = await fetch(`/api/orders/${orderId}/complete`, {
        method: 'POST',
      });
      
      if (!response.ok) {
        throw new Error('Failed to complete order');
      }
      
      return response.json();
    },
    onSuccess: (_, orderId) => {
      // Update cache optimistically
      queryClient.setQueryData(
        ['orders'],
        (oldData: OrdersResponse | undefined) => {
          if (!oldData) return oldData;
          
          return {
            ...oldData,
            orders: oldData.orders.map(order =>
              order.id === orderId
                ? { ...order, status: 'completed' as const, lockedBy: undefined }
                : order
            ),
          };
        }
      );
      
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      toast.success('Order completed successfully');
    },
    onError: () => {
      toast.error('Failed to complete order');
    },
  });
}

// Get order details
export function useOrderDetails(orderId: string | null) {
  return useQuery({
    queryKey: ['order', orderId],
    queryFn: async () => {
      if (!orderId) throw new Error('No order ID provided');
      
      const response = await fetch(`/api/orders/${orderId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch order details');
      }
      
      return response.json() as Promise<Order>;
    },
    enabled: !!orderId,
  });
}