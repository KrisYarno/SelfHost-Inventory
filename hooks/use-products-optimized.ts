import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys, CACHE_TIMES, cacheInvalidators } from '@/lib/cache-config';
import type { Product, ProductFilters, ProductWithQuantity } from '@/types/product';
import { useCSRF, withCSRFHeaders } from './use-csrf';

// Fetch products with caching
export function useProducts(filters: ProductFilters, locationId?: number) {
  return useQuery({
    queryKey: queryKeys.products.list({ ...filters, locationId }),
    queryFn: async () => {
      const params = new URLSearchParams({
        ...(filters.search && { search: filters.search }),
        ...(filters.sortBy && { sortBy: filters.sortBy }),
        ...(filters.sortOrder && { sortOrder: filters.sortOrder }),
        page: filters.page?.toString() || '1',
        pageSize: filters.pageSize?.toString() || '25',
        ...(locationId && { locationId: locationId.toString() }),
        getTotal: (!locationId).toString(),
      });

      const response = await fetch(`/api/products?${params}`);
      if (!response.ok) throw new Error('Failed to fetch products');
      
      return response.json();
    },
    staleTime: CACHE_TIMES.PRODUCTS,
    gcTime: CACHE_TIMES.PRODUCTS * 2,
  });
}

// Search products with debounced caching
export function useProductSearch(query: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.products.search(query),
    queryFn: async () => {
      // Use the API endpoint for search
      if (query.length < 2) return [];
      
      const params = new URLSearchParams({
        search: query,
        pageSize: '10'
      });
      
      const response = await fetch(`/api/products?${params}`);
      if (!response.ok) throw new Error('Failed to search products');
      
      const data = await response.json();
      return data.products || [];
    },
    enabled: enabled && query.length >= 2,
    staleTime: CACHE_TIMES.PRODUCTS,
    gcTime: CACHE_TIMES.PRODUCTS * 2,
  });
}

// Get single product with caching
export function useProduct(id: number) {
  return useQuery({
    queryKey: queryKeys.products.detail(id),
    queryFn: async () => {
      const response = await fetch(`/api/products/${id}`);
      if (!response.ok) throw new Error('Failed to fetch product');
      
      return response.json();
    },
    staleTime: CACHE_TIMES.PRODUCTS,
    gcTime: CACHE_TIMES.PRODUCTS * 2,
  });
}

// Create product with cache invalidation
export function useCreateProduct() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  
  return useMutation({
    mutationFn: async (data: Partial<Product>) => {
      const response = await fetch('/api/products', {
        method: 'POST',
        headers: withCSRFHeaders({ 'Content-Type': 'application/json' }, csrfToken),
        body: JSON.stringify(data),
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to create product');
      }
      
      return response.json();
    },
    onSuccess: () => {
      // Invalidate all product queries
      cacheInvalidators.invalidateProducts(queryClient);
    },
  });
}

// Update product with optimistic updates
export function useUpdateProduct() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  
  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<Product> }) => {
      const response = await fetch(`/api/products/${id}`, {
        method: 'PATCH',
        headers: withCSRFHeaders({ 'Content-Type': 'application/json' }, csrfToken),
        body: JSON.stringify(data),
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update product');
      }
      
      return response.json();
    },
    onMutate: async ({ id, data }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: queryKeys.products.detail(id) });
      
      // Snapshot previous value
      const previousProduct = queryClient.getQueryData(queryKeys.products.detail(id));
      
      // Optimistically update
      queryClient.setQueryData(queryKeys.products.detail(id), (old: any) => ({
        ...old,
        ...data,
      }));
      
      return { previousProduct };
    },
    onError: (err, { id }, context) => {
      // Rollback on error
      if (context?.previousProduct) {
        queryClient.setQueryData(queryKeys.products.detail(id), context.previousProduct);
      }
    },
    onSettled: (data, error, { id }) => {
      // Invalidate specific product
      cacheInvalidators.invalidateProduct(queryClient, id);
    },
  });
}

// Delete product with cache cleanup
export function useDeleteProduct() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  
  return useMutation({
    mutationFn: async (id: number) => {
      const response = await fetch(`/api/products/${id}`, {
        method: 'DELETE',
        headers: withCSRFHeaders({}, csrfToken),
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete product');
      }
      
      return response.json();
    },
    onSuccess: (_, id) => {
      // Remove from cache
      queryClient.removeQueries({ queryKey: queryKeys.products.detail(id) });
      
      // Invalidate lists
      queryClient.invalidateQueries({ queryKey: queryKeys.products.all });
    },
  });
}

// Prefetch product for navigation
export function usePrefetchProduct() {
  const queryClient = useQueryClient();
  
  return (id: number) => {
    queryClient.prefetchQuery({
      queryKey: queryKeys.products.detail(id),
      queryFn: async () => {
        const response = await fetch(`/api/products/${id}`);
        if (!response.ok) throw new Error('Failed to fetch product');
        
        return response.json();
      },
      staleTime: CACHE_TIMES.PRODUCTS,
    });
  };
}