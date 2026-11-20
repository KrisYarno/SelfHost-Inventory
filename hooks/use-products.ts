import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ProductWithQuantity, ProductFilters } from '@/types/product';
import { useDebounce } from './use-debounce';
import { useCSRF, withCSRFHeaders } from './use-csrf';

/** Facelift F2-3: the server-side stock filter (`all` = no filter). */
type StockFilter = 'all' | 'in-stock' | 'low' | 'out';

interface ProductsResponse {
  products: ProductWithQuantity[];
  total: number;
  page: number;
  pageSize: number;
  /** Facelift F2-1: the location every `hereQuantity` describes (the request's `hereLocationId`), or null. */
  hereLocationId: number | null;
  /** Facelift F2 B5: the stock filter this answer describes (the request's `stock`, or `all`). */
  stock: StockFilter;
  /** Facelift FR1-10: the search this answer applied (the request's `search`, or `""`). */
  search: string;
}

/**
 * Facelift F2-3 (A18): the Products page's server-side filters. LOCAL to this
 * hook: the shared `ProductFilters` (lib/products.ts) is untouched. Each is sent
 * only when set (`stock` only when not `all`), so a caller passing neither sends
 * today's exact request. Both ride in the query key with the other filters.
 */
interface UseProductsFilters extends ProductFilters {
  stock?: StockFilter;
  hereLocationId?: number | null;
}

/**
 * Facelift F2 B1: `options.enabled` (default `true`) lets a caller wait (the
 * Products page waits for the locations read). It is NOT part of the query key.
 */
export function useProducts(filters: UseProductsFilters, options?: { enabled?: boolean }) {
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
      if (filters.stock && filters.stock !== 'all') params.set('stock', filters.stock);
      if (filters.hereLocationId != null) params.set('hereLocationId', filters.hereLocationId.toString());
      
      const response = await fetch(`/api/products/optimized?${params}`);
      if (!response.ok) throw new Error('Failed to fetch products');
      return response.json();
    },
    // Keep previous data while fetching new data
    placeholderData: (previousData) => previousData,
    enabled: options?.enabled ?? true,
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
  const { token: csrfToken } = useCSRF();
  
  return useMutation({
    mutationFn: async (data: any) => {
      const response = await fetch('/api/products', {
        method: 'POST',
        headers: withCSRFHeaders({ 'Content-Type': 'application/json' }, csrfToken),
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
  const { token: csrfToken } = useCSRF();
  
  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: any }) => {
      const response = await fetch(`/api/products/${id}`, {
        method: 'PUT',
        headers: withCSRFHeaders({ 'Content-Type': 'application/json' }, csrfToken),
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

export function useDeleteProduct(csrfTokenFromCaller?: string) {
  const queryClient = useQueryClient();
  const { token: csrfTokenHook, isLoading: csrfLoading, error: csrfError } = useCSRF();
  const csrfToken = csrfTokenFromCaller ?? csrfTokenHook;
  const isReady = !!csrfToken && (!csrfTokenFromCaller ? !csrfLoading : true);
  
  const mutation = useMutation({
    mutationFn: async (id: number) => {
      if (!csrfToken) {
        throw new Error('CSRF token not ready');
      }
      const response = await fetch(`/api/products/${id}`, {
        method: 'DELETE',
        headers: withCSRFHeaders({}, csrfToken),
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const err = new Error(errBody.error || 'Failed to delete product') as Error & { status?: number };
        err.status = response.status;
        throw err;
      }
      return response.json();
    },
    onSuccess: () => {
      // Invalidate all product queries
      queryClient.invalidateQueries({ queryKey: ['products'] });
    },
  });

  return { ...mutation, csrfLoading, csrfError, isReady };
}
