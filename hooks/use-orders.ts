"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import {
  invalidateInventoryCaches,
  type ApiMutationError,
} from "@/hooks/use-inventory-mutations";
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
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error?.message || "Failed to validate order");
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
        // Preserve the dialog's existing error surface: message + code + context.
        const err = new Error(
          data?.error?.message || data?.error || "Failed to fulfill order",
        ) as ApiMutationError;
        err.code = data?.error?.code;
        err.data = data?.error?.context;
        throw err;
      }
      return data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["external-orders"] });
      queryClient.invalidateQueries({ queryKey: ["external-order", variables.orderId] });
      invalidateInventoryCaches(queryClient);
    },
  });
}
