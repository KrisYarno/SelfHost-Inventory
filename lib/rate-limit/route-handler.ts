import { NextRequest, NextResponse } from 'next/server';
import { createRateLimiter, ipRateLimiter, userRateLimiter, combinedRateLimiter } from './rate-limiter';
import { RateLimitConfig } from './config';

type RouteHandler = (req: NextRequest) => Promise<NextResponse> | NextResponse;

interface RateLimitMiddlewareOptions {
  type?: 'ip' | 'user' | 'combined';
  config?: RateLimitConfig;
  configPath?: string;
}

/**
 * Higher-order function to wrap route handlers with rate limiting
 */
export function withRateLimitHandler(
  handler: RouteHandler,
  options: RateLimitMiddlewareOptions = {}
): RouteHandler {
  return async (req: NextRequest) => {
    const { type = 'combined', config, configPath } = options;
    
    let limiter;
    
    if (config) {
      switch (type) {
        case 'ip':
          limiter = ipRateLimiter(config);
          break;
        case 'user':
          limiter = userRateLimiter(config);
          break;
        case 'combined':
        default:
          limiter = combinedRateLimiter(config);
          break;
      }
    } else {
      // Use config based on path
      limiter = createRateLimiter(configPath || req.nextUrl.pathname);
    }
    
    const rateLimitResponse = await limiter.limit(req);
    
    if (rateLimitResponse) {
      return rateLimitResponse;
    }
    
    // Execute the handler
    const response = await handler(req);
    
    // Add rate limit headers to the response
    const key = await limiter.keyGenerator(req);
    const headers = limiter.getRateLimitHeaders(key);
    
    Object.entries(headers).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
    
    return response;
  };
}

/**
 * Decorator-style rate limiter for cleaner syntax
 */
export const rateLimit = (options: RateLimitMiddlewareOptions = {}) => {
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value;
    
    descriptor.value = withRateLimitHandler(originalMethod, options);
    
    return descriptor;
  };
};