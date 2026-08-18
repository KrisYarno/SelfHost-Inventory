"use client";

/**
 * React-query keys for the LABELING surface (contract pack C2c.4, OCp2-13).
 *
 * Their own module, deliberately: M4a's stock-in / discard-remaining mutations
 * invalidate the queue, and M5's queue hook reads it. If the keys lived in
 * either of those files the other would import a hook module for a constant —
 * and the pair that must agree on a cache key would sit in two places.
 *
 * `queue(undefined)` is the WHOLE queue and `queue(orderId)` is the deep-linked
 * one; the explicit `"all"` bucket keeps the two from colliding in the cache
 * (an `undefined` tail is not a stable key).
 */

export const labelingKeys = {
  all: ["labeling"] as const,
  queue: (orderId?: string) => ["labeling", "queue", orderId ?? "all"] as const,
};
