"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Plus, Minus, Package, MapPin } from "lucide-react";
import { useLocation } from "@/contexts/location-context";
import { useProductLocationQuantity } from "@/hooks/use-product-location-quantity";
import { useAdjustInventory } from "@/hooks/use-inventory-mutations";
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

/** The capture's two inputs, stored WITH the id of the product they were entered under. */
interface Capture {
  productId: number;
  picked: PickedOrder | null;
  reference: string;
}

/** What any OTHER product's capture reads as: nothing. */
const NO_CAPTURE: Pick<Capture, "picked" | "reference"> = { picked: null, reference: "" };

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
  //
  // ...and an identity belongs to ONE product's removal, BY CONSTRUCTION (B3-1
  // FR3, Q/A B3-1-QA-1). The inventory page keeps this dialog mounted and swaps
  // `product` under it (B3-1 FR1, CR-1), so the capture is stored WITH the id
  // of the product it was entered under, and everything the dialog shows or
  // sends reads `ownCapture`: another product's capture reads as empty. Every
  // write tags the product of the render it came from, so even a stale update
  // React replays later — FR2's render-phase reset lost exactly that race —
  // carries its own product's id and cannot surface under another.
  //
  // Keyed on the id, never the object: the page builds a fresh object on every
  // open, and reopening the SAME product keeps the capture. A capture entered
  // under A and still in state also reappears if the dialog goes back to A,
  // which is right: it belongs to A. The other remembered fields are out of
  // scope here.
  const [capture, setCapture] = useState<Capture>({
    productId: product.id,
    picked: null,
    reference: "",
  });
  const ownCapture = capture.productId === product.id ? capture : NO_CAPTURE;

  const quantityQuery = useProductLocationQuantity(product.id, selectedLocationId, {
    enabled: open,
  });
  const adjustMutation = useAdjustInventory();
  const isSubmitting = adjustMutation.isPending;
  // The SYNCHRONOUS half of "a submit is in flight" (B3-1 FD3-1), now the
  // shared submit latch (§ P2-B3-1R, M-a.1). The rendered `isPending` lags the
  // request — TanStack notifies its observers on a later task — so in the
  // instant after Confirm a dismissal, or a second Confirm, would pass a guard
  // that read only the render. The latch's ref is set before the request
  // starts and cleared when it settles.
  const { run, guardOpenChange } = useSubmitLatch();

  const currentQuantity = quantityQuery.data ?? 0;
  const quantityNum = parseInt(quantity, 10) || 0;
  const adjustedQuantity = adjustmentType === "add"
    ? currentQuantity + quantityNum
    : currentQuantity - quantityNum;
  const selectedLocationName =
    locations.find((loc) => loc.id === selectedLocationId)?.name ?? "Selected location";

  const captureActive = adjustmentType === "remove" && intent === "order";
  const trimmedReference = ownCapture.reference.trim();
  const sentPick = captureActive ? ownCapture.picked : null;
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

  // A submit in flight cannot be dismissed (B3-1 FR3, FD2-3): Escape, a click
  // outside and the close button all reach Radix's `onOpenChange(false)`, so
  // this one guard covers the three, and Cancel goes through it too (it is
  // also disabled once "Adjusting..." renders). It reads the latch's
  // synchronous ref (FD3-1). The request's own answer still closes the dialog —
  // `handleSubmit` calls the host's raw `onOpenChange`, never this guard,
  // which would drop it — and a failed one leaves it open, as ever.
  const handleOpenChange = guardOpenChange(onOpenChange);

  const clearCapture = () => {
    setCapture({ productId: product.id, picked: null, reference: "" });
  };

  // Each half survives the other's write only if it was entered under THIS
  // product — the functional update reads what is in state, not this render.
  const handlePick = (next: PickedOrder | null) => {
    setCapture((prev) => ({
      productId: product.id,
      picked: next,
      reference: prev.productId === product.id ? prev.reference : "",
    }));
  };

  const handleReferenceChange = (next: string) => {
    setCapture((prev) => ({
      productId: product.id,
      picked: prev.productId === product.id ? prev.picked : null,
      reference: next,
    }));
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
      // One removal per Confirm: a second click before "Adjusting..." renders
      // would otherwise send a second request (B3-1 FD3-1). `run` answers it
      // `undefined` while this one holds the latch, and releases the latch when
      // the request settles, failed or not (FD4-1), before the lines below run.
      const settled = await run(async () => ({
        result: await adjustMutation.mutateAsync({
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
        }),
      }));
      if (settled === undefined) return;
      const { result } = settled;

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

      // The host's RAW callback, never the guard (`handleOpenChange`), which
      // drops a close while a submit holds the latch.
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
    <Dialog open={open} onOpenChange={handleOpenChange}>
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
                value={ownCapture.picked}
                onChange={handlePick}
                disabled={isSubmitting}
              />

              <div className="space-y-2">
                <Label htmlFor="order-reference">Or type the order number</Label>
                <Input
                  id="order-reference"
                  value={ownCapture.reference}
                  onChange={(e) => handleReferenceChange(e.target.value)}
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
            onClick={() => handleOpenChange(false)}
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
