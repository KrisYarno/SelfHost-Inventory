"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Plus, Minus, Package, MapPin } from "lucide-react";
import { useLocation } from "@/contexts/location-context";
import { useProductLocationQuantity } from "@/hooks/use-product-location-quantity";
import { useAdjustInventory } from "@/hooks/use-inventory-mutations";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ValueChip } from "@/components/ui/value-chip";
import { ContextTag } from "@/components/ui/context-tag";
import { InlineHighlight } from "@/components/ui/inline-highlight";
import { ReceivingRedirectPrompt } from "@/components/inventory/receiving-redirect-prompt";
import { IntentChip } from "@/components/inventory/intent-chip";
import { OrderLookup, type PickedOrder } from "@/components/inventory/order-lookup";
import type { DeductionIntent } from "@/lib/inventory/intent";
import { ORDER_REFERENCE_HINT, ORDER_REFERENCE_SHAPE } from "@/lib/orders/order-reference-shape";
import type { DialogProduct } from "@/types/inventory";

interface QuickAdjustDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: DialogProduct;
  onSuccess?: () => void;
}

// W2-1 (pack REV-11 T7): the Phase-C coded-reason SELECT that used to live here
// is gone. The intent chip replaced it — three values instead of five, mapped
// server-side — and the adjust route now REFUSES the old vocabulary outright,
// so leaving the select in place would have offered operators a field the API
// rejects. One question, one answer, one place it is interpreted.

// Reconciliation Part 2, B3-1 (pack CB3b-ii.1b + § P2-B3-1): THE CAPTURE. A
// Remove under the `order` chip can name its order — picked from the search
// (`selectedExternalOrderId`) or typed (`orderReference`), never both — and the
// server stamps the ledger row when it can stand behind the identity. The
// sentences below are frozen by the pack, byte for byte.
const CAPTURE_BOTH_SENTENCE = "Pick the order or type the reference, not both";

/** The stored order id the server stamped the ledger row with (`log.orderRecordId` on the 200). */
function stampedOrderId(result: unknown): string | null {
  const log = (result as { log?: { orderRecordId?: unknown } } | null | undefined)?.log;
  return typeof log?.orderRecordId === "string" ? log.orderRecordId : null;
}

export function QuickAdjustDialog({
  open,
  onOpenChange,
  product,
  onSuccess,
}: QuickAdjustDialogProps) {
  const { selectedLocationId, locations } = useLocation();
  const [adjustmentType, setAdjustmentType] = useState<"add" | "remove">("add");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  // null = the operator has not tapped the chip. Deliberately NOT pre-filled
  // with "other": the request must be able to say "nothing was stated", and a
  // default selection would make every untouched adjustment look answered.
  const [intent, setIntent] = useState<DeductionIntent | null>(null);
  const [notes, setNotes] = useState("");
  // The capture's two inputs. They exist ONLY while the capture shows (a Remove
  // under `order`): leaving that state clears both, so an identity typed for a
  // removal can never ride along on an add or on another intent.
  const [pickedOrder, setPickedOrder] = useState<PickedOrder | null>(null);
  const [orderReference, setOrderReference] = useState("");

  // ...and an identity belongs to ONE product's removal. The inventory page
  // keeps this dialog mounted and swaps `product` under it, so an order picked
  // or typed for one product, then Cancelled, must not ride along on the next
  // product's removal (B3-1 FR1, CR-1). Keyed on the id, never the object: the
  // page builds a fresh object on every open, and reopening the SAME product
  // keeps the capture. The other remembered fields are out of scope here.
  //
  // Reset DURING RENDER (React's "adjusting state when a prop changes"), never
  // in an effect: an effect lets one render of the new product COMMIT with the
  // old capture — Confirm enabled, its handler pairing the new product with the
  // old order — before the clearing render lands (B3-1 FD1-1). Setting state
  // here makes React discard this render and re-run it before anything commits.
  const [captureProductId, setCaptureProductId] = useState(product.id);
  if (captureProductId !== product.id) {
    setCaptureProductId(product.id);
    setPickedOrder(null);
    setOrderReference("");
  }

  const quantityQuery = useProductLocationQuantity(product.id, selectedLocationId, {
    enabled: open,
  });
  const adjustMutation = useAdjustInventory();
  const isSubmitting = adjustMutation.isPending;

  const currentQuantity = quantityQuery.data ?? 0;
  const quantityNum = parseInt(quantity, 10) || 0;
  const adjustedQuantity = adjustmentType === "add"
    ? currentQuantity + quantityNum
    : currentQuantity - quantityNum;
  const selectedLocationName =
    locations.find((loc) => loc.id === selectedLocationId)?.name ?? "Selected location";

  const captureActive = adjustmentType === "remove" && intent === "order";
  const trimmedReference = orderReference.trim();
  const sentPick = captureActive ? pickedOrder : null;
  // Blank or whitespace-only is NOT a reference: it stays out of the body (the
  // schema's `.min(1)` would refuse it) and out of every check below.
  const sentReference = captureActive && trimmedReference !== "" ? trimmedReference : null;
  const captureConflict = sentPick !== null && sentReference !== null;
  // The server's bar, applied before the round trip: a reference it could never
  // resolve is fixed here, not discovered in the toast.
  const referenceShapeInvalid =
    sentReference !== null && !ORDER_REFERENCE_SHAPE.test(sentReference);

  const isValid =
    quantityNum > 0 &&
    reason.trim() &&
    adjustedQuantity >= 0 &&
    !captureConflict &&
    !referenceShapeInvalid;

  const clearCapture = () => {
    setPickedOrder(null);
    setOrderReference("");
  };

  const handleAdjustmentTypeChange = (value: "add" | "remove") => {
    setAdjustmentType(value);
    if (value !== "remove") clearCapture();
  };

  const handleIntentChange = (next: DeductionIntent) => {
    setIntent(next);
    if (next !== "order") clearCapture();
  };

  const handleIncrement = () => {
    setQuantity((prev) => {
      const current = Number.parseInt(prev, 10) || 0;
      const next = Math.max(current + 1, 1);
      return String(next);
    });
  };

  const handleDecrement = () => {
    setQuantity((prev) => {
      const current = Number.parseInt(prev, 10) || 1;
      const next = Math.max(current - 1, 1);
      return String(next);
    });
  };

  const handleSubmit = async () => {
    if (!selectedLocationId) {
      toast.error("No location selected");
      return;
    }

    // Refused HERE, before the server's own 400 could: the operator named the
    // order twice, and only they know which one they meant.
    if (captureConflict) {
      toast.error(CAPTURE_BOTH_SENTENCE);
      return;
    }

    if (!isValid) {
      toast.error("Please fill in all required fields");
      return;
    }

    try {
      const result = await adjustMutation.mutateAsync({
        productId: product.id,
        locationId: selectedLocationId,
        delta: adjustmentType === "add" ? quantityNum : -quantityNum,
        reason,
        notes: notes || undefined,
        // Absent, not null, when the chip was never tapped — the route reads
        // key PRESENCE to tell "unstated" from "stated as other".
        intent: intent ?? undefined,
        // The capture: identity only on a Remove under `order`, and at most one
        // of the two (refused above). Absent keys, never empty values.
        selectedExternalOrderId: sentPick?.id,
        orderReference: sentReference ?? undefined,
      });

      if (sentPick === null && sentReference === null) {
        toast.success(
          adjustmentType === "add"
            ? `Added ${quantityNum} units to ${product.name}`
            : `Removed ${quantityNum} units from ${product.name}`
        );
      } else if (stampedOrderId(result) !== null) {
        toast.success(
          `Removed ${quantityNum} units — attributed to order ${sentPick?.orderNumber ?? sentReference}`
        );
      } else {
        // ONE sentence for every way the identity did not land — unmatched,
        // ambiguous, not yours, unusable, or the lookup failing. The removal
        // itself succeeded; only the stamp was withheld. Held for 10 s (the
        // house idiom for a toast that must be read): the dialog closes as it
        // appears, and sonner's 4 s default is gone before it can be read.
        toast.warning(
          `Removed ${quantityNum} units — the reference was not matched to an order you can see; the deduction is recorded unattributed`,
          { duration: 10000 }
        );
      }

      onOpenChange(false);
      onSuccess?.();

      // Reset form
      setQuantity("");
      setReason("");
      setIntent(null);
      setNotes("");
      setAdjustmentType("add");
      clearCapture();
    } catch (error) {
      console.error("Error adjusting inventory:", error);
      toast.error(error instanceof Error ? error.message : "Failed to adjust inventory");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Quick Inventory Adjustment</DialogTitle>
          <DialogDescription>
            Adjust the inventory level for this product.
          </DialogDescription>
        </DialogHeader>

        {/* Product Info */}
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Package className="h-4 w-4" />
            <span>Product</span>
          </div>
          <h4 className="mt-1 text-base font-semibold">{product.name}</h4>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <ContextTag icon={<MapPin className="h-3 w-3 text-muted-foreground" />}>
              {selectedLocationName}
            </ContextTag>
            {quantityQuery.isError ? (
              <span className="text-destructive">Could not load current stock</span>
            ) : (
              <ValueChip
                tone={currentQuantity > 0 ? "positive" : currentQuantity < 0 ? "negative" : "neutral"}
              >
                {quantityQuery.isLoading ? "Loading..." : `${currentQuantity} units`}
              </ValueChip>
            )}
          </div>
        </div>

        <div className="space-y-4">
          {/* Adjustment Type */}
          <div className="space-y-2">
            <Label>Adjustment Type</Label>
            <RadioGroup
              value={adjustmentType}
              onValueChange={(value: "add" | "remove") => handleAdjustmentTypeChange(value)}
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="add" id="add" />
                <label
                  htmlFor="add"
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <Plus className="h-4 w-4 text-positive" />
                  Add Stock
                </label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="remove" id="remove" />
                <label
                  htmlFor="remove"
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <Minus className="h-4 w-4 text-negative" />
                  Remove Stock
                </label>
              </div>
            </RadioGroup>
          </div>

          {/* Quantity */}
          <div className="space-y-2">
            <Label htmlFor="quantity" className="text-xs font-medium text-muted-foreground">
              Quantity
            </Label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-10 w-10 rounded-md border-border"
                aria-label="Decrease quantity"
                onClick={handleDecrement}
                disabled={quantityNum <= 1}
              >
                <Minus className="h-4 w-4" />
              </Button>
              <Input
                id="quantity"
                type="number"
                min="1"
                inputMode="numeric"
                pattern="[0-9]*"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="Enter quantity"
                className="h-10 flex-1 text-center text-lg font-semibold tabular-nums"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-10 w-10 rounded-md border-border"
                aria-label="Increase quantity"
                onClick={handleIncrement}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <p role="status" aria-live="polite" className="text-[11px] text-muted-foreground">
              {quantityNum > 0 ? (
                <>
                  After adjustment,{" "}
                  <InlineHighlight>{selectedLocationName}</InlineHighlight>{" "}
                  would have{" "}
                  <span
                    className={
                      adjustedQuantity < 0
                        ? "text-destructive font-semibold"
                        : "text-positive font-semibold"
                    }
                  >
                    {adjustedQuantity} units
                  </span>
                  .
                </>
              ) : null}
            </p>
          </div>

          {/* T5 (pack REV-3): a POSITIVE delta here is stock arriving with no
              receipt behind it. The prompt offers /receiving once per session
              and never blocks — declining submits the identical adjustment. */}
          <ReceivingRedirectPrompt active={adjustmentType === "add" && quantityNum > 0} />

          {/* Reason */}
          <div className="space-y-2">
            <Label htmlFor="reason">Reason (required)</Label>
            <Input
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g., Damaged goods, Inventory count, Customer return"
            />
          </div>

          {/* W2-1 (T7): the intent chip, replacing the coded-reason select.
              Skippable — Confirm below never reads it. */}
          <IntentChip
            surface="adjust"
            value={intent}
            onChange={handleIntentChange}
            disabled={isSubmitting}
          />

          {/* P2-B3-1: the capture — ONLY on a Remove under `order`. Pick the
              order from the search, or type its number; never both. */}
          {captureActive && (
            <div className="space-y-4" data-testid="order-capture">
              <OrderLookup
                value={pickedOrder}
                onChange={setPickedOrder}
                disabled={isSubmitting}
              />

              <div className="space-y-2">
                <Label htmlFor="order-reference">Or type the order number</Label>
                <Input
                  id="order-reference"
                  value={orderReference}
                  onChange={(e) => setOrderReference(e.target.value)}
                  placeholder="e.g. 12345"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={40}
                  aria-invalid={referenceShapeInvalid}
                  aria-describedby={referenceShapeInvalid ? "order-reference-hint" : undefined}
                  disabled={isSubmitting}
                />
                {referenceShapeInvalid && (
                  <p id="order-reference-hint" className="text-[11px] text-destructive">
                    {ORDER_REFERENCE_HINT}
                  </p>
                )}
              </div>

              {captureConflict && (
                <p role="alert" data-testid="order-capture-conflict" className="text-sm text-destructive">
                  {CAPTURE_BOTH_SENTENCE}
                </p>
              )}
            </div>
          )}

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">Additional Notes (optional)</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any additional details..."
              rows={3}
            />
          </div>
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
            onClick={handleSubmit}
            disabled={!isValid || isSubmitting}
          >
            {isSubmitting ? "Adjusting..." : "Confirm Adjustment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
