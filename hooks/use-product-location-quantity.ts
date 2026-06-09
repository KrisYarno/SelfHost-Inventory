"use client";

import { useQuery } from "@tanstack/react-query";

/**
 * Live per-location quantity for the inventory dialogs. Shared so all three
 * dialogs get caching, dedupe, and abort for free; mutations invalidate
 * ["product-location-quantity", productId] to refresh every open instance.
 */
export function useProductLocationQuantity(
  productId: number,
  locationId: number | null,
  opts?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ["product-location-quantity", productId, locationId],
    queryFn: async ({ signal }) => {
      const res = await fetch(
        `/api/inventory/product/${productId}?locationId=${locationId}&limit=1`,
        { signal },
      );
      if (!res.ok) throw new Error("Failed to fetch current quantity");
      const data = await res.json();
      return data.currentQuantity as number;
    },
    enabled: (opts?.enabled ?? true) && !!productId && locationId !== null,
    staleTime: 30_000,
  });
}
