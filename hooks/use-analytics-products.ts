import { useQuery } from "@tanstack/react-query";
import { useDebounce } from "./use-debounce";
import type { HubResponse, HubSort, HubDir, HubFilter } from "@/lib/analytics/hub";

export interface AnalyticsProductFilters {
  search?: string;
  filter?: HubFilter; // all | in | low | out
  sort?: HubSort; // units | revenue | name | stock
  dir?: HubDir; // asc | desc
  page?: number;
  pageSize?: number;
  from?: string;
  to?: string;
  companyId?: string; // undefined = all my companies
}

// Mirrors hooks/use-products.ts: 300ms-debounced search, URLSearchParams build, and
// placeholderData: previousData so the list never flashes empty while refetching.
export function useAnalyticsProducts(filters: AnalyticsProductFilters) {
  const debouncedSearch = useDebounce(filters.search || "", 300);

  const queryKey = ["analytics-products", { ...filters, search: debouncedSearch }];

  return useQuery<HubResponse>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (filters.filter) params.set("filter", filters.filter);
      if (filters.sort) params.set("sort", filters.sort);
      if (filters.dir) params.set("dir", filters.dir);
      if (filters.page) params.set("page", String(filters.page));
      if (filters.pageSize) params.set("pageSize", String(filters.pageSize));
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      if (filters.companyId) params.set("companyId", filters.companyId);

      const res = await fetch(`/api/analytics/products?${params}`);
      if (!res.ok) throw new Error("Failed to fetch analytics products");
      return res.json();
    },
    placeholderData: (previousData) => previousData, // stale-while-revalidate, no flash
  });
}
