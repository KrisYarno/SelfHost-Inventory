// SINGLE-INSTANCE ASSUMPTION (Lane 5 X1): this limiter is an in-process Map. Counts are
// per-instance and reset on process restart. It is correct only for a single-box deploy;
// a multi-instance / horizontally-scaled deploy needs a shared store (e.g. Redis) — see the
// deploy section of README.md. (Redis is intentionally out of scope: YAGNI for this stack.)
import { NextRequest, NextResponse } from 'next/server';

const DEFAULT_LIMIT = 30;
const DEFAULT_TTL = 60_000;
const MAX_STORE_SIZE = 5_000;

type RateLimitEntry = {
  count: number;
  expiresAt: number;
};

export type RateLimitHeaders = Record<string, string>;

const store = new Map<string, RateLimitEntry>();

export class RateLimitError extends Error {
  status: number;
  headers: RateLimitHeaders;

  constructor(limit: number, remaining: number, resetAt: number) {
    super('Too many requests');
    this.name = 'RateLimitError';
    this.status = 429;

    const retryAfterSeconds = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
    this.headers = {
      'Retry-After': String(retryAfterSeconds),
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': String(Math.max(0, remaining)),
      'X-RateLimit-Reset': new Date(resetAt).toISOString(),
    };
  }
}

type EnforceRateLimitOptions = {
  limit?: number;
  ttl?: number;
  identifier?: string | number;
};

const buildHeaders = (limit: number, count: number, expiresAt: number): RateLimitHeaders => ({
  'X-RateLimit-Limit': String(limit),
  'X-RateLimit-Remaining': String(Math.max(0, limit - count)),
  'X-RateLimit-Reset': new Date(expiresAt).toISOString(),
});

const cleanupStore = () => {
  if (store.size <= MAX_STORE_SIZE) {
    return;
  }

  const oldestKey = store.keys().next().value;
  if (oldestKey) {
    store.delete(oldestKey);
  }
};

const getIdentifier = (req: NextRequest, explicitIdentifier?: string | number): string => {
  if (explicitIdentifier !== undefined) {
    return String(explicitIdentifier);
  }

  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0]?.trim() || 'unknown';
  }

  const realIp = req.headers.get('x-real-ip');
  if (realIp) {
    return realIp;
  }

  const cfIp = req.headers.get('cf-connecting-ip');
  if (cfIp) {
    return cfIp;
  }

  return 'unknown';
};

// Shared store consumption: increments the counter for `key` within its ttl window and
// returns the rate-limit headers, or throws RateLimitError when the limit is exceeded.
// Both public entry points funnel through here so their semantics stay identical.
function consume(key: string, limit: number, ttl: number): RateLimitHeaders {
  const now = Date.now();

  const existing = store.get(key);

  if (!existing || existing.expiresAt <= now) {
    const entry: RateLimitEntry = {
      count: 1,
      expiresAt: now + ttl,
    };

    store.set(key, entry);
    cleanupStore();
    return buildHeaders(limit, entry.count, entry.expiresAt);
  }

  existing.count += 1;
  store.delete(key);
  store.set(key, existing);

  if (existing.count > limit) {
    throw new RateLimitError(limit, 0, existing.expiresAt);
  }

  return buildHeaders(limit, existing.count, existing.expiresAt);
}

export function enforceRateLimit(
  req: NextRequest,
  scope: string,
  options: EnforceRateLimitOptions = {}
): RateLimitHeaders {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const ttl = options.ttl ?? DEFAULT_TTL;
  const identifier = getIdentifier(req, options.identifier);
  const key = `${scope}:${identifier}`;
  return consume(key, limit, ttl);
}

// Headers-agnostic entry point (Lane 5 S3): callers that only have a derived key string
// (e.g. NextAuth's authorize, which receives a partial request) throttle with the SAME
// store and RateLimitError semantics as enforceRateLimit. Caller owns key namespacing.
export function enforceRateLimitByKey(
  key: string,
  options: { limit?: number; ttl?: number } = {}
): RateLimitHeaders {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const ttl = options.ttl ?? DEFAULT_TTL;
  return consume(key, limit, ttl);
}

export function getRateLimitStats(): Array<{
  key: string;
  count: number;
  expiresAt: number;
}> {
  const now = Date.now();
  const stats: Array<{ key: string; count: number; expiresAt: number }> = [];
  store.forEach((entry, key) => {
    if (entry.expiresAt > now) {
      stats.push({ key, count: entry.count, expiresAt: entry.expiresAt });
    }
  });
  return stats;
}

export function applyRateLimitHeaders(
  response: NextResponse,
  headers?: RateLimitHeaders
): NextResponse {
  if (!headers) {
    return response;
  }

  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }

  return response;
}
