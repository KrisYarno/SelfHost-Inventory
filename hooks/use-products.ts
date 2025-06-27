import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ProductWithQuantity, ProductFilters } from '@/types/product';
import { useDebounce } from './use-debounce';

interface ProductsResponse {
  products: ProductWithQuantity[];
  total: number;
  page: number;
  pageSize: number;
}

export function useProducts(filters: ProductFilters) {
  const debouncedSearch = useDebounce(filters.search || '', 300);
  
  const queryKey = ['products', {
    ...filters,
    search: debouncedSearch,
  }];

  return useQuery<ProductsResponse>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (filters.sortBy) params.set('sortBy', filters.sortBy);
      if (filters.sortOrder) params.set('sortOrder', filters.sortOrder);
      if (filters.page) params.set('page', filters.page.toString());
      if (filters.pageSize) params.set('pageSize', filters.pageSize.toString());
      
      const response = await fetch(`/api/products/optimized?${params}`);
      if (!response.ok) throw new Error('Failed to fetch products');
      return response.json();
    },
    // Keep previous data while fetching new data
    placeholderData: (previousData) => previousData,
  });
}

export function useProduct(productId: number) {
  return useQuery({
    queryKey: ['product', productId],
    queryFn: async () => {
      const response = await fetch(`/api/products/${productId}`);
      if (!response.ok) throw new Error('Failed to fetch product');
      return response.json();
    },
    enabled: !!productId,
  });
}

export function useCreateProduct() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (data: any) => {
      const response = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!response.ok) throw new Error('Failed to create product');
      return response.json();
    },
    onSuccess: () => {
      // Invalidate all product queries
      queryClient.invalidateQueries({ queryKey: ['products'] });
    },
  });
}

export function useUpdateProduct() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: any }) => {
      const response = await fetch(`/api/products/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!response.ok) throw new Error('Failed to update product');
      return response.json();
    },
    onSuccess: (data, variables) => {
      // Update specific product cache
      queryClient.setQueryData(['product', variables.id], data);
      // Invalidate product list
      queryClient.invalidateQueries({ queryKey: ['products'] });
    },
  });
}

export function useDeleteProduct() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (id: number) => {
      const response = await fetch(`/api/products/${id}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Failed to delete product');
      return response.json();
    },
    onSuccess: () => {
      // Invalidate all product queries
      queryClient.invalidateQueries({ queryKey: ['products'] });
    },
  });
}