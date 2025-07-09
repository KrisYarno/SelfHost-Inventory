/**
 * Utility for making fetch requests with rate limit handling and retry logic
 */

interface FetchOptions extends RequestInit {
  maxRetries?: number;
  retryDelay?: number;
}

export async function rateLimitedFetch(
  url: string, 
  options: FetchOptions = {}
): Promise<Response> {
  const { maxRetries = 3, retryDelay = 1000, ...fetchOptions } = options;
  
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        headers: {
          'Content-Type': 'application/json',
          ...fetchOptions.headers,
        },
      });
      
      // If rate limited, wait and retry
      if (response.status === 429) {
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfterMs = retryAfterHeader 
          ? parseInt(retryAfterHeader) * 1000 
          : Math.min(retryDelay * Math.pow(2, attempt), 10000); // Exponential backoff, max 10s
        
        console.warn(`Rate limited. Retrying after ${retryAfterMs}ms...`);
        
        // Only retry if we have attempts left
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryAfterMs));
          continue;
        }
      }
      
      return response;
    } catch (error) {
      lastError = error as Error;
      console.error(`Fetch attempt ${attempt + 1} failed:`, error);
      
      // Only retry on network errors, not on other types of errors
      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, attempt)));
        continue;
      }
    }
  }
  
  throw lastError || new Error('Failed to fetch after retries');
}

/**
 * Wrapper for rateLimitedFetch that handles common response processing
 */
export async function fetchWithErrorHandling<T = any>(
  url: string,
  options: FetchOptions = {}
): Promise<T> {
  const response = await rateLimitedFetch(url, options);
  
  if (!response.ok) {
    let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
    
    try {
      const errorData = await response.json();
      errorMessage = errorData.error || errorData.message || errorMessage;
      
      // Include details if available
      if (errorData.details) {
        errorMessage += ` - ${errorData.details}`;
      }
    } catch {
      // If JSON parsing fails, use the default error message
    }
    
    throw new Error(errorMessage);
  }
  
  return response.json();
}