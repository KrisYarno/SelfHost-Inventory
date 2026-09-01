"use client";

import * as React from "react";
import { toast } from "sonner";
import { Package, MapPin, ArrowDown, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import { invalidateInventoryCaches } from "@/hooks/use-inventory-mutations";
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
import { readApiError } from "@/lib/api-error";

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
  const queryClient = useQueryClient();

  const [locations, setLocations] = React.useState<LocationTransferState[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  /**
   * The DESTINATION's own quantity, out of the same payload as the sources
   * (reconciliation Part 2, pack REV-22 F6). Null until the first read answers,
   * and only then does the header stop quoting the `product` prop — a snapshot
   * taken by whatever screen opened this dialog, which after a partial transfer
   * is a number nothing on the wire still agrees with.
   */
  const [destinationQuantity, setDestinationQuantity] = React.useState<number | null>(null);
  /**
   * Raised when a re-read FAILS after stock has moved (pack REV-22 F6b): every
   * `expectedVersion` this dialog holds is then unverifiable, so the retry is
   * refused until a read succeeds. The rows keep their safe values meanwhile —
   * the operator's work is not thrown away, it is just not sendable.
   */
  const [needsFreshVersions, setNeedsFreshVersions] = React.useState(false);

  /**
   * Read the per-location availability AND VERSIONS this dialog submits with.
   *
   * Extracted from the mount effect (reconciliation Part 2, pack CB1b.6) because
   * the partial-success branch has to run it again: every `expectedVersion` the
   * dialog holds after a 207 is stale for the locations that moved stock, and a
   * retry sending stale versions is exactly the conflict the prelock now
   * refuses. `carry` is what a retry keeps — a failed transfer's requested
   * quantity, RE-CLAMPED against what the refreshed read says is available, so
   * the retry can never ask for stock that has since gone.
   *
   * Returns whether the read succeeded: the caller after a 207 needs to know,
   * because a failed re-read is what arms `needsFreshVersions`.
   */
  const refetchLocations = React.useCallback(
    async (carry: Record<number, number> = {}): Promise<boolean> => {
      if (!product) {
        setLocations([]);
        setDestinationQuantity(null);
        return false;
      }

      setIsLoading(true);
      try {
        const res = await fetch(`/api/inventory/product/${product.productId}/locations`);
        if (!res.ok) throw new Error("Failed to fetch locations");
        const data: { locations: ProductLocationQuantity[] } = await res.json();
        // The DESTINATION row, out of the same payload (pack REV-22 F6). The
        // route answers with every location, so this is normally present; when
        // it is not, the header keeps saying what it already said rather than
        // inventing a zero.
        const destination = data.locations.find(
          (loc) => loc.locationId === destinationLocationId
        );
        if (destination) setDestinationQuantity(destination.quantity);
        // Filter out the destination location and sort by available quantity (highest first)
        const otherLocations = data.locations
          .filter((loc) => loc.locationId !== destinationLocationId)
          .sort((a, b) => b.quantity - a.quantity)
          .map((loc) => ({
            locationId: loc.locationId,
            locationName: loc.locationName,
            available: loc.quantity,
            version: loc.version,
            quantity: Math.min(Math.max(0, carry[loc.locationId] ?? 0), loc.quantity),
          }));
        setLocations(otherLocations);
        // Fresh versions are in hand again — whatever refused before is retryable.
        setNeedsFreshVersions(false);
        return true;
      } catch (err) {
        console.error("Error fetching product locations:", err);
        toast.error("Failed to load available stock from other locations");
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [product, destinationLocationId]
  );

  // Fetch available quantities at all locations when dialog opens — and CLEAR
  // the previous product's rows/header first (fix-delta FDb-7): this effect
  // re-runs when `product` changes while the dialog is open, and without the
  // clears the header would quote product A's destination quantity under
  // product B's name for the duration of the read, with A's rows submittable.
  React.useEffect(() => {
    if (!open || !product) {
      setLocations([]);
      setDestinationQuantity(null);
      setNeedsFreshVersions(false);
      return;
    }
    setLocations([]);
    setDestinationQuantity(null);
    setNeedsFreshVersions(false);
    void refetchLocations();
  }, [open, product, refetchLocations]);

  if (!product) return null;

  // Calculate totals. Current/Shortage/Projected all hang off the DESTINATION's
  // fresh quantity when one has been read, and off the opening prop until then
  // (pack REV-22 F6) — never a mix of the two.
  const currentQuantity = destinationQuantity ?? product.quantity;
  const shortage =
    destinationQuantity === null
      ? product.shortage
      : Math.max(0, product.minQuantity - destinationQuantity);
  const totalToTransfer = locations.reduce((sum, loc) => sum + loc.quantity, 0);
  const projectedQuantity = currentQuantity + totalToTransfer;
  const locationsWithStock = locations.filter((loc) => loc.available > 0);
  const locationsWithTransfer = locations.filter((loc) => loc.quantity > 0);

  const canSubmit = totalToTransfer > 0 && !isSubmitting && !needsFreshVersions;

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
        // Cross-page coherence (commit 9ecac19): keep /inventory, /journal, and dashboard
        // query keys in sync with the batch transfer, not just the stocker's local refetch.
        invalidateInventoryCaches(queryClient, product.productId);
        onOpenChange(false);
        onSuccess?.();
      } else if (response.status === 207) {
        // PARTIAL SUCCESS — some source locations moved stock, some refused
        // (reconciliation Part 2, pack CB1b.6; spec REV-9 CX6-18).
        //
        // The batch route answers per transfer, and so does this branch: a
        // version conflict at ONE location is that location's message, not a
        // request-wide failure the operator has to decode. The dialog STAYS
        // OPEN, because the failed rows ARE the retry — closing it threw away
        // the only screen that knew which sources still owed stock.
        const succeeded = data.results.filter((r) => r.success);
        const failed = data.results.filter((r) => !r.success);

        if (succeeded.length > 0) {
          toast.success(
            `Transferred ${data.totalTransferred} units of ${product.productName} from ${succeeded.length} location${succeeded.length !== 1 ? "s" : ""}`
          );
        }
        for (const result of failed) {
          const sourceName =
            locations.find((loc) => loc.locationId === result.fromLocationId)?.locationName ??
            `Location ${result.fromLocationId}`;
          // The route's own sentence, verbatim — a version conflict says so.
          toast.error(`${sourceName}: ${result.error ?? "Transfer failed"}`);
        }

        // Partial success still moved stock; invalidate the same cross-page keys.
        invalidateInventoryCaches(queryClient, product.productId);
        onSuccess?.(); // Still refresh data

        // THE SAFE STATE FIRST, THE RE-READ SECOND (pack REV-22 F6b).
        //
        // Zero what moved and re-clamp what refused BEFORE awaiting anything:
        // between the 207 and the re-read the dialog otherwise still holds the
        // request that just half-failed, and that request is the one thing the
        // operator must never send again. The re-clamp here is against what
        // this dialog already knew was available; the read that follows
        // replaces both numbers with the truth.
        const carry: Record<number, number> = {};
        failed.forEach((result) => {
          carry[result.fromLocationId] = result.quantity;
        });
        const succeededIds = succeeded.map((result) => result.fromLocationId);
        setLocations((prev) =>
          prev.map((loc) => {
            if (succeededIds.indexOf(loc.locationId) !== -1) return { ...loc, quantity: 0 };
            const asked = carry[loc.locationId];
            if (asked === undefined) return loc;
            return { ...loc, quantity: Math.min(Math.max(0, asked), loc.available) };
          })
        );

        // Re-read availability AND versions: the succeeded rows come back at
        // zero, the failed ones keep what was asked for, re-clamped — so a
        // retry submits fresh `expectedVersion`s for exactly what is left. If
        // that read FAILS, the safe state above stands and the retry is barred
        // until a later read succeeds: every version in hand is now unverifiable.
        const refreshed = await refetchLocations(carry);
        if (!refreshed) setNeedsFreshVersions(true);
      } else {
        // The shared reader (fix-delta FDb-12): this was the one surface reading
        // a covered writer's errors by hand after F7 converted the other four —
        // and the batch route can now answer with the flat BUSY/refusal shapes.
        const { message } = readApiError(data);
        toast.error(message || "Failed to complete transfers");
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
                  tone={currentQuantity > 0 ? "neutral" : "negative"}
                  className="text-[10px]"
                >
                  Current: {currentQuantity}
                </ValueChip>
                <ValueChip tone="neutral" className="text-[10px]">
                  Min: {product.minQuantity}
                </ValueChip>
                <ValueChip tone={shortage > 0 ? "negative" : "positive"} className="text-[10px]">
                  Shortage: {shortage}
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

          {/* Why the button is dead (pack REV-22 F6b) — a disabled control with
              no sentence beside it is just a broken screen. */}
          {needsFreshVersions && (
            <div
              className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2.5"
              role="alert"
            >
              <p className="text-sm text-destructive">
                Some stock moved, but the re-read failed — close and reopen Stock In to get
                current quantities before transferring the rest.
              </p>
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
