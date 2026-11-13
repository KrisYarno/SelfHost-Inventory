"use client";

import { useQuery } from "@tanstack/react-query";
import { getJSON, type ApiError } from "@/hooks/get-json";

// ---------------------------------------------------------------------------
// THE ORDER SEARCH — one hook, one key, one `enabled` rule (reconciliation
// Part 2, pack § P2-B3-1, B3-1b; CB3b-ii.1b; re-cut in § P2-B3-1R, R-b.3).
// MOVED out of `hooks/use-admin.ts`, which re-exports all three names so the
// Attribute… picker compiles as it always did. The adjust dialog's
// `OrderNumberField` imports it from HERE, so the inventory page never pulls
// the admin hook module.
// ---------------------------------------------------------------------------

export interface OrderSearchResult {
  id: string;
  orderNumber: string;
  platform: string;
  internalStatus: string;
  externalCreatedAt: string | null;
  itemCount: number;
  /** The company the order belongs to — the store the operator recognises. */
  store: string;
  /**
   * Only when the search named a product: what the order's lines say about it.
   * `orderedUnits` counts the mapped lines (bundles expanded); `uncheckedLines`
   * counts the lines that cannot be checked (unmapped, or a bundle that will not
   * resolve) — so 0 ordered with unchecked lines is "can't tell", never "none".
   */
  thisProduct?: { orderedUnits: number; uncheckedLines: number };
}

export interface OrderSearchResponse {
  orders: OrderSearchResult[];
  /** What the row ceiling left off — said out loud by the surfaces. */
  moreCount: number;
  /**
   * How many orders carry EXACTLY this number (the route's G1 count), which can
   * exceed the rows on the page. The order number field's status line speaks
   * about this, never about the rows.
   */
  exactCount: number;
  /**
   * A MEMBER's empty answer to a non-blank search carries the house sentence
   * (pack row 94): their companies hold no order with that number, which is
   * not the same fact as "no order anywhere" — or, when they belong to no
   * company at all, that reason instead (B3-1 FR1). An admin's answer never has it.
   */
  note?: string;
}

/** The route's own default and ceiling (R-a.1); also the key's default slot. */
const DEFAULT_LIMIT = 20;

/**
 * The order search. DISABLED on an empty query: an empty search is not a
 * request for every order (the route answers the same way). The 250ms
 * debounce lives in the component, which owns the keystrokes.
 *
 * `productId` asks the route for each row's `thisProduct`; `limit` caps the
 * page (1..20). Both sit in the KEY, so a product-scoped five-row answer is
 * never served to the picker's twenty-row search, or the reverse. Absent, they
 * stay off the URL and the route's defaults apply — the same answer the key's
 * `null` / `20` slots name.
 *
 * NO `placeholderData` (R-b.1, a pin): a new key has no data until ITS answer
 * arrives, so a surface can never show the previous number's rows as if they
 * answered the current one.
 *
 * B3-1 FR1: a 429 is NOT retried — a retry spends the same limiter bucket that
 * just refused it — and every other failure keeps the app's one retry. An
 * answer goes stale after 30 s rather than the app's 5 min: orders arrive while
 * someone packs. Inside those 30 s a revisited query is still served from the
 * cache, so typing back and forth does not double what the limiter counts.
 */
export function useOrderSearch(q: string, opts?: { productId?: number; limit?: number }) {
  const productId = opts?.productId;
  const limit = opts?.limit;
  return useQuery<OrderSearchResponse, ApiError>({
    queryKey: ["admin", "reconciliation", "orders", q, productId ?? null, limit ?? DEFAULT_LIMIT],
    queryFn: ({ signal }) => {
      let url = `/api/reconciliation/orders/search?q=${encodeURIComponent(q)}`;
      if (productId !== undefined) url += `&productId=${encodeURIComponent(String(productId))}`;
      if (limit !== undefined) url += `&limit=${encodeURIComponent(String(limit))}`;
      return getJSON<OrderSearchResponse>(url, { signal });
    },
    enabled: q.length >= 1,
    retry: (failureCount, error) => error?.status !== 429 && failureCount < 1,
    staleTime: 30_000,
  });
}
