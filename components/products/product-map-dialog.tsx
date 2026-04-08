"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import {
  Search,
  Loader2,
  AlertCircle,
  Package,
  Star,
  Circle,
  Link2,
  Zap,
  ChevronRight,
} from "lucide-react";
import type { ProductLink } from "@/types/product-links";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExternalProductInfo {
  externalId: string;
  externalVariantId?: string;
  title: string;
  variantTitle?: string;
  sku?: string;
  hasVariations?: boolean;
}

interface ProductMapDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  integrationId: string;
  externalProduct?: ExternalProductInfo;
  onMapped?: (productLink: ProductLink) => void;
}

interface InternalProduct {
  id: number;
  name: string;
  baseName?: string;
  variant?: string;
  currentQuantity: number;
  totalQuantity?: number;
}

interface ExternalVariation {
  id: number | string;
  sku?: string;
  price?: number;
  attributes?: Array<{ name: string; option: string }>;
}

type SuggestionType = "sku" | "name";

interface SuggestedProduct extends InternalProduct {
  matchType: SuggestionType;
}

// ---------------------------------------------------------------------------
// Debounce hook (300ms per Amendment 6)
// ---------------------------------------------------------------------------

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deduplicateProducts(products: InternalProduct[]): InternalProduct[] {
  const seen = new Set<number>();
  return products.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

function formatVariationLabel(variation: ExternalVariation): string {
  if (variation.attributes && variation.attributes.length > 0) {
    return variation.attributes.map((a) => a.option).join(" / ");
  }
  return variation.sku || `Variation #${variation.id}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProductMapDialog({
  open,
  onOpenChange,
  integrationId,
  externalProduct,
  onMapped,
}: ProductMapDialogProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const debouncedQuery = useDebounce(searchQuery, 300);
  const [mappingProductId, setMappingProductId] = useState<number | null>(null);
  const [mappingError, setMappingError] = useState<string | null>(null);
  const [selectedVariation, setSelectedVariation] =
    useState<ExternalVariation | null>(null);
  const [showVariationStep, setShowVariationStep] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { token: csrfToken, isLoading: csrfLoading } = useCSRF();

  // Determine if we need the variation selection step
  const needsVariationStep =
    externalProduct?.hasVariations && !externalProduct?.externalVariantId;

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setSearchQuery("");
      setMappingProductId(null);
      setMappingError(null);
      setSelectedVariation(null);
      setShowVariationStep(!!needsVariationStep);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open, needsVariationStep]);

  // Resolved external product info (after variation selection if needed)
  const resolvedExternal = useMemo(() => {
    if (!externalProduct) return null;
    if (selectedVariation) {
      return {
        externalId: externalProduct.externalId,
        externalVariantId: String(selectedVariation.id),
        title: externalProduct.title,
        variantTitle: formatVariationLabel(selectedVariation),
        sku: selectedVariation.sku || externalProduct.sku,
      };
    }
    return {
      externalId: externalProduct.externalId,
      externalVariantId: externalProduct.externalVariantId,
      title: externalProduct.title,
      variantTitle: externalProduct.variantTitle,
      sku: externalProduct.sku,
    };
  }, [externalProduct, selectedVariation]);

  // -----------------------------------------------------------------------
  // Fetch variations for variable products (lazy-load per Amendment 2)
  // -----------------------------------------------------------------------
  const {
    data: variationsData,
    isFetching: variationsLoading,
    error: variationsError,
  } = useQuery({
    queryKey: [
      "product-variations",
      integrationId,
      externalProduct?.externalId,
    ],
    queryFn: async () => {
      const res = await fetch(
        `/api/integrations/${integrationId}/search-products/${externalProduct!.externalId}/variations`
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to fetch variations");
      }
      return res.json() as Promise<{ variations: ExternalVariation[] }>;
    },
    enabled: open && showVariationStep && !!externalProduct?.externalId,
    staleTime: 60_000,
  });

  // -----------------------------------------------------------------------
  // Auto-suggest: search by SKU
  // -----------------------------------------------------------------------
  const skuSearch = resolvedExternal?.sku?.trim() || "";
  const { data: skuResults, isFetching: skuFetching } = useQuery({
    queryKey: ["product-map-sku-suggest", skuSearch],
    queryFn: async () => {
      if (!skuSearch) return { products: [] };
      const params = new URLSearchParams({
        search: skuSearch,
        pageSize: "5",
        page: "1",
      });
      const res = await fetch(`/api/products?${params}`);
      if (!res.ok) throw new Error("Search failed");
      return res.json() as Promise<{ products: InternalProduct[] }>;
    },
    enabled: open && !showVariationStep && skuSearch.length > 0,
    staleTime: 30_000,
  });

  // -----------------------------------------------------------------------
  // Auto-suggest: search by first word of title
  // -----------------------------------------------------------------------
  const titleFirstWord = useMemo(() => {
    if (!resolvedExternal?.title) return "";
    return resolvedExternal.title.split(/\s+/)[0] || "";
  }, [resolvedExternal?.title]);

  const { data: titleResults, isFetching: titleFetching } = useQuery({
    queryKey: ["product-map-title-suggest", titleFirstWord],
    queryFn: async () => {
      if (!titleFirstWord) return { products: [] };
      const params = new URLSearchParams({
        search: titleFirstWord,
        pageSize: "5",
        page: "1",
      });
      const res = await fetch(`/api/products?${params}`);
      if (!res.ok) throw new Error("Search failed");
      return res.json() as Promise<{ products: InternalProduct[] }>;
    },
    enabled:
      open &&
      !showVariationStep &&
      titleFirstWord.length > 0 &&
      titleFirstWord.toLowerCase() !== skuSearch.toLowerCase(),
    staleTime: 30_000,
  });

  // -----------------------------------------------------------------------
  // Merge and deduplicate suggestions
  // -----------------------------------------------------------------------
  const suggestions = useMemo<SuggestedProduct[]>(() => {
    if (showVariationStep) return [];
    const skuMatches: SuggestedProduct[] = (skuResults?.products || []).map(
      (p) => ({ ...p, matchType: "sku" as SuggestionType })
    );
    const nameMatches: SuggestedProduct[] = (titleResults?.products || []).map(
      (p) => ({ ...p, matchType: "name" as SuggestionType })
    );

    // Deduplicate: SKU matches take priority
    const seen = new Set<number>();
    const merged: SuggestedProduct[] = [];
    for (const item of skuMatches) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      }
    }
    for (const item of nameMatches) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      }
    }
    return merged;
  }, [skuResults, titleResults, showVariationStep]);

  const suggestionsLoading = skuFetching || titleFetching;

  // Check for single SKU match (Quick Map)
  const singleSkuMatch = useMemo(() => {
    const skuMatches = suggestions.filter((s) => s.matchType === "sku");
    return skuMatches.length === 1 ? skuMatches[0] : null;
  }, [suggestions]);

  // -----------------------------------------------------------------------
  // Manual search
  // -----------------------------------------------------------------------
  const { data: searchResults, isFetching: searchFetching } = useQuery({
    queryKey: ["product-map-search", debouncedQuery],
    queryFn: async () => {
      if (!debouncedQuery.trim()) return { products: [] };
      const params = new URLSearchParams({
        search: debouncedQuery,
        pageSize: "10",
        page: "1",
      });
      const res = await fetch(`/api/products?${params}`);
      if (!res.ok) throw new Error("Search failed");
      return res.json() as Promise<{ products: InternalProduct[] }>;
    },
    enabled: open && !showVariationStep && debouncedQuery.trim().length > 0,
    staleTime: 30_000,
  });

  const manualResults = useMemo(() => {
    return deduplicateProducts(searchResults?.products || []);
  }, [searchResults]);

  // -----------------------------------------------------------------------
  // Create mapping
  // -----------------------------------------------------------------------
  const handleMap = useCallback(
    async (internalProductId: number) => {
      if (!resolvedExternal || !csrfToken) return;

      setMappingProductId(internalProductId);
      setMappingError(null);

      try {
        const response = await fetch(
          `/api/products/${internalProductId}/links`,
          {
            method: "POST",
            headers: withCSRFHeaders(
              { "Content-Type": "application/json" },
              csrfToken
            ),
            body: JSON.stringify({
              integrationId,
              externalProductId: resolvedExternal.externalId,
              externalVariantId: resolvedExternal.externalVariantId,
              externalSku: resolvedExternal.sku,
              externalTitle: resolvedExternal.title,
            }),
          }
        );

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));

          if (response.status === 409) {
            setMappingError(
              "This external product is already mapped. Remove the existing mapping first."
            );
            return;
          }

          throw new Error(data.error || "Failed to create mapping");
        }

        const productLink = await response.json();
        toast.success("Product mapped successfully");
        onOpenChange(false);
        onMapped?.(productLink);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to create mapping";
        setMappingError(message);
        toast.error(message);
      } finally {
        setMappingProductId(null);
      }
    },
    [resolvedExternal, csrfToken, integrationId, onOpenChange, onMapped]
  );

  // -----------------------------------------------------------------------
  // Handle variation selection
  // -----------------------------------------------------------------------
  const handleSelectVariation = useCallback(
    (variation: ExternalVariation) => {
      setSelectedVariation(variation);
      setShowVariationStep(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    },
    []
  );

  // -----------------------------------------------------------------------
  // Render helpers
  // -----------------------------------------------------------------------

  const showManualEmpty =
    debouncedQuery.trim().length > 0 &&
    !searchFetching &&
    manualResults.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-5 w-5 text-primary" />
            Map External Product
          </DialogTitle>
          <DialogDescription>
            Link an external product to an internal inventory product
          </DialogDescription>
        </DialogHeader>

        {/* External product info */}
        {externalProduct && (
          <Card className="p-4 bg-muted/30 border-border/50">
            <div className="flex items-start gap-3">
              <Package className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-tight">
                  {resolvedExternal?.title || externalProduct.title}
                </p>
                {(resolvedExternal?.sku || externalProduct.sku) && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    SKU: {resolvedExternal?.sku || externalProduct.sku}
                  </p>
                )}
                {(resolvedExternal?.variantTitle ||
                  externalProduct.variantTitle) && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Variant:{" "}
                    {resolvedExternal?.variantTitle ||
                      externalProduct.variantTitle}
                  </p>
                )}
              </div>
            </div>
          </Card>
        )}

        {/* Variation selection step */}
        {showVariationStep && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <ChevronRight className="h-4 w-4 text-primary" />
              Select Variant
            </div>

            {variationsLoading && (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12 w-full rounded-lg" />
                ))}
              </div>
            )}

            {variationsError && (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>
                  {variationsError instanceof Error
                    ? variationsError.message
                    : "Failed to load variations"}
                </span>
              </div>
            )}

            {variationsData?.variations &&
              variationsData.variations.length === 0 && (
                <p className="text-sm text-muted-foreground py-2">
                  No variations found for this product.
                </p>
              )}

            {variationsData?.variations &&
              variationsData.variations.length > 0 && (
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {variationsData.variations.map((v) => (
                    <button
                      key={v.id}
                      onClick={() => handleSelectVariation(v)}
                      className="flex w-full items-center justify-between rounded-lg border border-border/60 bg-background px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/50 hover:border-primary/30"
                    >
                      <div className="min-w-0 flex-1">
                        <span className="font-medium">
                          {formatVariationLabel(v)}
                        </span>
                        {v.sku && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            SKU: {v.sku}
                          </span>
                        )}
                      </div>
                      {v.price != null && (
                        <span className="text-xs text-muted-foreground ml-2">
                          ${Number(v.price).toFixed(2)}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
          </div>
        )}

        {/* Mapping error */}
        {mappingError && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{mappingError}</span>
          </div>
        )}

        {/* Suggestions + search (hidden during variation step) */}
        {!showVariationStep && (
          <div className="space-y-4">
            {/* Suggested matches */}
            {externalProduct &&
              (suggestions.length > 0 || suggestionsLoading) && (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Suggested Matches
                  </p>

                  {suggestionsLoading && (
                    <div className="space-y-2">
                      {[1, 2].map((i) => (
                        <Skeleton
                          key={i}
                          className="h-12 w-full rounded-lg"
                        />
                      ))}
                    </div>
                  )}

                  {!suggestionsLoading && (
                    <div className="space-y-1.5">
                      {/* Quick Map for single SKU match */}
                      {singleSkuMatch && (
                        <div className="rounded-lg border-2 border-primary/40 bg-primary/5 p-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                              <Zap className="h-4 w-4 text-primary shrink-0" />
                              <div className="min-w-0">
                                <p className="text-sm font-medium truncate">
                                  {singleSkuMatch.name}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {singleSkuMatch.totalQuantity ??
                                    singleSkuMatch.currentQuantity}{" "}
                                  units
                                </p>
                              </div>
                            </div>
                            <Button
                              size="sm"
                              onClick={() => handleMap(singleSkuMatch.id)}
                              disabled={
                                mappingProductId !== null || csrfLoading
                              }
                            >
                              {mappingProductId === singleSkuMatch.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                "Quick Map"
                              )}
                            </Button>
                          </div>
                        </div>
                      )}

                      {/* Other suggestions */}
                      {suggestions
                        .filter(
                          (s) =>
                            !(singleSkuMatch && s.id === singleSkuMatch.id)
                        )
                        .map((product) => (
                          <ProductRow
                            key={product.id}
                            product={product}
                            badge={
                              product.matchType === "sku" ? (
                                <Badge
                                  variant="default"
                                  className="text-[10px] px-1.5 py-0"
                                >
                                  <Star className="h-2.5 w-2.5 mr-0.5" />
                                  SKU match
                                </Badge>
                              ) : (
                                <Badge
                                  variant="secondary"
                                  className="text-[10px] px-1.5 py-0"
                                >
                                  <Circle className="h-2.5 w-2.5 mr-0.5" />
                                  Name match
                                </Badge>
                              )
                            }
                            isMapping={mappingProductId === product.id}
                            disabled={mappingProductId !== null || csrfLoading}
                            onMap={() => handleMap(product.id)}
                          />
                        ))}
                    </div>
                  )}
                </div>
              )}

            {/* Manual search */}
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Search Internal Products
              </p>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  ref={inputRef}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search products..."
                  className="pl-9"
                />
                {searchFetching && (
                  <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>

              {/* Results */}
              <div className="max-h-48 overflow-y-auto">
                {searchFetching && manualResults.length === 0 && (
                  <div className="space-y-2 py-1">
                    {[1, 2, 3].map((i) => (
                      <Skeleton key={i} className="h-12 w-full rounded-lg" />
                    ))}
                  </div>
                )}

                {showManualEmpty && (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    No products found for &ldquo;{debouncedQuery}&rdquo;
                  </p>
                )}

                {manualResults.length > 0 && (
                  <div className="space-y-1.5">
                    {manualResults.map((product) => (
                      <ProductRow
                        key={product.id}
                        product={product}
                        isMapping={mappingProductId === product.id}
                        disabled={mappingProductId !== null || csrfLoading}
                        onMap={() => handleMap(product.id)}
                      />
                    ))}
                  </div>
                )}

                {!debouncedQuery.trim() && !searchFetching && (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    Type to search your inventory products
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Product row sub-component
// ---------------------------------------------------------------------------

function ProductRow({
  product,
  badge,
  isMapping,
  disabled,
  onMap,
}: {
  product: InternalProduct;
  badge?: React.ReactNode;
  isMapping: boolean;
  disabled: boolean;
  onMap: () => void;
}) {
  const quantity = product.totalQuantity ?? product.currentQuantity;

  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-background px-3 py-2 transition-colors hover:bg-muted/30">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-medium truncate">{product.name}</p>
            {badge}
          </div>
          <p className="text-xs text-muted-foreground">{quantity} units</p>
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onMap}
        disabled={disabled}
        className="shrink-0"
      >
        {isMapping ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          "Map This"
        )}
      </Button>
    </div>
  );
}
