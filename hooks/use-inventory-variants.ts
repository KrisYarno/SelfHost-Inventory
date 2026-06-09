"use client";

import { useInfiniteQuery, type InfiniteData } from "@tanstack/react-query";
import { useDebounce } from "@/hooks/use-debounce";

/** Row shape returned by /api/inventory/variants (the route's ProductWithLocations). */
export interface VariantProduct {
  id: number;
  name: string;
  baseName: string;
  variant: string | null;
  combinedMinimum: number;
  locations: { locationId: number; locationName: string; quantity: number; minQuantity: number }[];
  totalQuantity: number;
}

export interface VariantsPage {
  products: VariantProduct[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number; hasMore: boolean };
}

const PAGE_SIZE = 12;

async function extractError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return data?.error || data?.message || `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

// Module-scope select: a per-render closure would return fresh arrays every
// render and bust the page's useMemo on data.products.
const selectVariants = (data: InfiniteData<VariantsPage>) => ({
  products: data.pages.flatMap((p) => p.products),
  total: data.pages[data.pages.length - 1]?.pagination.total ?? 0,
  pagesLoaded: data.pages.length,
});

/**
 * Paginated inventory list for /inventory. Debounce lives inside the hook
 * (house idiom); the debounced term is part of the queryKey, so a search
 * change starts a fresh page sequence and aborts the superseded request.
 */
export function useInventoryVariants(search: string) {
  const debouncedSearch = useDebounce(search, 300);

  return useInfiniteQuery({
    queryKey: ["inventory-variants", { search: debouncedSearch }],
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams({ page: String(pageParam), pageSize: String(PAGE_SIZE) });
      if (debouncedSearch) params.set("search", debouncedSearch);
      const res = await fetch(`/api/inventory/variants?${params}`, { signal });
      if (!res.ok) throw new Error(await extractError(res));
      return (await res.json()) as VariantsPage;
    },
    initialPageParam: 1,
    getNextPageParam: (last) => (last.pagination.hasMore ? last.pagination.page + 1 : undefined),
    placeholderData: (prev) => prev,
    select: selectVariants,
  });
}

/** Pure grouping used by the page (alphabetical categories; variants sorted within). */
export function groupByBaseName(products: VariantProduct[]): Record<string, VariantProduct[]> {
  const groups: Record<string, VariantProduct[]> = {};
  for (const product of products) {
    const category = product.baseName || "Uncategorized";
    (groups[category] ??= []).push(product);
  }
  const sorted: Record<string, VariantProduct[]> = {};
  for (const key of Object.keys(groups).sort((a, b) => a.localeCompare(b))) {
    sorted[key] = groups[key].sort((a, b) =>
      a.variant && b.variant ? a.variant.localeCompare(b.variant) : 0,
    );
  }
  return sorted;
}
