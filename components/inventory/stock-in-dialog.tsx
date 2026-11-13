"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Package, Calendar, AlertCircle } from "lucide-react";
import { useLocation } from "@/contexts/location-context";
import { getUserFriendlyMessage } from "@/lib/error-handling";
import { useProductLocationQuantity } from "@/hooks/use-product-location-quantity";
import { useStockIn } from "@/hooks/use-inventory-mutations";
import { useSubmitLatch } from "@/hooks/use-submit-latch";
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
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ValueChip } from "@/components/ui/value-chip";
import { ReceivingRedirectPrompt } from "@/components/inventory/receiving-redirect-prompt";
import type { DialogProduct } from "@/types/inventory";

/** `unit` when the count is 1, `units` otherwise. */
function unitWord(count: number): string {
  return count === 1 ? "unit" : "units";
}

interface StockInDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: DialogProduct;
  onSuccess?: () => void;
}

export function StockInDialog({
  open,
  onOpenChange,
  product,
  onSuccess,
}: StockInDialogProps) {
  const { selectedLocationId } = useLocation();
  // The draft starts empty at MOUNT: the hosts render this dialog only while it
  // is open for a product and null the product on close (§ P2-B3-1R, M-a.3 /
  // MS-1-5), so nothing typed for one product reaches another's stock-in.
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");

  const quantityQuery = useProductLocationQuantity(product.id, selectedLocationId, {
    enabled: open,
  });
  const stockInMutation = useStockIn();
  // The shared submit latch (§ P2-B3-1R, M-a.1): one stock-in per tap, and no
  // dismissal (Escape, a click outside, the X, Cancel) while it is in flight.
  // `busy` is the same fact for rendering: the frozen form and "Adding Stock...".
  const { busy, run, guardOpenChange } = useSubmitLatch();

  // Stock is KNOWN only on a successful read (FR-R1 (4), CR-OC-2; the adjust
  // dialog's rule): loading and failure are their own states, never 0, and the
  // new total is drawn only from a known count.
  const knownStock =
    selectedLocationId !== null && quantityQuery.status === "success" ? quantityQuery.data : null;
  const quantityNum = parseInt(quantity, 10) || 0;

  const isValid = quantityNum > 0;

  const handleSubmit = async () => {
    if (!selectedLocationId) {
      toast.error("No location selected");
      return;
    }

    if (!isValid) {
      toast.error("Please enter a valid quantity");
      return;
    }

    // The Note (§ P2-B3-1R, MS-1-1): sent as `notes` only when it says
    // something; the route records it on the stock-in's history event (R-a.4).
    const sentNotes = notes.trim();

    try {
      const settled = await run(async () => {
        await stockInMutation.mutateAsync({
          productId: product.id,
          locationId: selectedLocationId,
          quantity: quantityNum,
          ...(sentNotes !== "" ? { notes: sentNotes } : {}),
        });
        return true as const;
      });
      // A second tap while the first holds the latch: nothing was sent.
      if (settled === undefined) return;

      toast.success(`Added ${quantityNum} units to ${product.name}`);
      // The host's RAW callback, never the guard, which drops a close while a
      // submit holds the latch.
      onOpenChange(false);
      onSuccess?.();

      // Reset form
      setQuantity("");
      setNotes("");
    } catch (error) {
      console.error("Error adding stock:", error);

      // Generate user-friendly error message
      const friendlyError = getUserFriendlyMessage(error as Error);

      toast.error(
        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">{friendlyError.title}</p>
              <p className="text-sm">{friendlyError.description}</p>
              {friendlyError.action && (
                <p className="text-sm text-muted-foreground">{friendlyError.action}</p>
              )}
            </div>
          </div>
        </div>,
        {
          duration: 5000,
        }
      );
    }
  };

  // Escape, a click outside, the X and Cancel — dropped while a stock-in is in
  // flight (the latch's synchronous ref; FD3-1). A failed one releases it.
  const handleOpenChange = guardOpenChange(onOpenChange);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Stock In - Add Inventory</DialogTitle>
          <DialogDescription>
            Add new stock for this product from a purchase order or delivery.
          </DialogDescription>
        </DialogHeader>

        {/* Product Info */}
        <div className="p-4 rounded-lg bg-muted/50">
          <div>
            <h4 className="font-medium">{product.name}</h4>
            <div role="status" aria-live="polite" className="flex items-center gap-4 mt-1">
              {/* The current-stock chip: the adjust dialog's four states. */}
              <div className="flex items-center gap-1" data-testid="stock-in-stock">
                <Package className="h-4 w-4 text-muted-foreground" />
                {selectedLocationId === null ? (
                  <span className="text-sm text-muted-foreground">No location selected.</span>
                ) : quantityQuery.status === "error" ? (
                  <span className="text-sm text-destructive">
                    Couldn&apos;t read current stock — it will be checked when you save.
                  </span>
                ) : knownStock !== null ? (
                  <ValueChip tone={knownStock > 0 ? "positive" : knownStock < 0 ? "negative" : "neutral"}>
                    {`${knownStock} ${unitWord(knownStock)}`}
                  </ValueChip>
                ) : (
                  <span className="text-sm text-muted-foreground">Reading stock…</span>
                )}
              </div>
              {knownStock !== null && quantityNum > 0 ? (
                <>
                  <span className="text-muted-foreground">→</span>
                  <Badge variant="default" className="text-xs">
                    New: {knownStock + quantityNum}
                  </Badge>
                </>
              ) : null}
            </div>
          </div>
        </div>

        {/* While a stock-in is in flight the WHOLE form is frozen (M-a.1). */}
        <fieldset disabled={busy} className="min-w-0">
          <div className="space-y-4">
            {/* Quantity */}
            <div className="space-y-2">
              <Label htmlFor="quantity">
                Quantity to Add <span className="text-destructive">*</span>
              </Label>
              <Input
                id="quantity"
                type="number"
                min="1"
                inputMode="numeric"
                pattern="[0-9]*"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="Enter quantity"
                className="text-lg"
                autoFocus
              />
            </div>

            {/* T5 (pack REV-3): every stock-in is a positive delta, so the prompt
                turns on as soon as a quantity is entered. Once per session, and
                declining leaves this stock-in exactly as it was. */}
            <ReceivingRedirectPrompt active={quantityNum > 0} />

            {/* The Note (§ P2-B3-1R, MS-1-1): ONE optional field, shown in the
                product's history to admins and its author. It replaces the
                Order/Reference Number and Additional Notes, which the route
                silently dropped. */}
            <div className="space-y-2">
              <Label htmlFor="stock-in-note">Note (optional)</Label>
              <Textarea
                id="stock-in-note"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g., Supplier details, batch number, expiry date..."
                maxLength={2000}
                rows={3}
                aria-describedby="stock-in-note-helper"
              />
              <p id="stock-in-note-helper" className="text-[11px] text-muted-foreground">
                Seen by admins and by you.
              </p>
            </div>

            {/* Info Box */}
            <div className="rounded-lg border bg-muted/50 p-3">
              <div className="flex items-start gap-2">
                <Calendar className="h-4 w-4 text-muted-foreground mt-0.5" />
                <div className="text-sm text-muted-foreground">
                  This stock-in will be recorded with today&apos;s date and time for tracking purposes.
                </div>
              </div>
            </div>
          </div>
        </fieldset>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!isValid || busy}
          >
            {busy ? "Adding Stock..." : `Add ${quantityNum || 0} Units`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
