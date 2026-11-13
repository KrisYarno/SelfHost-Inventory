"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Plus, Minus, Package, MapPin } from "lucide-react";
import { useLocation } from "@/contexts/location-context";
import { useProductLocationQuantity } from "@/hooks/use-product-location-quantity";
import { useAdjustInventory, type ApiMutationError } from "@/hooks/use-inventory-mutations";
import { useSubmitLatch } from "@/hooks/use-submit-latch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ValueChip } from "@/components/ui/value-chip";
import { ContextTag } from "@/components/ui/context-tag";
import { ReceivingRedirectPrompt } from "@/components/inventory/receiving-redirect-prompt";
import { IntentChip } from "@/components/inventory/intent-chip";
import { OrderNumberField, type OrderCapture } from "@/components/inventory/order-number-field";
import type { DeductionIntent } from "@/lib/inventory/intent";
import { SELECTED_ORDER_REJECTED_SENTENCE } from "@/lib/orders/order-capture-sentences";
import { ORDER_REFERENCE_SHAPE } from "@/lib/orders/order-reference-shape";
import { cn } from "@/lib/utils";
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
//
// Reconciliation Part 2, § P2-B3-1R (R-b.2): the dialog, phone first. It opens
// on Remove; a Remove under the `order` chip names its order in ONE field
// (`OrderNumberField`), picked → `selectedExternalOrderId`, typed →
// `orderReference`, never both; one optional Note replaces the required Reason
// (`reason` is never sent). The hosts MOUNT IT PER OPEN (the inventory and
// products pages render it only while their product is set, and null the
// product on close), so every open starts from an empty draft and nothing
// typed for one product can reach another's removal: the FR2/FR3
// product-tagged capture is gone with the shared mount it guarded against.
// Every sentence below is the pack's, byte for byte.

/** The largest quantity the field can hold (`maxLength={6}`). */
const MAX_QUANTITY = 999_999;

/** `unit` when the count is 1, `units` otherwise. */
function unitWord(count: number): string {
  return count === 1 ? "unit" : "units";
}

/**
 * The ledger row the 200 carries (`log`), or `null` when the answer has none
 * that can be read — a body that did not parse arrives here as `{}`. Without
 * it nothing can be said about a link either way (FR-R1 (7), CR-OC-5).
 */
function readableLog(result: unknown): { orderRecordId?: unknown } | null {
  const log = (result as { log?: unknown } | null | undefined)?.log;
  return typeof log === "object" && log !== null ? (log as { orderRecordId?: unknown }) : null;
}

/** The stored order id the server stamped the ledger row with (`log.orderRecordId` on the 200). */
function stampedOrderId(result: unknown): string | null {
  const log = readableLog(result);
  return typeof log?.orderRecordId === "string" ? log.orderRecordId : null;
}

/**
 * A picked order the save could not use: the ONE 400 the resolver answers when
 * it can no longer be used (`resolve-selected-order.ts`), or the lock's 409
 * `ORDER_GONE` when it vanished between that check and the write (FR-R1 (3),
 * CR-OC-4). Both get the same recovery.
 */
function isRejectedPick(error: unknown): boolean {
  const err = error as ApiMutationError | null | undefined;
  if (!(err instanceof Error)) return false;
  return (
    (err.code === "VALIDATION_ERROR" && err.message === SELECTED_ORDER_REJECTED_SENTENCE) ||
    err.code === "ORDER_GONE"
  );
}

export function QuickAdjustDialog({
  open,
  onOpenChange,
  product,
  onSuccess,
}: QuickAdjustDialogProps) {
  const { selectedLocationId, locations } = useLocation();
  // Default Remove (row 106): most adjustments here are stock leaving.
  const [direction, setDirection] = useState<"remove" | "add">("remove");
  // Digits only, as typed: the field refuses anything else.
  const [quantity, setQuantity] = useState("");
  const [quantityRefused, setQuantityRefused] = useState(false);
  // null = the operator has not tapped the chip. Deliberately NOT pre-filled
  // with "other": the request must be able to say "nothing was stated", and a
  // default selection would make every untouched adjustment look answered.
  const [intent, setIntent] = useState<DeductionIntent | null>(null);
  // The capture: HIDDEN, not cleared, when the direction or the chip leaves
  // Remove + `order` (R107-OC-16 / G1-13). The body and the footer read it only
  // under Remove + `order`, so a hidden capture is never sent and never blocks.
  const [capture, setCapture] = useState<OrderCapture>({ text: "", picked: null });
  const [notes, setNotes] = useState("");
  // The rejected pick's notice (non-blocking): which of its two sentences, or
  // none. Cleared by the next edit.
  const [rejectedPick, setRejectedPick] = useState<"number" | "none" | null>(null);
  // The order field takes focus only right after the chip is changed to `order`.
  const focusOrderFieldRef = useRef(false);
  useEffect(() => {
    focusOrderFieldRef.current = false;
  });

  const quantityQuery = useProductLocationQuantity(product.id, selectedLocationId, {
    enabled: open,
  });
  const adjustMutation = useAdjustInventory();
  // The shared submit latch (§ P2-B3-1R, M-a.1): one write per tap, and no
  // dismissal while it is in flight. Its ref is set before the request starts
  // and cleared when it settles, failed or not (FD3-1, FD4-1); `busy` is the
  // same fact for rendering (the frozen form, the "…ing" label).
  const { busy, run, guardOpenChange } = useSubmitLatch();

  const isRemove = direction === "remove";
  const verb = isRemove ? "Remove" : "Add";
  const q = quantity === "" ? null : Number(quantity);
  const unitsPhrase = q === null ? "units" : `${q} ${unitWord(q)}`;
  const location =
    selectedLocationId === null
      ? null
      : (locations.find((loc) => loc.id === selectedLocationId)?.name ?? "Selected location");
  // Stock is KNOWN only on a successful read: loading and failure are their own
  // states, never 0 (row 105, #7). The server's availability check decides.
  const knownStock =
    selectedLocationId !== null && quantityQuery.status === "success" ? quantityQuery.data : null;

  const captureLive = isRemove && intent === "order";
  const sentPick = captureLive ? capture.picked : null;
  const textWellShaped = capture.text !== "" && ORDER_REFERENCE_SHAPE.test(capture.text);
  const sentReference =
    captureLive && capture.picked === null && textWellShaped ? capture.text : null;
  // The pack's one named exception to "never block": text in the live order
  // field that is not an order number keeps arbitrary free text out of
  // `details.orderReference` until it is fixed or cleared (G1-12).
  const captureIllShaped =
    captureLive && capture.picked === null && capture.text !== "" && !textWellShaped;

  const blockers: string[] = [];
  if (selectedLocationId === null) {
    blockers.push("Close this and choose a location at the top of the page.");
  }
  if (q === null || q === 0) blockers.push("Enter how many units.");
  if (isRemove && knownStock !== null && q !== null && q > knownStock) {
    blockers.push(
      `You can't remove more than the ${knownStock} ${unitWord(knownStock)} on record at ${location}.`,
    );
  }
  if (captureIllShaped) blockers.push("Order number: digits only — fix it or clear it.");

  const draftNonEmpty =
    quantity !== "" ||
    capture.text !== "" ||
    capture.picked !== null ||
    notes !== "" ||
    intent !== null;

  const summary = `${verb} ${unitsPhrase} of ${product.name}${location !== null ? ` at ${location}` : ""}`;
  const actionLabel = busy ? `${isRemove ? "Removing" : "Adding"} ${unitsPhrase}…` : `${verb} ${unitsPhrase}`;
  const orderLine = !captureLive
    ? null
    : capture.picked !== null
      ? `Order ${capture.picked.orderNumber} · ${capture.picked.store}`
      : textWellShaped
        ? `Order number to save: ${capture.text}`
        : capture.text === ""
          ? "No order number — this removal won't be linked to an order."
          : null;
  const rejectedNotice =
    rejectedPick === null
      ? null
      : rejectedPick === "number"
        ? `That order can't be used anymore — tap "${verb} ${unitsPhrase}" again to save the number; it links only if one order with that number is found.`
        : `That order can't be used anymore — tap "${verb} ${unitsPhrase}" again to save without an order number.`;
  const message = blockers[0] ?? rejectedNotice;

  const preview =
    knownStock !== null && location !== null && q !== null && q >= 1
      ? knownStock + (isRemove ? -q : q)
      : null;

  // Cancel and the X discard (the host unmounts the dialog); while a save is in
  // flight the guard drops them, as it drops Escape and a click outside. It
  // reads the latch's synchronous ref (FD3-1). The request's own answer still
  // closes the dialog — `handleSubmit` calls the host's RAW `onOpenChange`,
  // never this guard, which would drop it — and a failed one leaves it open.
  const handleOpenChange = guardOpenChange(onOpenChange);

  /** Any edit clears the rejected pick's notice. */
  const edited = () => setRejectedPick(null);

  const handleDirectionChange = (next: "remove" | "add") => {
    setDirection(next);
    edited();
  };

  const handleQuantityInput = (raw: string) => {
    if (!/^[0-9]*$/.test(raw)) {
      // REFUSED: the value stays as it was, and the field says why.
      setQuantityRefused(true);
      return;
    }
    const next = raw.replace(/^0+(?=[0-9])/, "");
    setQuantity(next);
    if (next === "") setQuantityRefused(false);
    edited();
  };

  const handleIncrement = () => {
    setQuantity((prev) => String(Math.min((prev === "" ? 0 : Number(prev)) + 1, MAX_QUANTITY)));
    edited();
  };

  const handleDecrement = () => {
    if (q === null || q <= 1) return;
    setQuantity(String(q - 1));
    edited();
  };

  const handleIntentChange = (next: DeductionIntent) => {
    if (next === "order" && intent !== "order") focusOrderFieldRef.current = true;
    setIntent(next);
    edited();
  };

  const handleCaptureChange = (next: OrderCapture) => {
    setCapture(next);
    edited();
  };

  const handleNotesChange = (next: string) => {
    setNotes(next);
    edited();
  };

  const handleSubmit = async () => {
    if (blockers.length > 0 || selectedLocationId === null || q === null) return;
    const delta = isRemove ? -q : q;
    const sentNotes = notes.trim();

    try {
      // One removal per tap: a second tap before the label changes would
      // otherwise send a second request (B3-1 FD3-1). `run` answers it
      // `undefined` while this one holds the latch, and releases the latch when
      // the request settles, failed or not (FD4-1), before the lines below run.
      const settled = await run(async () => ({
        result: await adjustMutation.mutateAsync({
          productId: product.id,
          locationId: selectedLocationId,
          delta,
          // The Note; `reason` is never sent.
          ...(sentNotes !== "" ? { notes: sentNotes } : {}),
          // The intent only on Remove, and absent (not null) when the chip was
          // never tapped — the route reads key PRESENCE to tell "unstated"
          // from "stated as other".
          ...(isRemove && intent !== null ? { intent } : {}),
          // The identity only on Remove + `order`: the picked id XOR the typed
          // number. Absent keys, never empty values.
          ...(sentPick !== null
            ? { selectedExternalOrderId: sentPick.id }
            : sentReference !== null
              ? { orderReference: sentReference }
              : {}),
        }),
      }));
      if (settled === undefined) return;
      const { result } = settled;

      const units = `${q} ${unitWord(q)}`;
      if (!isRemove) {
        toast.success(`Added ${units} of ${product.name} at ${location}.`);
      } else if (readableLog(result) === null) {
        // A 200 whose ledger row can't be read: the removal happened, and
        // nothing is known about a link — so nothing is claimed (FR-R1 (7)).
        toast.success(`Removed ${units} of ${product.name} at ${location}.`);
      } else if (intent !== "order") {
        toast.success(`Removed ${units} of ${product.name} at ${location}.`);
      } else if (sentPick === null && sentReference === null) {
        toast.success(`Removed ${units} of ${product.name} at ${location} — not linked to an order.`);
      } else if (stampedOrderId(result) !== null) {
        toast.success(
          `Removed ${units} of ${product.name} — linked to order ${sentPick?.orderNumber ?? sentReference}.`,
        );
      } else if (sentReference !== null) {
        // ONE sentence for every way a typed number did not land — unmatched,
        // ambiguous, not yours, unusable, or the lookup failing. The removal
        // itself succeeded, and the number is on its audit event. Held for 10 s
        // (the house idiom for a toast that must be read).
        toast(
          `Removed ${units} of ${product.name}. Order ${sentReference} wasn't linked — the number is saved so an admin can link it later.`,
          { duration: 10000 },
        );
      } else {
        // A pick the server did not stamp: never said as linked, and its number
        // is not on the event (only a typed number is), so nothing is promised.
        toast.success(`Removed ${units} of ${product.name} at ${location} — not linked to an order.`);
      }

      // The host's RAW callback, never the guard (`handleOpenChange`), which
      // drops a close while a submit holds the latch.
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      if (sentPick !== null && isRejectedPick(error)) {
        // The picked order can't be used anymore (deleted, or no longer the
        // operator's). No error toast: keep the number when it is one, drop the
        // pick, and let the next tap save the number — which the server then
        // resolves like any typed number (it links only on one match).
        const text = ORDER_REFERENCE_SHAPE.test(sentPick.orderNumber) ? sentPick.orderNumber : "";
        setCapture({ text, picked: null });
        setRejectedPick(text === "" ? "none" : "number");
        return;
      }
      console.error("Error adjusting inventory:", error);
      toast.error(error instanceof Error ? error.message : "Failed to adjust inventory");
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-[500px] max-h-[85dvh]"
        aria-describedby={undefined}
        // A non-empty draft is not thrown away by a stray Escape or a tap
        // outside; Cancel and the X still discard it.
        onEscapeKeyDown={(event) => {
          if (draftNonEmpty) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (draftNonEmpty) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Adjust stock</DialogTitle>
        </DialogHeader>

        {/* Product Info */}
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Package className="h-4 w-4" />
            <span>Product</span>
          </div>
          <h4 className="mt-1 text-base font-semibold">{product.name}</h4>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs" data-testid="adjust-stock">
            {location !== null && (
              <ContextTag icon={<MapPin className="h-3 w-3 text-muted-foreground" />}>
                {location}
              </ContextTag>
            )}
            {selectedLocationId === null ? (
              <span className="text-muted-foreground">No location selected.</span>
            ) : quantityQuery.status === "error" ? (
              <span className="text-destructive">
                Couldn&apos;t read current stock — it will be checked when you save.
              </span>
            ) : knownStock !== null ? (
              <ValueChip tone={knownStock > 0 ? "positive" : knownStock < 0 ? "negative" : "neutral"}>
                {`${knownStock} ${unitWord(knownStock)}`}
              </ValueChip>
            ) : (
              <span className="text-muted-foreground">Reading stock…</span>
            )}
          </div>
        </div>

        {/* While saving, the WHOLE form is frozen (row 105, #13). */}
        <fieldset disabled={busy} className="min-w-0">
          <div className="space-y-4">
            <div className="space-y-4">
              {/* Direction: a segmented Remove | Add, Remove first. */}
              <div
                role="group"
                aria-label="Remove or add"
                className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/30 p-1"
              >
                {(["remove", "add"] as const).map((value) => (
                  <Button
                    key={value}
                    type="button"
                    variant={direction === value ? "default" : "ghost"}
                    aria-pressed={direction === value}
                    className="min-h-[44px]"
                    onClick={() => handleDirectionChange(value)}
                  >
                    {value === "remove" ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                    {value === "remove" ? "Remove" : "Add"}
                  </Button>
                ))}
              </div>

              {/* Quantity */}
              <div className="space-y-2">
                <Label htmlFor="quantity" className="text-xs font-medium text-muted-foreground">
                  {isRemove ? "Units to remove" : "Units to add"}
                </Label>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-11 w-11 shrink-0 rounded-md border-border"
                    aria-label="Decrease quantity"
                    onClick={handleDecrement}
                    disabled={q === null || q <= 1}
                  >
                    <Minus className="h-4 w-4" />
                  </Button>
                  <Input
                    id="quantity"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={6}
                    value={quantity}
                    onChange={(e) => handleQuantityInput(e.target.value)}
                    onBlur={() => setQuantityRefused(false)}
                    className="h-11 flex-1 text-center text-lg font-semibold tabular-nums"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-11 w-11 shrink-0 rounded-md border-border"
                    aria-label="Increase quantity"
                    onClick={handleIncrement}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                {quantityRefused && (
                  <p role="status" data-testid="quantity-refused" className="text-[11px] text-destructive">
                    Whole units only.
                  </p>
                )}
                {preview !== null && (
                  <p data-testid="quantity-preview" className="text-[11px] text-muted-foreground">
                    After this, {location} will have{" "}
                    <span
                      className={cn(
                        "font-semibold",
                        preview < 0 ? "text-destructive" : "text-positive",
                      )}
                    >
                      {`${preview} ${unitWord(preview)}`}
                    </span>
                    .
                  </p>
                )}
              </div>

              {/* W2-1 (T7): the intent chip — on Remove only. Skippable; it never
                  blocks the save. */}
              {isRemove && (
                <IntentChip
                  surface="adjust"
                  layout="row"
                  value={intent}
                  onChange={handleIntentChange}
                  disabled={busy}
                />
              )}

              {/* The capture: ONLY on a Remove under `order`. */}
              {captureLive && (
                <OrderNumberField
                  productId={product.id}
                  quantity={q}
                  value={capture}
                  onChange={handleCaptureChange}
                  disabled={busy}
                  focusOnMount={focusOrderFieldRef.current}
                />
              )}

              {/* T5 (pack REV-3): a POSITIVE delta here is stock arriving with no
                  receipt behind it. The prompt offers /receiving once per session
                  and never blocks — declining submits the identical adjustment. */}
              {!isRemove && <ReceivingRedirectPrompt active={q !== null && q > 0} />}

              {/* The Note: optional, shown in the product's history to admins and its author. */}
              <div className="space-y-2">
                <Label htmlFor="note">Note (optional)</Label>
                <Textarea
                  id="note"
                  value={notes}
                  onChange={(e) => handleNotesChange(e.target.value)}
                  placeholder="Anything someone reviewing this should know"
                  maxLength={2000}
                  rows={3}
                  aria-describedby="note-helper"
                />
                <p id="note-helper" className="text-[11px] text-muted-foreground">
                  Seen by admins and by you.
                </p>
              </div>
            </div>

            {/* The sticky footer: what the tap will do, and the tap. */}
            <div
              data-testid="adjust-footer"
              className="sticky bottom-0 -mx-4 px-4 sm:-mx-6 sm:px-6 -mb-4 pb-4 sm:-mb-6 sm:pb-6 bg-background border-t pt-3"
            >
              <p data-testid="adjust-summary" className="break-words text-sm font-medium">
                {summary}
              </p>
              {orderLine !== null && (
                <p data-testid="adjust-order-line" className="break-words text-[11px] text-muted-foreground">
                  {orderLine}
                </p>
              )}
              {message !== null && (
                <p
                  data-testid="adjust-message"
                  role="status"
                  aria-live="polite"
                  className={cn(
                    "mt-1 break-words text-[11px]",
                    blockers.length > 0 ? "text-destructive" : "text-warning",
                  )}
                >
                  {message}
                </p>
              )}
              <div className="mt-3 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-[44px]"
                  onClick={() => handleOpenChange(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  className="min-h-[44px]"
                  onClick={handleSubmit}
                  disabled={blockers.length > 0 || busy}
                >
                  {actionLabel}
                </Button>
              </div>
            </div>
          </div>
        </fieldset>
      </DialogContent>
    </Dialog>
  );
}
