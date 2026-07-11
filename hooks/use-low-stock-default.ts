"use client";

import { useQuery } from "@tanstack/react-query";
import { LOW_STOCK_DEFAULT_FALLBACK } from "@/lib/stock-threshold";

/**
 * The configurable system-wide default low-stock threshold, for client surfaces
 * that resolve a product's effective threshold with `effectiveLowStockThreshold`
 * (NULL/undefined product threshold → this default). Cached process-wide by
 * TanStack Query so every low-stock consumer (products list, journal, workbench,
 * card, tile, drill-down) shares ONE fetch; leaf components can call it directly.
 *
 * Returns `LOW_STOCK_DEFAULT_FALLBACK` (10) while loading or on error so the UI
 * never flashes an incorrect "off" state before the real default resolves.
 */
export function useLowStockDefault(): number {
  const { data } = useQuery<number>({
    queryKey: ["settings", "low-stock-default"],
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/settings/low-stock-default", { signal });
      if (!res.ok) throw new Error("Failed to load low-stock default");
      const body = (await res.json()) as { threshold: number };
      return body.threshold;
    },
    staleTime: 5 * 60_000,
  });
  return data ?? LOW_STOCK_DEFAULT_FALLBACK;
}
