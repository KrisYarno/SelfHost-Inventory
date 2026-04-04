'use client';

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

interface UsePaginatedLogsOptions<F, TResponse> {
  endpoint: string;
  page: number;
  pageSize: number;
  filters: F;
  buildQuery: (page: number, pageSize: number, filters: F) => URLSearchParams;
  enabled?: boolean;
}

interface UsePaginatedLogsResult<TResponse> {
  data: TResponse | null;
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

async function fetchLogs<F, TResponse>(
  endpoint: string,
  page: number,
  pageSize: number,
  filters: F,
  buildQuery: (page: number, pageSize: number, filters: F) => URLSearchParams
): Promise<TResponse> {
  const params = buildQuery(page, pageSize, filters);
  const url = `${endpoint}?${params.toString()}`;

  const response = await fetch(url);
  if (!response.ok) {
    let message = 'Failed to fetch logs';
    try {
      const body = await response.json();
      if (body && typeof body.error === 'string') {
        message = body.error;
      }
    } catch {
      // Ignore JSON parse errors and fall back to default message
    }
    throw new Error(message);
  }

  return (await response.json()) as TResponse;
}

export function usePaginatedLogs<F, TResponse>(
  options: UsePaginatedLogsOptions<F, TResponse>
): UsePaginatedLogsResult<TResponse> {
  const { endpoint, page, pageSize, filters, buildQuery, enabled = true } = options;
  const queryClient = useQueryClient();

  const queryKey = ['paginated-logs', endpoint, page, pageSize, filters] as const;

  const { data, isLoading, isFetching, error } = useQuery<TResponse, Error>({
    queryKey,
    queryFn: () => fetchLogs<F, TResponse>(endpoint, page, pageSize, filters, buildQuery),
    enabled,
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['paginated-logs', endpoint] });
  }, [queryClient, endpoint]);

  return {
    data: data ?? null,
    isLoading,
    isRefreshing: isFetching && !isLoading,
    error: error?.message ?? null,
    refresh,
  };
}
