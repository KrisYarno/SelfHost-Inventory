import { randomBytes } from 'crypto';
import { cookies } from 'next/headers';
import { NextRequest } from 'next/server';

const CSRF_TOKEN_COOKIE = 'csrf-token';
const CSRF_HEADER = 'x-csrf-token';
const TOKEN_LENGTH = 32;
const COOKIE_MAX_AGE = 60 * 60 * 24; // 24 hours

/**
 * Generate a cryptographically secure CSRF token
 */
export function generateCSRFToken(): string {
  return randomBytes(TOKEN_LENGTH).toString('hex');
}

/**
 * Get or create CSRF token for the current session
 * This should be called from server components or API routes
 */
export async function getCSRFToken(): Promise<string> {
  const cookieStore = await cookies();
  const existingToken = cookieStore.get(CSRF_TOKEN_COOKIE);
  
  if (existingToken?.value) {
    return existingToken.value;
  }
  
  // Generate new token
  const newToken = generateCSRFToken();
  
  // Set cookie with secure options
  cookieStore.set(CSRF_TOKEN_COOKIE, newToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: COOKIE_MAX_AGE,
    path: '/'
  });
  
  return newToken;
}

/**
 * Validate CSRF token from request
 * Returns true if token is valid, false otherwise
 */
export async function validateCSRFToken(request: NextRequest): Promise<boolean> {
  // Get token from cookie
  const cookieStore = await cookies();
  const cookieToken = cookieStore.get(CSRF_TOKEN_COOKIE)?.value;
  
  if (!cookieToken) {
    return false;
  }
  
  // Get token from header
  const headerToken = request.headers.get(CSRF_HEADER);
  
  if (!headerToken) {
    return false;
  }
  
  // Compare tokens using timing-safe comparison
  return timingSafeEqual(cookieToken, headerToken);
}

/**
 * Timing-safe string comparison to prevent timing attacks
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  
  return result === 0;
}

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