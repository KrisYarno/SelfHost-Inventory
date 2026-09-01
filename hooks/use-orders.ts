"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import {
  invalidateInventoryCaches,
  type ApiMutationError,
} from "@/hooks/use-inventory-mutations";
import { apiErrorMessage, readApiError } from "@/lib/api-error";
import type { FulfillmentValidationResult } from "@/lib/fulfillment";

/**
 * Server-state hooks for the orders/fulfillment domain.
 *
 * Keys compose with the house scheme so cross-page coherence holds:
 *  - reads/writes of an order live under ["external-orders"] / ["external-order", id]
 *    (see use-external-orders.ts);
 *  - anything that MOVES inventory (fulfill) additionally runs
 *    invalidateInventoryCaches() so /inventory, dashboard, and journal stay honest
 *    (the same contract complete-order-dialog uses after a workbench deduct).
 */

/**
 * Pre-fulfillment stock/mapping validation for an order at a given location.
 * Read-only; auto-runs once both an order and a location are known.
 */
export function useFulfillmentValidation(
  orderId: string | null,
  locationId: number | null,
  opts?: { enabled?: boolean },
) {
  return useQuery<FulfillmentValidationResult>({
    queryKey: ["fulfillment-validation", orderId, locationId],
    queryFn: async ({ signal }) => {
      const res = await fetch(
        `/api/orders/${orderId}/fulfill/validate?locationId=${locationId}`,
        { signal },
      );
      if (!res.ok) {
        // Both body shapes (pack REV-22 F7): the validate route answers through
        // `apiHandler`, so its sentence is FLAT — the old `error?.message` read
        // it as undefined and showed the generic fallback instead.
        const errorData = await res.json().catch(() => ({}));
        throw new Error(apiErrorMessage(errorData, "Failed to validate order"));
      }
      return res.json();
    },
    enabled: (opts?.enabled ?? true) && !!orderId && locationId !== null,
    // Re-validate every time the dialog opens / the location changes — stock the
    // validation reflects can move between opens (matches the prior effect).
    staleTime: 0,
  });
}

export interface FulfillOrderInput {
  orderId: string;
  locationId: number;
  items: Array<{ itemId: string; quantity: number; skipUnmapped?: boolean }>;
}

/**
 * Fulfill an order — deducts inventory server-side, so on success we invalidate
 * BOTH the orders caches (list + this order) and the full inventory cache set.
 */
export function useFulfillOrder() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();

  return useMutation({
    mutationFn: async ({ orderId, locationId, items }: FulfillOrderInput) => {
      const res = await fetch(`/api/orders/${orderId}/fulfill`, {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({ locationId, items }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Preserve the dialog's existing error surface: message + code + context
        // — now read through the shared both-shapes reader (pack REV-22 F7), so
        // the codes B1 puts on the wire (`ORDER_GONE`, `TOO_MANY_KEYS`,
        // `INSUFFICIENT_STOCK`) survive the flat envelope instead of being
        // flattened to a generic sentence with no code.
        const read = readApiError(data);
        const err = new Error(
          apiErrorMessage(data, "Failed to fulfill order"),
        ) as ApiMutationError;
        err.code = read.code ?? undefined;
        err.data =
          typeof read.context === "object" && read.context !== null
            ? (read.context as Record<string, unknown>)
            : undefined;
        throw err;
      }
      return data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["external-orders"] });
      queryClient.invalidateQueries({ queryKey: ["external-order", variables.orderId] });
      // QA-1: the pre-fulfil VALIDATION moved too. A partial fulfil changes the
      // remaining quantities and the stock this query answers from, so a cached
      // answer describes the order as it was before the deduction. Scoped by
      // orderId — the key's third segment is the location, and every location's
      // answer for this order is now stale.
      queryClient.invalidateQueries({
        queryKey: ["fulfillment-validation", variables.orderId],
        // FQ-1: mark stale, never refetch — on the three closing tiers the
        // dialog is being dismissed and an active refetch that failed would
        // toast "Failed to validate order" over the success toast. staleTime 0
        // refreshes on the next open; the zero tier refetches explicitly.
        refetchType: "none",
      });
      invalidateInventoryCaches(queryClient);
    },
  });
}
