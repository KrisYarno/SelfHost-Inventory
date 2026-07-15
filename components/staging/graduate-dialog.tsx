"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Loader2, AlertCircle, Package } from "lucide-react";
import { toast } from "sonner";
import { useCSRF } from "@/hooks/use-csrf";
import { useDebounce } from "@/hooks/use-debounce";
import { useGraduateStagingItem } from "@/hooks/use-staging";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ProductForm } from "@/components/products/product-form";

interface Location {
  id: number;
  name: string;
}

interface ProductSearchResult {
  id: number;
  name: string;
  approvalStatus?: string;
}

export interface GraduateStagingItem {
  id: number;
  description: string;
  expectedQuantity: number | null;
  locationId: number;
}

interface GraduateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: GraduateStagingItem | null;
  locations: Location[];
  onSuccess?: () => void;
}

type Mode = "existing" | "new";

export function GraduateDialog({
  open,
  onOpenChange,
  item,
  locations,
  onSuccess,
}: GraduateDialogProps) {
  const { token: csrfToken, isLoading: csrfLoading } = useCSRF();
  const graduateMutation = useGraduateStagingItem();
  const isSubmitting = graduateMutation.isPending;

  const [mode, setMode] = useState<Mode>("existing");
  const [countedQuantity, setCountedQuantity] = useState("");
  const [locationId, setLocationId] = useState<number | undefined>(undefined);

  // Existing-branch product search
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedProduct, setSelectedProduct] =
    useState<ProductSearchResult | null>(null);

  // New-branch: best-effort "name already exists" soft warning
  const [newBaseName, setNewBaseName] = useState("");
  const debouncedNewName = useDebounce(newBaseName.trim(), 350);

  // Reset everything when the dialog opens for a (new) item.
  useEffect(() => {
    if (open && item) {
      setMode("existing");
      setCountedQuantity(
        item.expectedQuantity != null ? String(item.expectedQuantity) : ""
      );
      setLocationId(item.locationId);
      setSearch("");
      setDebouncedSearch("");
      setSelectedProduct(null);
      setNewBaseName("");
    }
  }, [open, item]);

  // Debounce the search input (client state; keys the query below).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Existing-branch search against the product catalog. placeholderData keeps
  // the prior results on screen while the next term loads.
  const searchEnabled =
    open && mode === "existing" && debouncedSearch.length > 0;
  const { data: searchData, isFetching: searching } = useQuery({
    queryKey: ["product-search", debouncedSearch],
    queryFn: async ({ signal }) => {
      const res = await fetch(
        `/api/products?search=${encodeURIComponent(debouncedSearch)}&pageSize=20`,
        { signal }
      );
      if (!res.ok) throw new Error("search failed");
      return res.json();
    },
    enabled: searchEnabled,
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
  const results: ProductSearchResult[] = searchEnabled
    ? (searchData?.products ?? []).map(
        (p: { id: number; name: string; approvalStatus?: string }) => ({
          id: p.id,
          name: p.name,
          approvalStatus: p.approvalStatus,
        })
      )
    : [];

  // Best-effort duplicate-name check for the New branch (non-blocking).
  const dupEnabled = open && mode === "new" && debouncedNewName.length >= 2;
  const { data: dupData } = useQuery({
    queryKey: ["product-name-check", debouncedNewName],
    queryFn: async ({ signal }) => {
      const res = await fetch(
        `/api/products?search=${encodeURIComponent(debouncedNewName)}&pageSize=5`,
        { signal }
      );
      return res.ok ? res.json() : { products: [] };
    },
    enabled: dupEnabled,
    staleTime: 30_000,
  });
  const duplicateName: string | null = useMemo(() => {
    if (!dupEnabled) return null;
    const match = (dupData?.products ?? []).find(
      (p: { name: string; baseName?: string | null }) =>
        p.name?.toLowerCase() === debouncedNewName.toLowerCase() ||
        p.baseName?.toLowerCase() === debouncedNewName.toLowerCase()
    );
    return match ? match.name : null;
  }, [dupEnabled, dupData, debouncedNewName]);

  const countedNum = parseInt(countedQuantity, 10);
  const countedValid = Number.isInteger(countedNum) && countedNum >= 1;
  const baseGatePassed = countedValid && !!locationId && !!csrfToken;

  // Existing-branch Confirm gate: qty >= 1 AND a product is selected.
  const existingValid = baseGatePassed && !!selectedProduct;

  const handleGraduateExisting = async () => {
    if (!item || !existingValid || !selectedProduct || !locationId) return;
    try {
      await graduateMutation.mutateAsync({
        id: item.id,
        body: {
          mode: "existing",
          productId: selectedProduct.id,
          countedQuantity: countedNum,
          locationId,
        },
      });
      toast.success(`Added ${countedNum} to ${selectedProduct.name}`);
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      console.error("Error graduating staging item:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to graduate item"
      );
    }
  };

  // New-branch: ProductForm fires this only after its own field validation passes.
  const handleGraduateNew = async (productData: {
    baseName: string;
    variant: string;
    unit?: string;
    numericValue?: number;
    lowStockThreshold?: number;
    costPrice?: number;
    retailPrice?: number | null;
  }) => {
    if (!item || !countedValid || !locationId) return;
    try {
      await graduateMutation.mutateAsync({
        id: item.id,
        body: {
          mode: "new",
          countedQuantity: countedNum,
          locationId,
          productFields: {
            baseName: productData.baseName,
            variant: productData.variant,
            unit: productData.unit,
            numericValue: productData.numericValue,
            lowStockThreshold: productData.lowStockThreshold,
            costPrice: productData.costPrice,
            retailPrice: productData.retailPrice,
            locationId,
          },
        },
      });
      toast.success(`Created product and added ${countedNum} units`);
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      console.error("Error graduating staging item:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to graduate item"
      );
    }
  };

  const sharedTop = useMemo(
    () => (
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="graduate-counted">
            Counted Quantity <span className="text-destructive">*</span>
          </Label>
          <Input
            id="graduate-counted"
            type="number"
            min="1"
            value={countedQuantity}
            onChange={(e) => setCountedQuantity(e.target.value)}
            placeholder="Enter counted quantity"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="graduate-location">
            Location <span className="text-destructive">*</span>
          </Label>
          <Select
            value={locationId?.toString()}
            onValueChange={(value) => setLocationId(parseInt(value, 10))}
            disabled={locations.length === 0}
          >
            <SelectTrigger id="graduate-location">
              <SelectValue placeholder="Select a location" />
            </SelectTrigger>
            <SelectContent>
              {locations.map((location) => (
                <SelectItem key={location.id} value={location.id.toString()}>
                  {location.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    ),
    [countedQuantity, locationId, locations]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Graduate Item</DialogTitle>
          <DialogDescription>
            {item
              ? `Resolve "${item.description}" into real inventory.`
              : "Resolve this box into real inventory."}
          </DialogDescription>
        </DialogHeader>

        {/* Existing / New toggle */}
        <div className="inline-flex rounded-md border p-1 self-start">
          <button
            type="button"
            onClick={() => setMode("existing")}
            className={cn(
              "rounded-sm px-3 py-1.5 text-sm font-medium transition-colors",
              mode === "existing"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
            aria-pressed={mode === "existing"}
          >
            Existing product
          </button>
          <button
            type="button"
            onClick={() => setMode("new")}
            className={cn(
              "rounded-sm px-3 py-1.5 text-sm font-medium transition-colors",
              mode === "new"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
            aria-pressed={mode === "new"}
          >
            New product
          </button>
        </div>

        {sharedTop}

        {mode === "existing" ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="graduate-search">Find a product</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="graduate-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search products…"
                  className="pl-9"
                />
                {searching && (
                  <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>
            </div>

            {selectedProduct && (
              <div className="flex items-center gap-2 rounded-md border bg-muted/50 p-2 text-sm">
                <Package className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{selectedProduct.name}</span>
                <span className="text-xs text-muted-foreground">selected</span>
              </div>
            )}

            <div className="max-h-48 overflow-y-auto space-y-1">
              {results.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedProduct(p)}
                  className={cn(
                    "w-full text-left rounded-md border border-border/60 px-3 py-2 hover:bg-muted/50 text-sm",
                    selectedProduct?.id === p.id && "ring-1 ring-primary"
                  )}
                >
                  {p.name}
                </button>
              ))}
              {debouncedSearch.length > 0 &&
                !searching &&
                results.length === 0 && (
                  <p className="py-2 text-xs text-muted-foreground">
                    No products match “{debouncedSearch}”.
                  </p>
                )}
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button
                onClick={handleGraduateExisting}
                disabled={!existingValid || isSubmitting || csrfLoading}
              >
                {isSubmitting ? "Graduating…" : "Confirm"}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            {duplicateName && (
              <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>
                  A product named “{duplicateName}” already exists. You can still
                  create a new one if this is different.
                </span>
              </div>
            )}
            {/* ProductForm owns field validation + the submit button; it only
                fires onSubmit when its required fields are valid. We gate that
                button on counted qty via disableSubmit so Confirm stays disabled
                until counted qty >= 1 AND the new product fields are filled.
                The wrapping div captures the bubbled change of the baseName
                input to drive the best-effort duplicate-name warning without
                modifying ProductForm. */}
            <div
              onChange={(e) => {
                const target = e.target as HTMLInputElement;
                if (target?.id === "baseName") {
                  setNewBaseName(target.value);
                }
              }}
            >
              <ProductForm
                onSubmit={handleGraduateNew}
                onCancel={() => onOpenChange(false)}
                isSubmitting={isSubmitting}
                disableSubmit={!countedValid || csrfLoading || !csrfToken}
              />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
