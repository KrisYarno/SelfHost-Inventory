"use client";

import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, X, Plus, Zap, Loader2, AlertCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CatalogRow, InternalProductIndexEntry } from "@/types/bulk-map";

export interface BundleBuilderComponent {
  internalProductId: number;
  internalProductName: string;
  quantity: number;
  sortOrder: number;
}

interface Props {
  row: CatalogRow;
  index: InternalProductIndexEntry[];
  initialComponents?: BundleBuilderComponent[];
  saving: boolean;
  errorMessage: string | null;
  onConfirm: (components: BundleBuilderComponent[]) => void;
  onCancel: () => void;
  onConvertToSingle: () => void;
}

export function BundleBuilder({
  row,
  initialComponents = [],
  saving,
  errorMessage,
  onConfirm,
  onCancel,
  onConvertToSingle,
}: Props) {
  const [components, setComponents] = useState<BundleBuilderComponent[]>(initialComponents);
  const [search, setSearch] = useState("");

  const addComponent = (product: { id: number; name: string }, qty = 1) => {
    setComponents((prev) => {
      if (prev.some((c) => c.internalProductId === product.id)) return prev;
      return [
        ...prev,
        {
          internalProductId: product.id,
          internalProductName: product.name,
          quantity: qty,
          sortOrder: prev.length,
        },
      ];
    });
    setSearch("");
  };

  const removeComponent = (productId: number) =>
    setComponents((prev) => prev.filter((c) => c.internalProductId !== productId));

  const setQuantity = (productId: number, qty: number) =>
    setComponents((prev) =>
      prev.map((c) =>
        c.internalProductId === productId
          ? { ...c, quantity: Math.max(1, qty) }
          : c,
      ),
    );

  const suggestFromWC = useCallback(async () => {
    if (!row.wcBundledItems || row.wcBundledItems.length === 0) return;

    const resp = await fetch("/api/admin/product-mappings?pageSize=500");
    const data = resp.ok ? await resp.json() : { mappings: [] };

    interface MapEntry {
      externalProductId: string;
      externalVariantId: string | null;
      internalProductId: number | null;
      internalProduct?: { name?: string };
    }

    const existingByTuple = new Map<string, MapEntry>();
    for (const m of (data.mappings as MapEntry[]) ?? []) {
      existingByTuple.set(`${m.externalProductId}::${m.externalVariantId ?? ""}`, m);
    }

    const newComponents: BundleBuilderComponent[] = [];
    for (let i = 0; i < row.wcBundledItems.length; i++) {
      const wcItem = row.wcBundledItems[i];
      const key = `${wcItem.productId}::${wcItem.variantId ?? ""}`;
      const existing = existingByTuple.get(key);
      if (existing && existing.internalProductId !== null) {
        newComponents.push({
          internalProductId: existing.internalProductId,
          internalProductName: existing.internalProduct?.name ?? `Product ${existing.internalProductId}`,
          quantity: wcItem.defaultQuantity,
          sortOrder: i,
        });
      }
    }

    if (newComponents.length > 0) {
      setComponents(newComponents);
    }
  }, [row.wcBundledItems]);

  const manualSearch = useQuery({
    queryKey: ["bundle-builder-search", search],
    queryFn: async (): Promise<Array<{ id: number; name: string }>> => {
      if (!search.trim()) return [];
      const res = await fetch(`/api/products?search=${encodeURIComponent(search)}&pageSize=20`);
      if (!res.ok) return [];
      const data = (await res.json()) as { products?: Array<{ id: number; name: string }> };
      return (data.products ?? []).map((p) => ({ id: p.id, name: p.name }));
    },
    enabled: search.trim().length > 0,
    staleTime: 30_000,
  });

  const canConfirm = components.length >= 1 && components.every((c) => c.quantity >= 1);
  const canSuggest = !!row.wcBundledItems && row.wcBundledItems.length > 0;

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs uppercase tracking-wider text-muted-foreground">{row.parentTitle}</p>
        <p className="text-sm font-semibold">{row.variantTitle ?? row.parentTitle}</p>
        {row.sku && <p className="text-xs text-muted-foreground">SKU: {row.sku}</p>}
      </div>

      <div className="rounded-md border border-purple-500/40 bg-purple-500/5 p-3 flex items-center justify-between">
        <Badge variant="outline" className="text-purple-700 dark:text-purple-300">
          THIS IS A BUNDLE
        </Badge>
        <Button variant="ghost" size="sm" onClick={onConvertToSingle} disabled={saving}>
          Convert to single
        </Button>
      </div>

      {errorMessage && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Components ({components.length})
          </p>
          {canSuggest ? (
            <Button size="sm" variant="outline" onClick={suggestFromWC} disabled={saving}>
              <Zap className="h-3 w-3 mr-1" />
              Suggest from WC
            </Button>
          ) : row.isBundleCandidate ? (
            <span className="text-[10px] text-muted-foreground">
              WC bundle metadata not exposed — build manually
            </span>
          ) : null}
        </div>

        {components.length === 0 && (
          <p className="py-3 text-center text-xs text-muted-foreground border border-dashed rounded-md">
            No components yet. Search below to add internal products.
          </p>
        )}

        {components.map((c) => (
          <div
            key={c.internalProductId}
            className="flex items-center gap-2 rounded-md border border-border/60 p-2"
          >
            <span className="flex-1 text-sm truncate">{c.internalProductName}</span>
            <Input
              type="number"
              min={1}
              value={c.quantity}
              onChange={(e) => setQuantity(c.internalProductId, parseInt(e.target.value, 10) || 1)}
              className="w-16 h-8 text-sm"
              disabled={saving}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => removeComponent(c.internalProductId)}
              disabled={saving}
              className="h-8 w-8 p-0"
              aria-label={`Remove ${c.internalProductName}`}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      <div className="space-y-1.5">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Add internal product
        </p>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search internal products…"
            className="pl-9"
            disabled={saving}
          />
          {manualSearch.isFetching && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="max-h-40 overflow-y-auto space-y-1">
          {(manualSearch.data ?? []).map((p) => {
            const already = components.some((c) => c.internalProductId === p.id);
            return (
              <button
                key={p.id}
                onClick={() => addComponent(p)}
                disabled={already || saving}
                className={cn(
                  "w-full text-left rounded-md border border-border/60 px-3 py-2 text-sm hover:bg-muted/50",
                  already && "opacity-50 cursor-not-allowed",
                )}
              >
                <Plus className="inline h-3 w-3 mr-1" />
                {p.name}
                {already && <span className="ml-2 text-xs text-muted-foreground">(already added)</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          className="flex-1"
          disabled={!canConfirm || saving}
          onClick={() => onConfirm(components)}
        >
          {saving ? (
            <><Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />Saving…</>
          ) : (
            "Confirm bundle mapping"
          )}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
