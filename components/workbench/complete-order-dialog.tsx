"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkbench } from "@/hooks/use-workbench";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import { invalidateInventoryCaches } from "@/hooks/use-inventory-mutations";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { AlertCircle, AlertTriangle, Check, CheckCircle2, Package } from "lucide-react";
import { useLocation } from "@/contexts/location-context";
import { getUserFriendlyMessage } from "@/lib/error-handling";
import {
  SKIPPED_LINE_CLASSES,
  SKIPPED_LINE_COPY,
  SKIPPED_LINE_LABEL,
  classifySkippedLine,
} from "@/lib/workbench/skipped-lines";

// ---------------------------------------------------------------------------
// W0.5-a (contract pack T6): the skipped-line checklist.
//
// The three classes `unmappedExternalItems` mixes, the copy each one gets, and
// the detection rule all live in lib/workbench/skipped-lines.ts — extracted at
// W1-4b so this dialog and the page-level UnmappedItemsAlert cannot tell the
// same array's story two different ways (the registered W0.5-a divergence).
// ---------------------------------------------------------------------------

export interface DeductionDetail {
  productId: number;
  productName: string;
  quantity: number;
  locationId: number;
  fulfillmentItemId?: string;  // For WC order undo via unfulfill API
}

interface CompleteOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (details: {
    orderReference: string;
    items: DeductionDetail[];
    externalOrderId?: string;
  }) => void;
}

export function CompleteOrderDialog({
  open,
  onOpenChange,
  onSuccess,
}: CompleteOrderDialogProps) {
  const router = useRouter();
  const {
    orderItems,
    orderReference,
    clearOrder,
    getTotalQuantity,
    isProcessing,
    setIsProcessing,
    selectedExternalOrder,
    unmappedExternalItems,
  } = useWorkbench();
  const { selectedLocationId } = useLocation();
  const { token: csrfToken, isLoading: csrfLoading } = useCSRF();
  const queryClient = useQueryClient();

  const isWCOrder = !!selectedExternalOrder;

  // Amendment 2: Split cart items by source for dual API calls
  const { wcItems, manualItems } = useMemo(() => {
    const wc = orderItems.filter((item) => item.fulfillmentItemId);
    const manual = orderItems.filter((item) => !item.fulfillmentItemId);
    return { wcItems: wc, manualItems: manual };
  }, [orderItems]);

  // W0.5-a (T6): the skipped lines, classified, plus the per-line
  // acknowledgements. Acknowledgement is LOCAL state only — nothing is
  // persisted, and no request carries it.
  const [acknowledgedLines, setAcknowledgedLines] = useState<string[]>([]);

  const skippedLines = useMemo(
    () =>
      unmappedExternalItems.map((item, idx) => ({
        // externalItemId is stamped on every push; the index is the fallback.
        key: item.externalItemId ?? `line-${idx}`,
        item,
        lineClass: classifySkippedLine(item),
      })),
    [unmappedExternalItems]
  );

  // Bundles are informational — they are excluded from the tap count.
  const tapRequiredKeys = useMemo(
    () => skippedLines.filter((line) => line.lineClass !== "bundle").map((line) => line.key),
    [skippedLines]
  );
  const acknowledgedCount = tapRequiredKeys.filter((key) =>
    acknowledgedLines.includes(key)
  ).length;
  const allAcknowledged = acknowledgedCount === tapRequiredKeys.length;

  // Reopening the dialog RESETS the taps. Intended friction: an operator who
  // backs out and comes back re-reads what is about to ship undeducted.
  useEffect(() => {
    setAcknowledgedLines([]);
  }, [open]);

  const toggleAcknowledged = (key: string) => {
    setAcknowledgedLines((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };

  const handleComplete = async () => {
    if (!csrfToken) {
      toast.error("Secure session is still initializing. Please wait a moment and try again.");
      return;
    }

    if (!orderReference.trim()) {
      toast.error("Order reference is required");
      return;
    }

    if (!selectedLocationId) {
      toast.error("Please select a location");
      return;
    }

    setIsProcessing(true);

    // P0-2: Track WC fulfillment for rollback. If the subsequent manual deduct
    // fails, we use this to call unfulfill and restore the WC inventory, so the
    // user always sees a clean all-or-nothing transaction.
    let wcFulfilled = false;

    try {
      // Amendment 2: Dual API call for mixed carts
      // 1. Fulfill WC items via fulfillment API
      if (isWCOrder && wcItems.length > 0) {
        const fulfillResponse = await fetch(
          `/api/orders/${selectedExternalOrder.id}/fulfill`,
          {
            method: "POST",
            headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
            body: JSON.stringify({
              locationId: selectedLocationId,
              items: wcItems.map((item) => ({
                itemId: item.fulfillmentItemId,
                quantity: item.quantity,
              })),
            }),
          }
        );

        if (!fulfillResponse.ok) {
          const errorData = await fulfillResponse.json();
          if (errorData.error && typeof errorData.error === "object") {
            const error = new Error(errorData.error.message);
            (error as any).code = errorData.error.code;
            (error as any).context = errorData.error.context;
            throw error;
          }
          throw new Error(errorData.error || "Failed to fulfill WC order");
        }

        await fulfillResponse.json();
        wcFulfilled = true;
      }

      // 2. Deduct manual items via deduct-simple API
      if (manualItems.length > 0) {
        const deductRequest = {
          orderReference: orderReference.trim(),
          locationId: selectedLocationId,
          items: manualItems.map((item) => ({
            productId: item.product.id,
            quantity: item.quantity,
          })),
          // Phase 0b-2: send the external order this cart is being packed
          // against so the deduction can later be attributed to it. The dialog
          // already holds it; the server re-resolves it and checks membership
          // before recording. No UX change — omitted for a non-WC order.
          ...(selectedExternalOrder ? { selectedExternalOrderId: selectedExternalOrder.id } : {}),
        };

        const deductResponse = await fetch("/api/inventory/deduct-simple", {
          method: "POST",
          headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
          body: JSON.stringify(deductRequest),
        });

        if (!deductResponse.ok) {
          // P0-2: Manual deduct failed AFTER WC fulfill succeeded. Roll back the
          // WC portion by calling unfulfill, otherwise we leave the user with
          // deducted WC inventory and no undo path. The rollback is best-effort
          // but logged prominently if it fails.
          if (wcFulfilled && selectedExternalOrder) {
            try {
              const rollbackResponse = await fetch(
                `/api/orders/${selectedExternalOrder.id}/unfulfill`,
                {
                  method: "POST",
                  headers: withCSRFHeaders(
                    { "Content-Type": "application/json" },
                    csrfToken
                  ),
                  body: JSON.stringify({
                    items: wcItems.map((item) => ({
                      itemId: item.fulfillmentItemId,
                      productId: item.product.id,
                      quantity: item.quantity,
                      locationId: selectedLocationId,
                    })),
                    notes: "Auto-rollback: manual item deduction failed after WC fulfillment",
                  }),
                }
              );

              if (!rollbackResponse.ok) {
                // Rollback failed — this is a data-integrity incident. Surface it
                // to the user with the order ID so they can investigate manually.
                const rollbackError = await rollbackResponse.json().catch(() => ({}));
                console.error(
                  `CRITICAL: WC rollback failed for order ${selectedExternalOrder.id}:`,
                  rollbackError
                );
                toast.error(
                  <div className="space-y-1">
                    <p className="font-medium">Rollback failed</p>
                    <p className="text-sm">
                      WC order #{selectedExternalOrder.orderNumber} was fulfilled but
                      manual items failed. Rollback also failed. Please check
                      inventory manually for order {selectedExternalOrder.id}.
                    </p>
                  </div>,
                  { duration: 15000 }
                );
              } else {
                wcFulfilled = false; // rollback succeeded
              }
            } catch (rollbackError) {
              console.error(
                `CRITICAL: WC rollback threw for order ${selectedExternalOrder.id}:`,
                rollbackError
              );
            }
          }

          const errorData = await deductResponse.json();
          if (errorData.error && typeof errorData.error === "object") {
            const { message, code, context } = errorData.error;
            const error = new Error(message);
            (error as any).code = code;
            (error as any).context = context;
            throw error;
          }
          throw new Error(errorData.error || "Failed to process order");
        }

        await deductResponse.json();
      }

      // Capture deduction details BEFORE clearing (includes fulfillmentItemId for undo)
      const deductionDetails: DeductionDetail[] = orderItems.map((item) => ({
        productId: item.product.id,
        productName: item.product.name,
        quantity: item.quantity,
        locationId: selectedLocationId!,
        fulfillmentItemId: item.fulfillmentItemId,
      }));
      const completedOrderRef = orderReference;
      const externalOrderId = selectedExternalOrder?.id;

      // Clear the order and close dialog
      clearOrder();
      onOpenChange(false);

      // Refresh the page to update product quantities
      router.refresh();

      // Cross-page coherence: the deduct/fulfill above went through raw fetch,
      // so react-query caches (/inventory, dashboard, journal) must be told.
      invalidateInventoryCaches(queryClient);

      // Call the onSuccess callback with deduction details for undo support
      if (onSuccess) {
        onSuccess({
          orderReference: completedOrderRef,
          items: deductionDetails,
          externalOrderId,
        });
      }
    } catch (error) {
      console.error("Error processing order:", error);

      // Generate user-friendly error message
      const friendlyError = getUserFriendlyMessage(error as Error);

      // Show detailed error with action
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

      // If it's an insufficient stock error, we might want to highlight the problematic items
      if ((error as any).code === 'INVENTORY_INSUFFICIENT_STOCK' && (error as any).context?.productName) {
        console.log('Insufficient stock for:', (error as any).context.productName);
      }
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isWCOrder ? "Complete & Fulfill Order" : "Complete Order"}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-4">
              <div>
                {isWCOrder
                  ? "This will deduct items from inventory and update the WC order status."
                  : "Are you sure you want to complete this order and deduct the items from inventory?"}
              </div>

              {/* WC Order Info Banner */}
              {isWCOrder && (
                <div className="rounded-lg border border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/30 p-3 space-y-1">
                  <div className="flex items-center gap-2">
                    <Package className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                    <span className="font-mono font-medium text-sm">
                      #{selectedExternalOrder.orderNumber}
                    </span>
                    <Badge variant="info" className="text-[10px] px-1.5 py-0">
                      WOO
                    </Badge>
                  </div>
                  {selectedExternalOrder.customerName && (
                    <p className="text-sm text-muted-foreground">
                      {selectedExternalOrder.customerName}
                      {selectedExternalOrder.total != null && (
                        <span className="ml-2 font-medium">
                          ${selectedExternalOrder.total.toFixed(2)}
                        </span>
                      )}
                    </p>
                  )}
                </div>
              )}

              {/* Order Summary */}
              <div className="rounded-lg border bg-muted/50 p-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="font-medium">Order Reference:</span>
                  <span className="font-mono">{orderReference}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="font-medium">Total Items:</span>
                  <span>{orderItems.length}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="font-medium">Total Quantity:</span>
                  <span>{getTotalQuantity()} units</span>
                </div>
              </div>

              {/* Item Details - Grouped for WC orders */}
              {isWCOrder && wcItems.length > 0 && (
                <div className="space-y-1">
                  <p className="text-sm font-medium flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
                    From Order ({wcItems.length})
                  </p>
                  <ul className="text-sm space-y-1 max-h-24 overflow-y-auto">
                    {wcItems.map((item, idx) => (
                      <li key={`wc-${item.fulfillmentItemId || idx}`} className="flex justify-between">
                        <span className="text-muted-foreground">
                          {item.product.name}
                        </span>
                        <span className="font-medium">{item.quantity}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {isWCOrder && manualItems.length > 0 && (
                <div className="space-y-1">
                  <p className="text-sm font-medium">Added Manually ({manualItems.length})</p>
                  <ul className="text-sm space-y-1 max-h-24 overflow-y-auto">
                    {manualItems.map((item) => (
                      <li key={`manual-${item.product.id}`} className="flex justify-between">
                        <span className="text-muted-foreground">
                          {item.product.name}
                        </span>
                        <span className="font-medium">{item.quantity}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Non-WC: show flat list (original behavior) */}
              {!isWCOrder && (
                <div className="space-y-1">
                  <p className="text-sm font-medium">Items to deduct:</p>
                  <ul className="text-sm space-y-1 max-h-32 overflow-y-auto">
                    {orderItems.map((item) => (
                      <li
                        // P2: use fulfillmentItemId as disambiguator when present,
                        // since Amendment 5 allows same-product entries with
                        // different sources to coexist.
                        key={item.fulfillmentItemId ?? `manual-${item.product.id}`}
                        className="flex justify-between"
                      >
                        <span className="text-muted-foreground">
                          {item.product.name}
                        </span>
                        <span className="font-medium">{item.quantity}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Skipped-line checklist (T6). Grouped by class, because the
                  three classes are three different truths: a bundle still
                  ships (from Order Details), the other two do not ship
                  deducted at all. Every non-bundle line has to be tapped
                  before Complete unlocks — the checklist never blocks the
                  completion itself, it only makes the operator see each line. */}
              {isWCOrder && skippedLines.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/30 p-3 space-y-2">
                  <div className="flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                    <span className="text-sm font-medium text-amber-700 dark:text-amber-300">
                      {skippedLines.length} line{skippedLines.length !== 1 ? "s" : ""} will not be deducted
                    </span>
                  </div>

                  {tapRequiredKeys.length > 0 && (
                    <p className="ml-5 text-xs text-amber-700 dark:text-amber-300">
                      Tap each flagged line to acknowledge ({acknowledgedCount} of{" "}
                      {tapRequiredKeys.length}).
                    </p>
                  )}

                  {SKIPPED_LINE_CLASSES.map((lineClass) => {
                    const lines = skippedLines.filter((line) => line.lineClass === lineClass);
                    if (lines.length === 0) return null;
                    return (
                      <div key={lineClass} className="ml-5 space-y-1">
                        <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                          {SKIPPED_LINE_LABEL[lineClass]} ({lines.length})
                        </p>
                        <ul className="space-y-1">
                          {lines.map(({ key, item }) => {
                            const detail = (
                              <span className="text-left">
                                {item.name} x{item.quantity}
                                {item.sku && <span className="ml-1 opacity-70">({item.sku})</span>}
                                <span className="ml-1 italic opacity-80">
                                  {SKIPPED_LINE_COPY[lineClass]}
                                </span>
                              </span>
                            );

                            // Bundles are informational: no tap, nothing to unlock.
                            if (lineClass === "bundle") {
                              return (
                                <li
                                  key={key}
                                  className="text-xs text-amber-600 dark:text-amber-400"
                                >
                                  {detail}
                                </li>
                              );
                            }

                            const isAcknowledged = acknowledgedLines.includes(key);
                            return (
                              <li key={key}>
                                <button
                                  type="button"
                                  role="checkbox"
                                  aria-checked={isAcknowledged}
                                  onClick={() => toggleAcknowledged(key)}
                                  disabled={isProcessing}
                                  // py-2 keeps the row a comfortable tap target
                                  // on the mobile workbench.
                                  className={`flex w-full items-start gap-2 rounded-md border px-2 py-2 text-xs transition-colors disabled:opacity-60 ${
                                    isAcknowledged
                                      ? "border-amber-400 bg-amber-100/70 text-amber-800 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-200"
                                      : "border-amber-300/70 text-amber-700 hover:bg-amber-100/50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-900/30"
                                  }`}
                                >
                                  <span
                                    aria-hidden="true"
                                    className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-amber-500 dark:border-amber-600"
                                  >
                                    {isAcknowledged && <Check className="h-3 w-3" />}
                                  </span>
                                  {detail}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Summary text */}
              {isWCOrder ? (
                <p className="text-sm text-muted-foreground">
                  This will deduct {getTotalQuantity()} unit{getTotalQuantity() !== 1 ? "s" : ""} and
                  update WC order #{selectedExternalOrder.orderNumber} status.
                  You can undo this within 10 seconds.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  You can undo this within 10 seconds after completion.
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isProcessing}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleComplete}
            // T6: the only new gate is the acknowledgement one, and it lifts
            // for good once every tap-required line has been tapped.
            disabled={isProcessing || csrfLoading || !csrfToken || !allAcknowledged}
          >
            {isProcessing
              ? "Processing..."
              : isWCOrder
              ? "Complete & Fulfill"
              : "Complete Order"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
