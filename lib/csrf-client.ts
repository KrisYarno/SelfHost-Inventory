/**
 * Client-side CSRF utilities
 * This file contains only browser-safe code
 */

const CSRF_HEADER = 'x-csrf-token';

/**
 * Client-side helper to get CSRF token from meta tag
 */
export function getClientCSRFToken(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  
  const metaTag = document.querySelector('meta[name="csrf-token"]');
  return metaTag?.getAttribute('content') || null;
}

/**
 * Add CSRF token to fetch headers
 */
export function addCSRFHeader(headers: HeadersInit = {}): HeadersInit {
  const token = getClientCSRFToken();
  
  if (!token) {
    console.warn('CSRF token not found');
    return headers;
  }
  
  return {
    ...headers,
    [CSRF_HEADER]: token
  };
}

/**
 * Helper function to add CSRF token to fetch headers
 */
export function withCSRFHeaders(headers: HeadersInit = {}, token: string | null): HeadersInit {
  if (!token) {
    console.warn('CSRF token not provided');
    return headers;
  }

  return {
    ...headers,
    [CSRF_HEADER]: token,
  };
}