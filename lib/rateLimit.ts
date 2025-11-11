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
  identifier?: string;
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

const getIdentifier = (req: NextRequest, explicitIdentifier?: string): string => {
  if (explicitIdentifier) {
    return explicitIdentifier;
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

export function enforceRateLimit(
  req: NextRequest,
  scope: string,
  options: EnforceRateLimitOptions = {}
): RateLimitHeaders {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const ttl = options.ttl ?? DEFAULT_TTL;
  const identifier = getIdentifier(req, options.identifier);
  const key = `${scope}:${identifier}`;
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
