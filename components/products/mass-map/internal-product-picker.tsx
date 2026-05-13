"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, Loader2, AlertCircle, Star, Link2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CatalogRow, InternalProductIndexEntry, Suggestion } from "@/types/bulk-map";
import { suggest } from "@/lib/matching/suggestion-matcher";
import { PickerSuccessPanel } from "./picker-success-panel";

interface Props {
  row: CatalogRow | null;
  index: InternalProductIndexEntry[];
  indexLoading: boolean;
  saving: boolean;
  errorMessage: string | null;
  successFor: { row: CatalogRow; internalProductName: string } | null;
  onConfirm: (product: InternalProductIndexEntry) => void;
  onCancel: () => void;
  onFinishSuccess: () => void;
  onKeepSuccess: () => void;
}

function useManualSearch(query: string) {
  return useQuery({
    queryKey: ["bulk-map-manual-search", query],
    queryFn: async () => {
      if (!query.trim()) return [] as InternalProductIndexEntry[];
      const res = await fetch(`/api/products?search=${encodeURIComponent(query)}&pageSize=20`);
      if (!res.ok) throw new Error("search failed");
      const data = await res.json();
      return (data.products ?? []).map((p: {
        id: number;
        name: string;
        baseName?: string | null;
        variant?: string | null;
        numericValue?: number | string | null;
        unit?: string | null;
      }): InternalProductIndexEntry => ({
        id: p.id,
        name: p.name,
        baseName: p.baseName ?? null,
        variant: p.variant ?? null,
        numericValue: p.numericValue == null ? null : Number(p.numericValue),
        unit: p.unit ?? null,
        baseNameTokens: [],
        hasAnyMapping: false,
      }));
    },
    enabled: query.trim().length > 0,
    staleTime: 30_000,
  });
}

export function InternalProductPicker({
  row,
  index,
  indexLoading,
  saving,
  errorMessage,
  successFor,
  onConfirm,
  onCancel,
  onFinishSuccess,
  onKeepSuccess,
}: Props) {
  const [selected, setSelected] = useState<InternalProductIndexEntry | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    setSelected(null);
    setSearch("");
  }, [row?.externalProductId, row?.externalVariantId]);

  const suggestions: Suggestion[] = useMemo(() => {
    if (!row || index.length === 0) return [];
    return suggest(row, index);
  }, [row, index]);

  const manualSearch = useManualSearch(search);
  const manualResults = manualSearch.data ?? [];

  if (successFor) {
    return (
      <PickerSuccessPanel
        parentTitle={successFor.row.parentTitle}
        variantTitle={successFor.row.variantTitle}
        internalProductName={successFor.internalProductName}
        onFinish={onFinishSuccess}
        onKeep={onKeepSuccess}
      />
    );
  }

  if (!row) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Pick a row from the list to map it.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          {row.parentTitle}
        </p>
        <p className="text-sm font-semibold">
          {row.variantTitle ?? row.parentTitle}
        </p>
        {row.sku && <p className="text-xs text-muted-foreground">SKU: {row.sku}</p>}
      </div>

      {errorMessage && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      <div className="space-y-1.5">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Suggestions
        </p>
        {indexLoading && suggestions.length === 0 && (
          <p className="py-2 text-xs text-muted-foreground">Loading inventory…</p>
        )}
        {!indexLoading && suggestions.length === 0 && (
          <p className="py-2 text-xs text-muted-foreground">
            No automatic suggestions — try the search below.
          </p>
        )}
        {suggestions.map((s) => (
          <button
            key={s.product.id}
            onClick={() => setSelected(s.product)}
            className={cn(
              "w-full text-left flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 hover:bg-muted/50",
              selected?.id === s.product.id && "ring-1 ring-primary",
              s.greyed && "opacity-60",
            )}
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{s.product.name}</p>
              <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                  {s.reason === "title+size" ? (
                    <><Star className="h-2.5 w-2.5 mr-0.5" /> title + size</>
                  ) : s.reason}
                </Badge>
                {s.greyed && (
                  <span className="inline-flex items-center gap-1">
                    <Link2 className="h-2.5 w-2.5" />
                    Already mapped
                  </span>
                )}
              </p>
            </div>
          </button>
        ))}
      </div>

      <div className="space-y-1.5">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Or search all internal products
        </p>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className="pl-9"
          />
          {manualSearch.isFetching && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="max-h-48 overflow-y-auto space-y-1">
          {manualResults.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelected(p)}
              className={cn(
                "w-full text-left rounded-md border border-border/60 px-3 py-2 hover:bg-muted/50 text-sm",
                selected?.id === p.id && "ring-1 ring-primary",
              )}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          className="flex-1"
          disabled={!selected || saving}
          onClick={() => selected && onConfirm(selected)}
        >
          {saving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />
              Saving…
            </>
          ) : (
            "Confirm mapping"
          )}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
