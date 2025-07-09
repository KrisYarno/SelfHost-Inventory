import { NextRequest, NextResponse } from 'next/server';
import { memoryStore } from './memory-store';
import { RateLimitConfig, getConfigForPath } from './config';
import { getToken } from 'next-auth/jwt';

export interface RateLimitOptions extends RateLimitConfig {
  keyGenerator?: (req: NextRequest) => Promise<string>;
  skip?: (req: NextRequest) => Promise<boolean>;
  onLimitReached?: (req: NextRequest, key: string) => Promise<void>;
}

export class RateLimiter {
  private config: RateLimitConfig;
  public keyGenerator: (req: NextRequest) => Promise<string>;
  private skip?: (req: NextRequest) => Promise<boolean>;
  private onLimitReached?: (req: NextRequest, key: string) => Promise<void>;

  constructor(options: RateLimitOptions) {
    this.config = {
      windowMs: options.windowMs,
      max: options.max,
      message: options.message || 'Too many requests, please try again later',
      skipSuccessfulRequests: options.skipSuccessfulRequests || false,
      skipFailedRequests: options.skipFailedRequests || false
    };
    
    this.keyGenerator = options.keyGenerator || this.defaultKeyGenerator;
    this.skip = options.skip;
    this.onLimitReached = options.onLimitReached;
  }

  private async defaultKeyGenerator(req: NextRequest): Promise<string> {
    // Try to get user ID from token first
    const token = await getToken({ 
      req,
      secret: process.env.NEXTAUTH_SECRET,
    });
    
    if (token?.sub) {
      return `user:${token.sub}`;
    }

    // Fall back to IP address
    const ip = this.getClientIp(req);
    return `ip:${ip}`;
  }

  public getClientIp(req: NextRequest): string {
    // Check various headers for the real IP
    const forwarded = req.headers.get('x-forwarded-for');
    const real = req.headers.get('x-real-ip');
    const cloudflare = req.headers.get('cf-connecting-ip');
    
    if (cloudflare) return cloudflare;
    if (forwarded) return forwarded.split(',')[0].trim();
    if (real) return real;
    
    // Default to a placeholder if no IP found
    return '127.0.0.1';
  }

  async limit(req: NextRequest): Promise<NextResponse | null> {
    // Check if we should skip this request
    if (this.skip && await this.skip(req)) {
      return null;
    }

    const key = await this.keyGenerator(req);
    const result = memoryStore.increment(key, this.config.windowMs);

    // Add rate limit headers
    const headers = new Headers();
    headers.set('X-RateLimit-Limit', this.config.max.toString());
    headers.set('X-RateLimit-Remaining', Math.max(0, this.config.max - result.count).toString());
    headers.set('X-RateLimit-Reset', new Date(result.resetTime).toISOString());

    if (result.count > this.config.max) {
      // Rate limit exceeded
      if (this.onLimitReached) {
        await this.onLimitReached(req, key);
      }

      headers.set('Retry-After', Math.ceil((result.resetTime - Date.now()) / 1000).toString());
      
      return NextResponse.json(
        { 
          error: this.config.message,
          retryAfter: Math.ceil((result.resetTime - Date.now()) / 1000)
        },
        { 
          status: 429,
          headers 
        }
      );
    }

    // Not rate limited, but we need to pass the headers along
    // This will be handled in the middleware
    return null;
  }

  getRateLimitHeaders(key: string): Record<string, string> {
    const entry = memoryStore.get(key);
    if (!entry) {
      return {
        'X-RateLimit-Limit': this.config.max.toString(),
        'X-RateLimit-Remaining': this.config.max.toString(),
        'X-RateLimit-Reset': new Date(Date.now() + this.config.windowMs).toISOString()
      };
    }

    return {
      'X-RateLimit-Limit': this.config.max.toString(),
      'X-RateLimit-Remaining': Math.max(0, this.config.max - entry.count).toString(),
      'X-RateLimit-Reset': new Date(entry.resetTime).toISOString()
    };
  }
}

// Factory function to create rate limiters for different endpoints
export function createRateLimiter(
  configOrPath: RateLimitConfig | string,
  additionalOptions?: Partial<RateLimitOptions>
): RateLimiter {
  const config = typeof configOrPath === 'string' 
    ? getConfigForPath(configOrPath)
    : configOrPath;

  return new RateLimiter({
    ...config,
    ...additionalOptions,
    // Skip rate limiting for GET requests on inventory read endpoints from authenticated users
    skip: async (req: NextRequest) => {
      if (additionalOptions?.skip) {
        const shouldSkip = await additionalOptions.skip(req);
        if (shouldSkip) return true;
      }
      
      // Only skip for GET requests on specific endpoints
      if (req.method !== 'GET') return false;
      
      const path = req.nextUrl.pathname;
      const isInventoryRead = path.includes('/api/inventory/current') || 
                            path.includes('/api/inventory/variants') ||
                            path.includes('/api/inventory/logs') ||
                            path.includes('/api/products');
                            
      if (!isInventoryRead) return false;
      
      // Check if user is authenticated
      const token = await getToken({ 
        req,
        secret: process.env.NEXTAUTH_SECRET,
      });
      
      return !!token; // Skip rate limiting for authenticated users on read endpoints
    }
  });
}

// IP-based rate limiter
export function ipRateLimiter(config: RateLimitConfig): RateLimiter {
  return new RateLimiter({
    ...config,
    keyGenerator: async (req) => {
      const limiter = new RateLimiter(config);
      const ip = limiter.getClientIp(req);
      return `ip:${ip}`;
    }
  });
}

// User-based rate limiter
export function userRateLimiter(config: RateLimitConfig): RateLimiter {
  return new RateLimiter({
    ...config,
    keyGenerator: async (req) => {
      const token = await getToken({ 
        req,
        secret: process.env.NEXTAUTH_SECRET,
      });
      
      if (!token?.sub) {
        // Fallback to IP if user not authenticated
        const limiter = new RateLimiter(config);
        const ip = limiter.getClientIp(req);
        return `ip:${ip}`;
      }
      
      return `user:${token.sub}`;
    }
  });
}

// Combined IP + User rate limiter (stricter)
export function combinedRateLimiter(config: RateLimitConfig): RateLimiter {
  return new RateLimiter({
    ...config,
    keyGenerator: async (req) => {
      const token = await getToken({ 
        req,
        secret: process.env.NEXTAUTH_SECRET,
      });
      
      const limiter = new RateLimiter(config);
      const ip = limiter.getClientIp(req);
      
      if (!token?.sub) {
        return `ip:${ip}`;
      }
      
      // Use both IP and user ID for stricter limiting
      return `combined:${ip}:${token.sub}`;
    }
  });
}