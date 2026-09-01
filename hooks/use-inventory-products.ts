"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProductWithQuantity } from "@/types/product";

interface UseInventoryProductsOptions {
  locationId: number | null;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

export function useInventoryProducts(options: UseInventoryProductsOptions) {
  const { locationId, sortBy = "name", sortOrder = "asc" } = options;

  const queryClient = useQueryClient();

  const query = useQuery<ProductWithQuantity[]>({
    queryKey: ["inventory-products", locationId, sortBy, sortOrder],
    queryFn: async () => {
      if (!locationId) return [];

      const params = new URLSearchParams({
        pageSize: "500",
        sortBy,
        sortOrder,
      });

      const [productsRes, inventoryRes] = await Promise.all([
        fetch(`/api/products?${params}`),
        fetch(`/api/inventory/current-fast?locationId=${locationId}`),
      ]);

      if (!productsRes.ok) throw new Error("Failed to fetch products");
      if (!inventoryRes.ok) throw new Error("Failed to fetch inventory");

      const [productsData, inventoryData] = await Promise.all([
        productsRes.json(),
        inventoryRes.json(),
      ]);

      const inventoryMap = new Map<number, { quantity: number; version: number }>(
        inventoryData.inventory.map((item: { productId: number; quantity: number; version?: number }) => [
          item.productId,
          { quantity: item.quantity, version: item.version || 0 },
        ])
      );

      return productsData.products.map((product: { id: number; [key: string]: unknown }) => {
        const inv = inventoryMap.get(product.id);
        return {
          ...product,
          currentQuantity: inv?.quantity || 0,
          version: inv?.version || 0,
        };
      });
    },
    enabled: !!locationId,
    placeholderData: (prev) => prev,
  });

  /**
   * Imperatively refetch (e.g. after a mutation). Returns whether FRESH rows
   * actually arrived (fix-delta FDb-6): `invalidateQueries` resolves after the
   * active refetch settles — success or failure alike — and with
   * `placeholderData` keeping the previous array, a failed read leaves STALE
   * data that looks live. The journal's 409 version re-seed must not run on it.
   */
  const refetch = async (): Promise<boolean> => {
    // `invalidateQueries` PREFIX-matches; `getQueryState` wants THIS hook's
    // exact key — the prefix alone names no query and would answer undefined.
    const exactKey = ["inventory-products", locationId, sortBy, sortOrder];
    // FDc-2: `status === "success"` alone lies for a PAUSED query (offline:
    // react-query substitutes a resolved promise and never fetches, leaving the
    // PRIOR success in place) and for a disabled one. "Fresh rows arrived"
    // means the success COUNTER advanced — `dataUpdateCount` is monotonic and,
    // unlike `dataUpdatedAt` (FDd-5), immune to a backwards clock step and to
    // fake timers freezing Date.now().
    const before = queryClient.getQueryState(exactKey)?.dataUpdateCount ?? 0;
    await queryClient.invalidateQueries({
      queryKey: ["inventory-products", locationId],
    });
    const state = queryClient.getQueryState(exactKey);
    return state?.status === "success" && (state?.dataUpdateCount ?? 0) > before;
  };

  return { ...query, refetch };
}
