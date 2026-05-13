"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  buildIndex,
  type InternalProductInput,
} from "@/lib/matching/suggestion-matcher";
import type { InternalProductIndexEntry } from "@/types/bulk-map";

interface ProductsApiResponse {
  products: Array<{
    id: number;
    name: string;
    baseName?: string | null;
    variant?: string | null;
    numericValue?: number | string | null;
    unit?: string | null;
  }>;
  total?: number;
  page?: number;
  pageSize?: number;
}

const INDEX_PAGE_SIZE = 2000; // single-shot fetch; medium-scale cap

export function useInternalProductIndex() {
  const query = useQuery({
    queryKey: ["bulk-map-internal-products"],
    queryFn: async (): Promise<InternalProductInput[]> => {
      const res = await fetch(
        `/api/products?pageSize=${INDEX_PAGE_SIZE}&page=1&getTotal=true`,
      );
      if (!res.ok) throw new Error("internal products fetch failed");
      const data = (await res.json()) as ProductsApiResponse;

      const collected: InternalProductInput[] = data.products.map((p) => ({
        id: p.id,
        name: p.name,
        baseName: p.baseName ?? null,
        variant: p.variant ?? null,
        numericValue: p.numericValue == null ? null : Number(p.numericValue),
        unit: p.unit ?? null,
        hasAnyMapping: false,
      }));

      if (data.total != null && data.total > collected.length) {
        // eslint-disable-next-line no-console
        console.warn(
          `[bulk-map] internal product index truncated: ${collected.length}/${data.total}; bump INDEX_PAGE_SIZE`,
        );
      }

      return collected;
    },
    staleTime: 5 * 60_000,
  });

  const index: InternalProductIndexEntry[] = useMemo(() => {
    return query.data ? buildIndex(query.data) : [];
  }, [query.data]);

  return { ...query, index };
}
