/**
 * rate-limit.test.ts — the sidecar's in-process limiter (spec D8): per-token 60/min,
 * global 300/min, get_operations weighted 5x, Retry-After on denial.
 */
import { describe, it, expect } from "@jest/globals";
import {
  RateLimiter,
  toolWeight,
  toolCallWeight,
  DEFAULT_PER_TOKEN_PER_MIN,
  DEFAULT_GLOBAL_PER_MIN,
} from "./rate-limit";

describe("toolWeight", () => {
  it("weights get_operations 5x and everything else 1x", () => {
    expect(toolWeight("get_operations")).toBe(5);
    expect(toolWeight("find_product")).toBe(1);
    expect(toolWeight("anything")).toBe(1);
  });

  it("registers the full weighted-tool table (spec D8 + §6): get_operations 5x; reorder_report/get_movement_series/get_inventory_summary/get_order_pipeline 3x; get_valuation/compare_periods/get_stock_asof 2x; everything else 1x by default", () => {
    expect(toolWeight("get_operations")).toBe(5);
    expect(toolWeight("reorder_report")).toBe(3);
    expect(toolWeight("get_movement_series")).toBe(3);
    expect(toolWeight("get_inventory_summary")).toBe(3);
    expect(toolWeight("get_order_pipeline")).toBe(3);
    expect(toolWeight("get_valuation")).toBe(2);
    expect(toolWeight("compare_periods")).toBe(2);
    expect(toolWeight("get_stock_asof")).toBe(2);
    expect(toolWeight("find_product")).toBe(1);
    expect(toolWeight("anything-else")).toBe(1);
  });
});

describe("toolCallWeight (JSON-RPC body inspection)", () => {
  it("counts a single tools/call by tool weight", () => {
    expect(
      toolCallWeight({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_product" } }),
    ).toBe(1);
    expect(
      toolCallWeight({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_operations" } }),
    ).toBe(5);
  });
  it("ignores non-tool-call messages (initialize / list / notifications)", () => {
    expect(toolCallWeight({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).toBe(0);
    expect(toolCallWeight({ jsonrpc: "2.0", id: 2, method: "tools/list" })).toBe(0);
    expect(toolCallWeight({ jsonrpc: "2.0", method: "notifications/initialized" })).toBe(0);
  });
  it("sums weights across a JSON-RPC batch", () => {
    expect(
      toolCallWeight([
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_product" } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_operations" } },
      ]),
    ).toBe(6);
  });
});

describe("RateLimiter — per-token window", () => {
  it("allows up to the per-token limit then denies with Retry-After", () => {
    const limiter = new RateLimiter({ perTokenPerMin: 3, globalPerMin: 1000, windowMs: 60_000 });
    const t0 = 1_000_000;
    expect(limiter.consume("A", 1, t0).allowed).toBe(true);
    expect(limiter.consume("A", 1, t0 + 10).allowed).toBe(true);
    expect(limiter.consume("A", 1, t0 + 20).allowed).toBe(true);
    const denied = limiter.consume("A", 1, t0 + 30);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("isolates buckets per token", () => {
    const limiter = new RateLimiter({ perTokenPerMin: 1, globalPerMin: 1000 });
    const t0 = 5_000_000;
    expect(limiter.consume("A", 1, t0).allowed).toBe(true);
    expect(limiter.consume("A", 1, t0).allowed).toBe(false);
    // a different token is unaffected
    expect(limiter.consume("B", 1, t0).allowed).toBe(true);
  });

  it("resets the window after windowMs elapses", () => {
    const limiter = new RateLimiter({ perTokenPerMin: 1, globalPerMin: 1000, windowMs: 60_000 });
    const t0 = 9_000_000;
    expect(limiter.consume("A", 1, t0).allowed).toBe(true);
    expect(limiter.consume("A", 1, t0 + 100).allowed).toBe(false);
    expect(limiter.consume("A", 1, t0 + 60_000).allowed).toBe(true);
  });
});

describe("RateLimiter — weighting and global window", () => {
  it("charges get_operations 5x against the per-token budget", () => {
    const limiter = new RateLimiter({ perTokenPerMin: 5, globalPerMin: 1000 });
    const t0 = 2_000_000;
    // one get_operations (weight 5) fills the per-token budget exactly
    expect(limiter.consume("A", 5, t0).allowed).toBe(true);
    expect(limiter.consume("A", 1, t0).allowed).toBe(false);
  });

  it("enforces the global ceiling across tokens without partial consumption", () => {
    const limiter = new RateLimiter({ perTokenPerMin: 1000, globalPerMin: 2 });
    const t0 = 3_000_000;
    expect(limiter.consume("A", 1, t0).allowed).toBe(true);
    expect(limiter.consume("B", 1, t0).allowed).toBe(true);
    const denied = limiter.consume("C", 1, t0);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("does not consume per-token budget when the global window blocks", () => {
    const limiter = new RateLimiter({ perTokenPerMin: 10, globalPerMin: 1 });
    const t0 = 4_000_000;
    expect(limiter.consume("A", 1, t0).allowed).toBe(true); // fills global
    expect(limiter.consume("A", 1, t0).allowed).toBe(false); // blocked by global
    // global rolls over; the per-token bucket still had budget (only 1 consumed)
    expect(limiter.consume("A", 1, t0 + 60_000).allowed).toBe(true);
  });
});

describe("RateLimiter — defaults match the spec", () => {
  it("uses 60/token and 300/global by default", () => {
    expect(DEFAULT_PER_TOKEN_PER_MIN).toBe(60);
    expect(DEFAULT_GLOBAL_PER_MIN).toBe(300);
    const limiter = new RateLimiter();
    const t0 = 7_000_000;
    for (let i = 0; i < 60; i++) expect(limiter.consume("A", 1, t0).allowed).toBe(true);
    expect(limiter.consume("A", 1, t0).allowed).toBe(false);
  });
});
