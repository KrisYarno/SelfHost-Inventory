"use client";

import * as React from "react";
import { toast } from "sonner";
import { Package, MapPin, ArrowDown, Loader2 } from "lucide-react";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
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
import { ValueChip } from "@/components/ui/value-chip";
import { ContextTag } from "@/components/ui/context-tag";
import type { ProductLocationQuantity, BatchTransferResult } from "@/types/inventory";

export interface StockInProduct {
  productId: number;
  productName: string;
  quantity: number;
  minQuantity: number;
  shortage: number;
}

interface StockInTransferDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: StockInProduct | null;
  destinationLocationId: number;
  destinationLocationName: string;
  onSuccess?: () => void;
}

interface LocationTransferState {
  locationId: number;
  locationName: string;
  available: number;
  version: number;
  quantity: number; // Amount to transfer from this location
}

export function StockInTransferDialog({
  open,
  onOpenChange,
  product,
  destinationLocationId,
  destinationLocationName,
  onSuccess,
}: StockInTransferDialogProps) {
  const { token: csrfToken } = useCSRF();

  const [locations, setLocations] = React.useState<LocationTransferState[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  // Fetch available quantities at all locations when dialog opens
  React.useEffect(() => {
    if (!open || !product) {
      setLocations([]);
      return;
    }

    setIsLoading(true);
    fetch(`/api/inventory/product/${product.productId}/locations`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch locations");
        return res.json();
      })
      .then((data: { locations: ProductLocationQuantity[] }) => {
        // Filter out the destination location and sort by available quantity (highest first)
        const otherLocations = data.locations
          .filter((loc) => loc.locationId !== destinationLocationId)
          .sort((a, b) => b.quantity - a.quantity)
          .map((loc) => ({
            locationId: loc.locationId,
            locationName: loc.locationName,
            available: loc.quantity,
            version: loc.version,
            quantity: 0,
          }));
        setLocations(otherLocations);
      })
      .catch((err) => {
        console.error("Error fetching product locations:", err);
        toast.error("Failed to load available stock from other locations");
      })
      .finally(() => setIsLoading(false));
  }, [open, product, destinationLocationId]);

  if (!product) return null;

  // Calculate totals
  const totalToTransfer = locations.reduce((sum, loc) => sum + loc.quantity, 0);
  const projectedQuantity = product.quantity + totalToTransfer;
  const locationsWithStock = locations.filter((loc) => loc.available > 0);
  const locationsWithTransfer = locations.filter((loc) => loc.quantity > 0);

  const canSubmit = totalToTransfer > 0 && !isSubmitting;

  const handleQuantityChange = (locationId: number, value: string) => {
    const numValue = parseInt(value, 10);
    setLocations((prev) =>
      prev.map((loc) => {
        if (loc.locationId !== locationId) return loc;
        // Clamp to available quantity
        const clampedValue = isNaN(numValue) ? 0 : Math.min(Math.max(0, numValue), loc.available);
        return { ...loc, quantity: clampedValue };
      })
    );
  };

  const handleIncrement = (locationId: number) => {
    setLocations((prev) =>
      prev.map((loc) => {
        if (loc.locationId !== locationId) return loc;
        const next = Math.min(loc.quantity + 1, loc.available);
        return { ...loc, quantity: next };
      })
    );
  };

  const handleDecrement = (locationId: number) => {
    setLocations((prev) =>
      prev.map((loc) => {
        if (loc.locationId !== locationId) return loc;
        const next = Math.max(loc.quantity - 1, 0);
        return { ...loc, quantity: next };
      })
    );
  };

  const handleSubmit = async () => {
    if (!canSubmit || !product) return;

    const transfers = locationsWithTransfer.map((loc) => ({
      fromLocationId: loc.locationId,
      quantity: loc.quantity,
      expectedVersion: loc.version,
    }));

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/inventory/transfer/batch", {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({
          productId: product.productId,
          toLocationId: destinationLocationId,
          transfers,
        }),
      });

      const data: BatchTransferResult = await response.json();

      if (response.ok && data.success) {
        toast.success(
          `Transferred ${data.totalTransferred} units of ${product.productName} from ${locationsWithTransfer.length} location${locationsWithTransfer.length > 1 ? "s" : ""}`
        );
        onOpenChange(false);
        onSuccess?.();
      } else if (response.status === 207) {
        // Partial success
        const succeeded = data.results.filter((r) => r.success);
        const failed = data.results.filter((r) => !r.success);
        toast.warning(
          `Partially completed: ${succeeded.length} transfer${succeeded.length !== 1 ? "s" : ""} succeeded (${data.totalTransferred} units), ${failed.length} failed`
        );
        onSuccess?.(); // Still refresh data
        onOpenChange(false);
      } else {
        const errorMessage =
          (data as unknown as { error?: string }).error || "Failed to complete transfers";
        toast.error(errorMessage);
      }
    } catch (error) {
      console.error("Error performing batch transfer:", error);
      toast.error("Failed to transfer inventory");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md w-[95vw] sm:w-full overflow-hidden border border-border bg-background p-0 shadow-2xl">
        <div className="space-y-4 p-6">
          <DialogHeader className="space-y-2">
            <div className="space-y-1">
              <DialogTitle className="flex items-center gap-2 text-base md:text-lg font-semibold text-foreground">
                <ArrowDown className="h-4 w-4 text-muted-foreground" />
                Stock In
              </DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">
                Pull stock from other locations to replenish {destinationLocationName}.
              </DialogDescription>
            </div>

            {/* Product info card */}
            <div className="mt-2 rounded-lg border border-border bg-surface px-3 py-2">
              <div className="flex items-center gap-2">
                <Package className="h-4 w-4 text-muted-foreground" />
                <p className="text-sm font-medium text-foreground truncate">
                  {product.productName}
                </p>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                <ContextTag icon={<MapPin className="h-3 w-3 text-muted-foreground" />}>
                  {destinationLocationName}
                </ContextTag>
                <ValueChip
                  tone={product.quantity > 0 ? "neutral" : "negative"}
                  className="text-[10px]"
                >
                  Current: {product.quantity}
                </ValueChip>
                <ValueChip tone="neutral" className="text-[10px]">
                  Min: {product.minQuantity}
                </ValueChip>
                <ValueChip tone="negative" className="text-[10px]">
                  Shortage: {product.shortage}
                </ValueChip>
              </div>
            </div>
          </DialogHeader>

          {/* Source locations list */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Pull stock from:</p>

            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : locationsWithStock.length === 0 ? (
              <div className="rounded-lg border border-border bg-surface px-4 py-6 text-center">
                <p className="text-sm text-muted-foreground">
                  No stock available at other locations
                </p>
              </div>
            ) : (
              <div className="max-h-[280px] overflow-y-auto space-y-2 pr-1">
                {locations.map((loc) => {
                  const hasStock = loc.available > 0;
                  const hasQuantity = loc.quantity > 0;

                  return (
                    <div
                      key={loc.locationId}
                      className={`rounded-lg border px-3 py-2.5 transition-colors ${
                        hasQuantity
                          ? "border-positive-border bg-positive-muted"
                          : hasStock
                            ? "border-border bg-surface hover:bg-surface-hover"
                            : "border-border/50 bg-muted/30 opacity-60"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-foreground truncate">
                            {loc.locationName}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            Available:{" "}
                            <span
                              className={
                                loc.available > 0
                                  ? "text-foreground font-medium"
                                  : "text-muted-foreground"
                              }
                            >
                              {loc.available}
                            </span>
                          </p>
                        </div>

                        {hasStock ? (
                          <div className="flex items-center gap-1.5">
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="h-8 w-8 rounded-md text-lg"
                              onClick={() => handleDecrement(loc.locationId)}
                              disabled={loc.quantity === 0 || isSubmitting}
                            >
                              −
                            </Button>
                            <Input
                              type="number"
                              inputMode="numeric"
                              value={loc.quantity || ""}
                              onChange={(e) => handleQuantityChange(loc.locationId, e.target.value)}
                              className="h-8 w-14 rounded-md text-center text-sm font-semibold"
                              placeholder="0"
                              disabled={isSubmitting}
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="h-8 w-8 rounded-md text-lg"
                              onClick={() => handleIncrement(loc.locationId)}
                              disabled={loc.quantity >= loc.available || isSubmitting}
                            >
                              +
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground italic">No stock</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Summary */}
          {locationsWithStock.length > 0 && (
            <div className="rounded-lg border border-border bg-muted/50 px-3 py-2.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Total to transfer:</span>
                <span className="font-semibold text-foreground">{totalToTransfer} units</span>
              </div>
              <div className="flex items-center justify-between text-sm mt-1">
                <span className="text-muted-foreground">Projected stock:</span>
                <ValueChip
                  tone={
                    projectedQuantity >= product.minQuantity
                      ? "positive"
                      : projectedQuantity > 0
                        ? "neutral"
                        : "negative"
                  }
                  className="text-[11px]"
                >
                  {projectedQuantity} units
                </ValueChip>
              </div>
            </div>
          )}

          <DialogFooter className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="h-10 w-full sm:w-auto"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 sm:w-auto"
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Transferring...
                </>
              ) : totalToTransfer > 0 ? (
                `Stock In ${totalToTransfer} units`
              ) : (
                "Stock In"
              )}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
