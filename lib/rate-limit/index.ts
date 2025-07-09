// Main export file for rate limiting utilities

export { memoryStore } from './memory-store';
export { rateLimitConfigs, getConfigForPath } from './config';
export { 
  RateLimiter, 
  createRateLimiter, 
  ipRateLimiter, 
  userRateLimiter,
  combinedRateLimiter,
  type RateLimitOptions 
} from './rate-limiter';

// Convenience function for API route handlers
import { NextRequest, NextResponse } from 'next/server';
import { createRateLimiter } from './rate-limiter';

export async function withRateLimit(
  req: NextRequest,
  handler: () => Promise<NextResponse>,
  configPath?: string
): Promise<NextResponse> {
  const limiter = createRateLimiter(configPath || req.nextUrl.pathname);
  const rateLimitResponse = await limiter.limit(req);
  
  if (rateLimitResponse) {
    return rateLimitResponse;
  }
  
  // Execute the handler and add rate limit headers to the response
  const response = await handler();
  const key = await limiter.keyGenerator(req);
  const headers = limiter.getRateLimitHeaders(key);
  
  Object.entries(headers).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  
  return response;
}