"use client";

import { useQuery } from "@tanstack/react-query";
import { getJSON, type ApiError } from "@/hooks/get-json";

// ---------------------------------------------------------------------------
// THE ORDER SEARCH — one hook, one key, one `enabled` rule (reconciliation
// Part 2, pack § P2-B3-1, B3-1b; CB3b-ii.1b). MOVED UNCHANGED out of
// `hooks/use-admin.ts`, which re-exports all three names so the Attribute…
// picker compiles as it always did. The adjust dialog's `OrderLookup` imports
// it from HERE, so the inventory page never pulls the admin hook module.
// ---------------------------------------------------------------------------

export interface OrderSearchResult {
  id: string;
  orderNumber: string;
  platform: string;
  internalStatus: string;
  externalCreatedAt: string | null;
  itemCount: number;
}

export interface OrderSearchResponse {
  orders: OrderSearchResult[];
  /** What the twenty-row ceiling left off — said out loud by the picker. */
  moreCount: number;
  /**
   * A MEMBER's empty answer to a non-blank search carries the house sentence
   * (pack row 94): their companies hold no order with that number, which is
   * not the same fact as "no order anywhere" — or, when they belong to no
   * company at all, that reason instead (B3-1 FR1). An admin's answer never has it.
   */
  note?: string;
}

/**
 * The Attribute… picker's search. DISABLED on an empty query: an empty search
 * is not a request for every order (the route answers the same way). The 250ms
 * debounce lives in the component, which owns the keystrokes.
 *
 * B3-1 FR1: a 429 is NOT retried — a retry spends the same limiter bucket that
 * just refused it — and every other failure keeps the app's one retry. An
 * answer goes stale after 30 s rather than the app's 5 min: orders arrive while
 * someone packs. Inside those 30 s a revisited query is still served from the
 * cache, so typing back and forth does not double what the limiter counts.
 */
export function useOrderSearch(q: string) {
  return useQuery<OrderSearchResponse, ApiError>({
    queryKey: ["admin", "reconciliation", "orders", q],
    queryFn: ({ signal }) =>
      getJSON<OrderSearchResponse>(
        `/api/reconciliation/orders/search?q=${encodeURIComponent(q)}`,
        { signal },
      ),
    enabled: q.length >= 1,
    retry: (failureCount, error) => error?.status !== 429 && failureCount < 1,
    staleTime: 30_000,
  });
}
