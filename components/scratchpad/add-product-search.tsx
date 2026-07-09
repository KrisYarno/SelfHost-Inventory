"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Package } from "lucide-react";
import { SearchInput } from "@/components/ui/search-input";
import { cn } from "@/lib/utils";

export interface ScratchProduct {
  id: number;
  name: string;
  baseName?: string | null;
  variant?: string | null;
  approvalStatus?: string;
}

export default function AddProductSearch({
  onAdd,
  existingIds,
}: {
  onAdd: (product: ScratchProduct) => void;
  existingIds: Set<number>;
}) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce the search input (client state; the debounced term keys the query).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Search against the product catalog. placeholderData keeps the prior results
  // on screen while the next term loads (matches the old no-clear-first effect).
  const { data, isFetching } = useQuery({
    queryKey: ["product-search", debouncedSearch],
    queryFn: async ({ signal }) => {
      const res = await fetch(
        `/api/products?search=${encodeURIComponent(debouncedSearch)}&pageSize=20`,
        { signal },
      );
      if (!res.ok) throw new Error("search failed");
      return res.json();
    },
    enabled: debouncedSearch.length > 0,
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });

  const results: ScratchProduct[] =
    debouncedSearch.length > 0
      ? (data?.products ?? []).map(
          (p: {
            id: number;
            name: string;
            baseName?: string | null;
            variant?: string | null;
            approvalStatus?: string;
          }) => ({
            id: p.id,
            name: p.name,
            baseName: p.baseName,
            variant: p.variant,
            approvalStatus: p.approvalStatus,
          }),
        )
      : [];
  const searching = isFetching;

  const handleSelect = (product: ScratchProduct) => {
    if (existingIds.has(product.id)) return;
    onAdd(product);
    setSearch("");
    setDebouncedSearch("");
  };

  return (
    <div className="space-y-2">
      <div className="relative max-w-md">
        <SearchInput
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Add a product to the board…"
        />
        {searching && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      {debouncedSearch.length > 0 && (
        <div className="max-h-48 overflow-y-auto space-y-1 max-w-md">
          {results.map((p) => {
            const onBoard = existingIds.has(p.id);
            return (
              <button
                key={p.id}
                type="button"
                disabled={onBoard}
                onClick={() => handleSelect(p)}
                className={cn(
                  "flex w-full items-center gap-2 text-left rounded-md border border-border/60 px-3 py-2 text-sm hover:bg-muted/50",
                  onBoard && "opacity-50 cursor-not-allowed",
                )}
              >
                <Package className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{p.name}</span>
                {onBoard && (
                  <span className="text-xs text-muted-foreground">on board</span>
                )}
              </button>
            );
          })}
          {!searching && results.length === 0 && (
            <p className="py-2 text-xs text-muted-foreground">
              No products match &ldquo;{debouncedSearch}&rdquo;.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
