import { useState, useEffect } from 'react';
import { getClientCSRFToken, withCSRFHeaders } from '@/lib/csrf-client';

interface UseCSRFReturn {
  token: string | null;
  isLoading: boolean;
  error: Error | null;
  refreshToken: () => Promise<void>;
}

export function useCSRF(): UseCSRFReturn {
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchToken = async () => {
    try {
      setIsLoading(true);
      setError(null);
      
      // First, try to get token from meta tag
      const metaToken = getClientCSRFToken();
      if (metaToken) {
        setToken(metaToken);
        setIsLoading(false);
        return;
      }
      
      // If no meta tag token, fall back to API call
      const response = await fetch('/api/csrf');
      if (!response.ok) {
        throw new Error('Failed to fetch CSRF token');
      }
      
      const data = await response.json();
      setToken(data.token);
    } catch (err) {
      setError(err as Error);
      console.error('Error fetching CSRF token:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchToken();
  }, []);

  return {
    token,
    isLoading,
    error,
    refreshToken: fetchToken,
  };
}

// Re-export for convenience
export { withCSRFHeaders };