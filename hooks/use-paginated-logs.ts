'use client';

import { useCallback, useEffect, useState } from 'react';

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

export function usePaginatedLogs<F, TResponse>(
  options: UsePaginatedLogsOptions<F, TResponse>
): UsePaginatedLogsResult<TResponse> {
  const { endpoint, page, pageSize, filters, buildQuery, enabled = true } = options;

  const [data, setData] = useState<TResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCore = useCallback(async () => {
    if (!enabled) {
      return;
    }

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

    const json = (await response.json()) as TResponse;
    setData(json);
  }, [enabled, endpoint, page, pageSize, filters, buildQuery]);

  const load = useCallback(async () => {
    if (!enabled) {
      return;
    }

    setError(null);
    setIsLoading(true);
    try {
      await fetchCore();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to fetch logs';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [enabled, fetchCore]);

  const refresh = useCallback(async () => {
    if (!enabled) {
      return;
    }

    setError(null);
    setIsRefreshing(true);
    try {
      await fetchCore();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to fetch logs';
      setError(message);
    } finally {
      setIsRefreshing(false);
    }
  }, [enabled, fetchCore]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, isLoading, isRefreshing, error, refresh };
}
