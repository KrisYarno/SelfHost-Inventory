"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Loader2, AlertCircle, Package } from "lucide-react";
import { toast } from "sonner";
import { useCSRF } from "@/hooks/use-csrf";
import { useDebounce } from "@/hooks/use-debounce";
import { useCountStagingItem, useGraduateStagingItem } from "@/hooks/use-staging";
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
  /**
   * The row's count — `null` while the box is still uncounted. W1-3a (pack
   * REV-3 T2) made this the ONLY source of what graduation books, so the dialog
   * renders it read-only and never seeds it from `expectedQuantity`.
   */
  countedQuantity: number | null;
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
  const countMutation = useCountStagingItem();
  const isSubmitting = graduateMutation.isPending;

  const [mode, setMode] = useState<Mode>("existing");
  // The AUTHORITATIVE count. Seeded from the row and thereafter only ever
  // replaced by a count-endpoint RESPONSE — never by anything typed here, which
  // is the whole point: the field the operator types into (below) posts a count,
  // and graduation reads the row.
  const [countedQuantity, setCountedQuantity] = useState<number | null>(null);
  const [countDraft, setCountDraft] = useState("");
  // The override affordance stays collapsed: the default path books the count.
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideQuantity, setOverrideQuantity] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
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
      // W1-3a: the count comes from the ROW. The deleted line here used to seed
      // it from `expectedQuantity`, which is precisely how a counted 46 became a
      // booked 50 — the operator saw a plausible number and pressed Confirm.
      setCountedQuantity(item.countedQuantity);
      setCountDraft("");
      setOverrideOpen(false);
      setOverrideQuantity("");
      setOverrideReason("");
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

  // --- The count gate (pack REV-3 T2) -------------------------------------
  // Mirrors the server's two 422s so the operator learns the rule from the
  // dialog instead of from a failed request.
  const countMissing = countedQuantity === null;
  const countIsZero = countedQuantity === 0;

  // --- The override pair, mirrored client-side ------------------------------
  const overrideNum = parseInt(overrideQuantity, 10);
  const overrideQuantityValid = Number.isInteger(overrideNum) && overrideNum >= 1;
  const trimmedReason = overrideReason.trim();
  const overrideReasonValid =
    trimmedReason.length >= 1 && trimmedReason.length <= 500;
  const overrideComplete = overrideQuantityValid && overrideReasonValid;
  const overrideTouched =
    overrideQuantity.trim().length > 0 || trimmedReason.length > 0;
  // Half a pair is a 400 at the server; hold Confirm rather than send it.
  const overrideHalfFilled = overrideOpen && overrideTouched && !overrideComplete;
  // Only a COMPLETE pair on an OPEN affordance rides the body — collapsing the
  // panel is a withdrawal, not a hidden instruction.
  const overrideActive = overrideOpen && overrideComplete;

  const overrideFields = overrideActive
    ? { overrideQuantity: overrideNum, overrideReason: trimmedReason }
    : {};
  const bookedQuantity = overrideActive ? overrideNum : countedQuantity;

  const baseGatePassed =
    !countMissing &&
    !countIsZero &&
    !overrideHalfFilled &&
    !!locationId &&
    !!csrfToken;

  // Existing-branch Confirm gate: a usable count AND a product is selected.
  const existingValid = baseGatePassed && !!selectedProduct;

  // --- The count control ----------------------------------------------------
  // A SEPARATE act with a SEPARATE button: it posts to the count endpoint and
  // adopts the server's echo. Graduation never carries a count, so there is no
  // path here that writes one "through" a Confirm.
  const countDraftNum = parseInt(countDraft, 10);
  const countDraftValid = Number.isInteger(countDraftNum) && countDraftNum >= 0;

  const handleRecordCount = async () => {
    if (!item || !countDraftValid) return;
    try {
      const result = await countMutation.mutateAsync({
        id: item.id,
        countedQuantity: countDraftNum,
      });
      setCountedQuantity(result.countedQuantity);
      setCountDraft("");
      toast.success(`Counted ${result.countedQuantity}`);
    } catch (error) {
      console.error("Error counting staging item:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to record the count"
      );
    }
  };

  const handleGraduateExisting = async () => {
    if (!item || !existingValid || !selectedProduct || !locationId) return;
    try {
      await graduateMutation.mutateAsync({
        id: item.id,
        body: {
          mode: "existing",
          productId: selectedProduct.id,
          locationId,
          ...overrideFields,
        },
      });
      toast.success(`Added ${bookedQuantity} to ${selectedProduct.name}`);
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
    if (!item || !baseGatePassed || !locationId) return;
    try {
      await graduateMutation.mutateAsync({
        id: item.id,
        body: {
          mode: "new",
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
          ...overrideFields,
        },
      });
      toast.success(`Created product and added ${bookedQuantity} units`);
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      console.error("Error graduating staging item:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to graduate item"
      );
    }
  };

  const sharedTop = (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="graduate-counted">Counted (from the row)</Label>
          {/* READ-ONLY, deliberately. This is what graduation books; the way to
              change it is to count the box again, in the control below. */}
          <Input
            id="graduate-counted"
            type="text"
            inputMode="numeric"
            readOnly
            aria-readonly="true"
            tabIndex={-1}
            value={countedQuantity === null ? "" : String(countedQuantity)}
            placeholder="Not counted yet"
            className="bg-muted/50"
          />
          {countMissing && (
            <p className="text-xs text-destructive">
              Count this item first — graduation books the counted quantity.
            </p>
          )}
          {countIsZero && (
            <p className="text-xs text-destructive">
              A zero count is a Discard, not a stock-in.
            </p>
          )}
          {item?.expectedQuantity != null && (
            <p className="text-xs text-muted-foreground">
              Expected {item.expectedQuantity}
              {countedQuantity !== null &&
                countedQuantity !== item.expectedQuantity &&
                ` — counted ${countedQuantity}`}
            </p>
          )}
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

      {/* The count control — its OWN act, its OWN button, its OWN request. It
          posts to the count endpoint and adopts the SERVER's number; Confirm
          below never carries a count. */}
      <div
        data-testid="graduate-count-control"
        className="rounded-md border border-border/60 p-3 space-y-2"
      >
        <Label htmlFor="graduate-count-entry">
          {countMissing ? "Record the count" : "Recount"}
        </Label>
        <div className="flex gap-2">
          <Input
            id="graduate-count-entry"
            type="number"
            min="0"
            value={countDraft}
            onChange={(e) => setCountDraft(e.target.value)}
            placeholder="Units on the dock"
          />
          <Button
            type="button"
            variant="secondary"
            onClick={handleRecordCount}
            disabled={!countDraftValid || countMutation.isPending || !csrfToken}
          >
            {countMutation.isPending ? "Saving…" : "Save count"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Counting is recorded separately, stamped with who counted and when. A
          count of 0 is a valid answer — an empty box is a fact.
        </p>
      </div>

      {/* The override affordance: collapsed by default, because the default is
          to book what was counted. */}
      <div className="space-y-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="px-0 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={overrideOpen}
          onClick={() => setOverrideOpen((v) => !v)}
        >
          Book a different quantity
        </Button>
        {overrideOpen && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
            <div className="space-y-1.5">
              <Label htmlFor="graduate-override-qty">Quantity to book</Label>
              <Input
                id="graduate-override-qty"
                type="number"
                min="1"
                value={overrideQuantity}
                onChange={(e) => setOverrideQuantity(e.target.value)}
                placeholder="Units to add to stock"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="graduate-override-reason">
                Reason for the difference
              </Label>
              <Input
                id="graduate-override-reason"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                maxLength={500}
                placeholder="e.g. six vials broken in transit"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              The count stays on the record; only the stock movement changes.
              Both numbers and this reason are written to the activity log.
            </p>
            {overrideHalfFilled && (
              <p className="text-xs text-destructive">
                A quantity and a reason are both required.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
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
                disableSubmit={!baseGatePassed || csrfLoading}
              />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
