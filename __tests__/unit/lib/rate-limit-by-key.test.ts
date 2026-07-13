// @jest-environment node
/**
 * Lane 5 S3 trunk contract: enforceRateLimitByKey (plan Task 4).
 *
 * Headers-agnostic entry point over the SAME in-process store/semantics as
 * enforceRateLimit, throwing the existing RateLimitError (status 429) — used by
 * NextAuth's authorize (which only receives a partial req) to throttle per-IP.
 */

import { enforceRateLimitByKey, RateLimitError } from "@/lib/rateLimit";

describe("enforceRateLimitByKey", () => {
  test("N calls under the limit pass; the (N+1)th throws RateLimitError (429)", () => {
    const key = `test-basic:${Math.random()}`;
    const opts = { limit: 3, ttl: 60_000 };
    for (let i = 0; i < 3; i++) {
      expect(() => enforceRateLimitByKey(key, opts)).not.toThrow();
    }
    try {
      enforceRateLimitByKey(key, opts);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitError);
      expect((e as RateLimitError).status).toBe(429);
    }
  });

  test("returns rate-limit headers while under the limit", () => {
    const key = `test-headers:${Math.random()}`;
    const headers = enforceRateLimitByKey(key, { limit: 5, ttl: 60_000 });
    expect(headers["X-RateLimit-Limit"]).toBe("5");
    expect(headers["X-RateLimit-Remaining"]).toBe("4");
    expect(typeof headers["X-RateLimit-Reset"]).toBe("string");
  });

  test("separate keys are counted independently", () => {
    const a = `test-a:${Math.random()}`;
    const b = `test-b:${Math.random()}`;
    const opts = { limit: 1, ttl: 60_000 };
    expect(() => enforceRateLimitByKey(a, opts)).not.toThrow();
    // b is a fresh key — its first call must not be affected by a's exhaustion.
    expect(() => enforceRateLimitByKey(b, opts)).not.toThrow();
    // a is now exhausted.
    expect(() => enforceRateLimitByKey(a, opts)).toThrow(RateLimitError);
  });

  test("window expiry (ttl) resets the counter", () => {
    jest.useFakeTimers();
    try {
      const key = `test-ttl:${Math.random()}`;
      const opts = { limit: 1, ttl: 1_000 };
      expect(() => enforceRateLimitByKey(key, opts)).not.toThrow();
      expect(() => enforceRateLimitByKey(key, opts)).toThrow(RateLimitError);
      // advance past the ttl -> window resets -> next call is allowed again.
      jest.advanceTimersByTime(1_001);
      expect(() => enforceRateLimitByKey(key, opts)).not.toThrow();
    } finally {
      jest.useRealTimers();
    }
  });

  test("uses default limit/ttl when options omitted", () => {
    const key = `test-defaults:${Math.random()}`;
    const headers = enforceRateLimitByKey(key);
    expect(headers["X-RateLimit-Limit"]).toBe("30");
  });
});
