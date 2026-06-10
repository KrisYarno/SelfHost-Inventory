"use client";

import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";

export interface ApiMutationError extends Error {
  code?: string;
  data?: Record<string, unknown>;
}

/** Cross-page coherence contract: every inventory mutation invalidates these.
 *  Deliberately EXCLUDED: admin ['paginated-logs'] (forensic view; own refresh).
 *  productId optional: omit -> invalidate ALL product-location-quantity entries
 *  (for batch/multi-product mutations like journal submit and workbench deduct). */
export function invalidateInventoryCaches(queryClient: QueryClient, productId?: number) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["inventory-variants"] }),
    queryClient.invalidateQueries({
      queryKey:
        productId !== undefined
          ? ["product-location-quantity", productId]
          : ["product-location-quantity"],
    }),
    queryClient.invalidateQueries({ queryKey: ["inventory-products"] }),
    queryClient.invalidateQueries({ queryKey: ["inventory-logs"] }),
    queryClient.invalidateQueries({ queryKey: ["inventory-transfers"] }),
    queryClient.invalidateQueries({ queryKey: ["products"] }),
    queryClient.invalidateQueries({ queryKey: ["dashboard-metrics"] }),
    queryClient.invalidateQueries({ queryKey: ["dashboard-location-stock"] }),
  ]);
}

function useInvalidateInventory() {
  const queryClient = useQueryClient();
  return (productId: number) => invalidateInventoryCaches(queryClient, productId);
}

async function postJSON(url: string, body: unknown, csrfToken: string | null) {
  const res = await fetch(url, {
    method: "POST",
    headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`) as ApiMutationError;
    err.code = data?.code;
    err.data = data;
    throw err;
  }
  return data;
}

// Field names mirror the dialogs' live POST bodies (zod strips extras server-side):
// quick-adjust-dialog sends { productId, locationId, delta, reason, notes };
// the transfer auto-add path additionally sends { autoAddForTransfer: true }.
export interface AdjustInput {
  productId: number;
  locationId: number;
  delta: number;
  reason?: string;
  notes?: string;
  autoAddForTransfer?: boolean; // transfer auto-add audit flag (route reads it outside zod)
}
// stock-in-dialog sends { productId, locationId, quantity, orderNumber, notes }.
export interface StockInInput {
  productId: number;
  locationId: number;
  quantity: number;
  orderNumber?: string;
  notes?: string;
}
// transfer-dialog sends { productId, fromLocationId, toLocationId, quantity }.
export interface TransferInput {
  productId: number;
  fromLocationId: number;
  toLocationId: number;
  quantity: number;
}

export function useAdjustInventory() {
  const invalidate = useInvalidateInventory();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: (input: AdjustInput) => postJSON("/api/inventory/adjust", input, csrfToken),
    onSuccess: (_data, input) => invalidate(input.productId),
  });
}

export function useStockIn() {
  const invalidate = useInvalidateInventory();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: (input: StockInInput) => postJSON("/api/inventory/stock-in", input, csrfToken),
    onSuccess: (_data, input) => invalidate(input.productId),
  });
}

export function useTransferInventory() {
  const invalidate = useInvalidateInventory();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: (input: TransferInput) => postJSON("/api/inventory/transfer", input, csrfToken),
    onSuccess: (_data, input) => invalidate(input.productId),
  });
}
