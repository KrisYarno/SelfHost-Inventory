/**
 * mcp/src/rate-limit.ts — the sidecar's OWN in-process rate limiter (spec D8).
 *
 * Two fixed windows enforced together per tool-call:
 *   - per-token: 60 tool-calls / token / minute
 *   - global:    300 tool-calls / minute across all tokens
 * `get_operations` is the expensive tool and counts 5x (weighted). When either
 * window is exceeded the request is denied with a Retry-After (seconds until the
 * blocking window rolls over). Only `tools/call` JSON-RPC messages consume budget;
 * initialize / tools/list / notifications do not.
 *
 * In-process only (no shared store) — the sidecar is a single-replica internal
 * service; a horizontally-scaled deployment is out of scope for v1.
 *
 * MUST stay Next-free (pure; no imports).
 */

export const DEFAULT_PER_TOKEN_PER_MIN = 60;
export const DEFAULT_GLOBAL_PER_MIN = 300;
export const RATE_WINDOW_MS = 60_000;

/** Weighted tool cost against the budget. `get_operations` is 5x (spec D8). */
const TOOL_WEIGHTS: Record<string, number> = { get_operations: 5 };

export function toolWeight(toolName: string): number {
  return TOOL_WEIGHTS[toolName] ?? 1;
}

/**
 * Sum the budget weight of the tool-calls in a JSON-RPC request body (single or
 * batch). Non-tool-call messages contribute 0, so a request that never calls a
 * tool consumes no budget.
 */
export function toolCallWeight(body: unknown): number {
  const messages = Array.isArray(body) ? body : [body];
  let weight = 0;
  for (const message of messages) {
    if (
      message &&
      typeof message === "object" &&
      (message as { method?: unknown }).method === "tools/call"
    ) {
      const name = (message as { params?: { name?: unknown } }).params?.name;
      weight += typeof name === "string" ? toolWeight(name) : 1;
    }
  }
  return weight;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the blocking window rolls over (>= 1). 0 when allowed. */
  retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  perTokenPerMin?: number;
  globalPerMin?: number;
  windowMs?: number;
}

interface Bucket {
  windowStart: number;
  count: number;
}

export class RateLimiter {
  private readonly perTokenLimit: number;
  private readonly globalLimit: number;
  private readonly windowMs: number;
  private readonly tokenBuckets = new Map<string, Bucket>();
  private globalBucket: Bucket = { windowStart: 0, count: 0 };

  constructor(options: RateLimiterOptions = {}) {
    this.perTokenLimit = options.perTokenPerMin ?? DEFAULT_PER_TOKEN_PER_MIN;
    this.globalLimit = options.globalPerMin ?? DEFAULT_GLOBAL_PER_MIN;
    this.windowMs = options.windowMs ?? RATE_WINDOW_MS;
  }

  private rolled(bucket: Bucket, now: number): Bucket {
    if (now - bucket.windowStart >= this.windowMs) {
      bucket.windowStart = now;
      bucket.count = 0;
    }
    return bucket;
  }

  private retryAfter(bucket: Bucket, now: number): number {
    return Math.max(1, Math.ceil((bucket.windowStart + this.windowMs - now) / 1000));
  }

  /**
   * Consume `weight` units for `tokenId`. Checks per-token AND global windows
   * WITHOUT partial increments: if either would exceed, nothing is consumed and
   * the request is denied. `weight` is coerced to >= 1.
   */
  consume(tokenId: string, weight: number, now: number = Date.now()): RateLimitDecision {
    const cost = Math.max(1, Math.floor(weight));

    let tokenBucket = this.tokenBuckets.get(tokenId);
    if (!tokenBucket) {
      tokenBucket = { windowStart: now, count: 0 };
      this.tokenBuckets.set(tokenId, tokenBucket);
    }
    this.rolled(tokenBucket, now);
    this.rolled(this.globalBucket, now);

    if (tokenBucket.count + cost > this.perTokenLimit) {
      return { allowed: false, retryAfterSeconds: this.retryAfter(tokenBucket, now) };
    }
    if (this.globalBucket.count + cost > this.globalLimit) {
      return { allowed: false, retryAfterSeconds: this.retryAfter(this.globalBucket, now) };
    }

    tokenBucket.count += cost;
    this.globalBucket.count += cost;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
