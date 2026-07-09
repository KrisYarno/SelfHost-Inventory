import { randomBytes } from 'crypto';
import { cookies } from 'next/headers';
import { NextRequest } from 'next/server';

const CSRF_TOKEN_COOKIE = 'csrf-token';
const CSRF_HEADER = 'x-csrf-token';
const TOKEN_LENGTH = 32;

/**
 * Generate a cryptographically secure CSRF token
 */
export function generateCSRFToken(): string {
  return randomBytes(TOKEN_LENGTH).toString('hex');
}

/**
 * Get existing CSRF token without creating a new one
 * Safe to use in Server Components
 */
export async function getExistingCSRFToken(): Promise<string | null> {
  const cookieStore = await cookies();
  const existingToken = cookieStore.get(CSRF_TOKEN_COOKIE);
  return existingToken?.value || null;
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
