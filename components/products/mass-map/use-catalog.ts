"use client";

import { useQuery } from "@tanstack/react-query";
import type { CatalogResponse } from "@/types/bulk-map";

export function useCatalog(integrationId: string) {
  return useQuery({
    queryKey: ["bulk-map-catalog", integrationId],
    queryFn: async (): Promise<CatalogResponse> => {
      const res = await fetch(`/api/integrations/${integrationId}/catalog`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to load catalog (${res.status})`);
      }
      return res.json();
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}
