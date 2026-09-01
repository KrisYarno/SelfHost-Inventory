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
import { apiErrorMessage, readApiError } from "@/lib/api-error";
import { getUserFriendlyMessage } from "@/lib/error-handling";
import {
  CAP_COUNTER_FROM,
  MAX_FULFILLMENT_ITEMS,
  MAX_SIMPLE_DEDUCT_ITEMS,
} from "@/lib/inventory/request-limits";
import { primaryRefusal } from "@/lib/orders/refusal";
import {
  SKIPPED_LINE_CLASSES,
  SKIPPED_LINE_COPY,
  SKIPPED_LINE_LABEL,
  classifySkippedLine,
} from "@/lib/workbench/skipped-lines";
import { IntentChip } from "@/components/inventory/intent-chip";
import type { WorkbenchIntent } from "@/lib/inventory/intent";

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

/**
 * Reconciliation Part 2 (spec §2.7, pack CB1b.6 / seam S-B5): the batches this
 * completion wrote, one per LEG.
 *
 * A mixed cart is two movements — the WC lines go through fulfill, the manual
 * lines through deduct-simple — and each mints its own batch. The pair is
 * REQUEST-grain, not item-grain, which is why it rides the completion envelope
 * rather than `DeductionDetail`: every row a leg wrote carries that leg's id.
 * A leg that did not run is `null`, never `undefined` — "this cart had no manual
 * lines" is a fact the Undo has to be able to read.
 */
export type CompletionBatchIds = {
  deductSimpleBatchId: string | null;
  fulfilBatchId: string | null;
};

/**
 * One entry of the fulfil route's `results.fulfilled[]` (pack CB1.5c, seam
 * S-B15) — the lines the server says it ACTUALLY deducted, which is what a
 * rollback must be built from. Every field is optional at this seam because it
 * arrives as parsed JSON: the reader proves what it needs before using it.
 */
type FulfilledEntry = {
  itemId?: string;
  productId?: number;
  quantity?: number;
};

interface CompleteOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (details: {
    orderReference: string;
    items: DeductionDetail[];
    batchIds: CompletionBatchIds;
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

  // The request caps, client-side (pack CB1.5c / seam S-B10, the journal's
  // threshold-gated idiom). Each leg posts to its own route with its own cap, so
  // each is counted against its own owner constant; the counters appear before
  // the cap bites, and above it Complete is refused with a sentence that says
  // why rather than a 400 after the work is done.
  const wcOver = wcItems.length > MAX_FULFILLMENT_ITEMS;
  const manualOver = manualItems.length > MAX_SIMPLE_DEDUCT_ITEMS;
  const showWcCounter = wcItems.length > CAP_COUNTER_FROM;
  const showManualCounter = manualItems.length > CAP_COUNTER_FROM;

  // W0.5-a (T6): the skipped lines, classified, plus the per-line
  // acknowledgements. Acknowledgement is LOCAL state only — nothing is
  // persisted, and no request carries it.
  const [acknowledgedLines, setAcknowledgedLines] = useState<string[]>([]);

  // W2-1 (T7): the intent chip for the MANUAL leg. null = the operator has not
  // tapped it; what that MEANS depends on the surface (see effectiveIntent).
  const [intent, setIntent] = useState<WorkbenchIntent | null>(null);

  // The chip only has something to say when there is an order to attribute TO
  // and a manual line that would carry the attribution. WC lines are stamped
  // unconditionally by the fulfill route from the order it already resolved —
  // they need no operator input and get no chip.
  const showIntentChip = isWCOrder && manualItems.length > 0;

  // W2-2 RIDER (pack REV-12): on THIS surface the answer is already known — the
  // operator selected a WC order upstream and then added lines to that order's
  // cart, which is the From-Order-auto-locks premise. `order` is therefore the
  // PRE-SELECTED default here, not an unasked question: before this, an untapped
  // chip made ledger stamping opt-in on the one surface where the attribution is
  // least in doubt, and every skipped tap wrote an unattributed SALE row.
  //
  // Derived rather than seeded into state deliberately: `intent` keeps meaning
  // "what the operator explicitly said" and this keeps meaning "what will be
  // sent", so the pre-selection cannot go stale against a cart that changes
  // under it, and the dialog's reset needs no second rule.
  //
  // NOT a lock and NOT a gate: `other` is one tap away, Confirm never reads
  // either value, and a submit with zero chip interaction stays legal. Only the
  // starting position moved. Away from this surface (no WC order, or no manual
  // line to carry it) there is nothing to pre-select for, so the value stays
  // null and the request omits the key exactly as it always has.
  const effectiveIntent: WorkbenchIntent | null =
    intent ?? (showIntentChip ? "order" : null);

  // QA-13: derived under the SAME gate the checklist renders under. The list
  // and the gate on Complete have to be one fact — a checklist that is not on
  // screen cannot be acknowledged, so deriving the gate from the raw store
  // array meant any future path that left unmapped lines behind without a
  // selected order would disable Complete permanently, with nothing rendered to
  // explain it. Today's store clears both together; this stops depending on that.
  const skippedLines = useMemo(
    () =>
      isWCOrder
        ? unmappedExternalItems.map((item, idx) => ({
            // externalItemId is stamped on every push; the index is the fallback.
            key: item.externalItemId ?? `line-${idx}`,
            item,
            lineClass: classifySkippedLine(item),
          }))
        : [],
    [isWCOrder, unmappedExternalItems]
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
  // backs out and comes back re-reads what is about to ship undeducted. The
  // intent chip resets with them — a stale intent carried across a reopen would
  // attribute this deduction using an answer given about a different cart.
  // Clearing to null restores the surface's pre-selected default (W2-2 rider),
  // it does not clear the chip to "unstated".
  useEffect(() => {
    setAcknowledgedLines([]);
    setIntent(null);
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

    // Pack CB1.5c: the entries the fulfil route said it deducted. A rollback is
    // built from THESE, never from the cart — sending every requested line back
    // would credit stock for lines the server refused.
    let fulfilledEntries: FulfilledEntry[] = [];

    /**
     * Put the WC leg back (pack CB1.5c, seam S-B15). SINGLES-ONLY by contract:
     * the workbench cart cannot hold a bundle line (`use-workbench.ts`,
     * `lib/workbench/skipped-lines.ts`), so every entry here is a single with a
     * real productId. An entry without one is skipped from the body and NAMED
     * in the critical toast rather than guessed at — a belt over a stated
     * unreachable case (PKd-5/FVc-9).
     *
     * Returns true ONLY when the server restored every entry it was given:
     * a 2xx with `restored: []` is not a rollback, and the caller's choice of
     * error code turns on this answer.
     */
    const rollbackWcLeg = async (entries: FulfilledEntry[]): Promise<boolean> => {
      if (!selectedExternalOrder || !selectedLocationId || !csrfToken) return false;

      // Nothing to send is NOT a rollback: `restored.length === entries.length`
      // would read 0 === 0 and claim a full restoration of a leg still
      // deducted. Unreachable on today's wire — the route always sends
      // `results.fulfilled`, and a zero-fulfilled leg never gets here — so this
      // is a belt, and it fails to the uncoded (honest) branch.
      if (entries.length === 0) {
        console.error(
          `CRITICAL: WC rollback had no fulfilled entries to restore for order ${selectedExternalOrder.id}`
        );
        return false;
      }

      const unresolved: string[] = [];
      const items: Array<{
        itemId: string;
        productId: number;
        quantity: number;
        locationId: number;
      }> = [];

      entries.forEach((entry) => {
        // DCc-11: matched BY ITEM ID, never positionally — `results.fulfilled`
        // is not the cart, and an index-matched fallback would restore stock to
        // whichever product happened to sit at that offset.
        const cartLine = wcItems.find((item) => item.fulfillmentItemId === entry.itemId);
        const productId =
          typeof entry.productId === "number" && entry.productId > 0
            ? entry.productId
            : cartLine?.product.id;
        if (!entry.itemId || typeof productId !== "number" || productId <= 0) {
          unresolved.push(cartLine?.product.name ?? entry.itemId ?? "an unnamed line");
          return;
        }
        items.push({
          itemId: entry.itemId,
          productId,
          quantity: typeof entry.quantity === "number" ? entry.quantity : (cartLine?.quantity ?? 0),
          locationId: selectedLocationId,
        });
      });

      let restoredCount = 0;
      try {
        const rollbackResponse = await fetch(
          `/api/orders/${selectedExternalOrder.id}/unfulfill`,
          {
            method: "POST",
            headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
            body: JSON.stringify({
              items,
              notes: "Auto-rollback: the completion could not finish after WC fulfillment",
            }),
          }
        );

        if (rollbackResponse.ok) {
          // QB-4 (truthful data): a 200 can carry `restored: []`. Count it.
          const rollbackBody = (await rollbackResponse.json().catch(() => null)) as {
            restored?: unknown[];
          } | null;
          restoredCount = rollbackBody?.restored?.length ?? 0;
          if (restoredCount === entries.length && unresolved.length === 0) return true;
          console.error(
            `CRITICAL: WC rollback restored ${restoredCount} of ${entries.length} lines for order ${selectedExternalOrder.id}`
          );
        } else {
          // Rollback failed — this is a data-integrity incident. Surface it
          // to the user with the order ID so they can investigate manually.
          const rollbackError = await rollbackResponse.json().catch(() => ({}));
          console.error(
            `CRITICAL: WC rollback failed for order ${selectedExternalOrder.id}:`,
            rollbackError
          );
        }
      } catch (rollbackError) {
        console.error(
          `CRITICAL: WC rollback threw for order ${selectedExternalOrder.id}:`,
          rollbackError
        );
      }

      toast.error(
        <div className="space-y-1">
          <p className="font-medium">Rollback failed</p>
          <p className="text-sm">
            {`WC order #${selectedExternalOrder.orderNumber} was fulfilled but the completion could not finish, and the rollback restored only ${restoredCount} of ${entries.length} lines. Please check inventory manually for order ${selectedExternalOrder.id}.`}
          </p>
          {unresolved.length > 0 && (
            <p className="text-sm">
              {`Not sent for restoration (no product id): ${unresolved.join(", ")}.`}
            </p>
          )}
        </div>,
        { duration: 15000 }
      );
      return false;
    };

    // Reconciliation Part 2 (pack CB1b.6): the batch each leg wrote under, read
    // off the response rather than guessed. Null until that leg actually runs.
    const batchIds: CompletionBatchIds = {
      deductSimpleBatchId: null,
      fulfilBatchId: null,
    };

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
          // ONE reader for BOTH body shapes (pack REV-22 F7). The fulfil route
          // answers through `apiHandler` — flat — so the old nested-only branch
          // fell through to the generic fallback and dropped the code with it.
          const errorData = await fulfillResponse.json().catch(() => ({}));
          const { code, context } = readApiError(errorData);
          const error = new Error(apiErrorMessage(errorData, "Failed to fulfill WC order"));
          (error as any).code = code ?? undefined;
          (error as any).context = context;
          throw error;
        }

        const fulfillBody = await fulfillResponse.json();
        batchIds.fulfilBatchId =
          typeof fulfillBody?.batchId === "string" ? fulfillBody.batchId : null;
        wcFulfilled = true;

        // ---------------------------------------------------------------------
        // THE ENVELOPE, READ (pack CB1.5c / seam S-B15). A 200 is an ANSWER, not
        // a success: from B1.5 a short line comes back as a `skipped` entry on a
        // 200, and this surface used to report every 2xx as "all deducted".
        //
        // The WC leg is ALL-OR-NOTHING here (its documented P0-2 posture): a
        // partial fulfilment is rolled back and the completion stops, because
        // the manual leg that would follow it is a second movement the operator
        // never agreed to make on half an order.
        // ---------------------------------------------------------------------
        fulfilledEntries = Array.isArray(fulfillBody?.results?.fulfilled)
          ? (fulfillBody.results.fulfilled as FulfilledEntry[])
          : [];
        // A body with no readable summary is NOT read as a refusal: it would
        // roll back a leg that may well have succeeded and then tell the
        // operator nothing was deducted. Today's route always sends one.
        const fulfilledCount =
          typeof fulfillBody?.summary?.fulfilled === "number"
            ? (fulfillBody.summary.fulfilled as number)
            : null;

        if (fulfilledCount !== null && fulfilledCount < wcItems.length) {
          // Nothing fulfilled => nothing to put back, so the leg IS clean.
          let restoredFully = true;
          if (fulfilledCount > 0) {
            restoredFully = await rollbackWcLeg(fulfilledEntries);
            if (restoredFully) wcFulfilled = false;
          }

          const error = new Error(
            primaryRefusal(fulfillBody?.results) ?? "the order could not be fulfilled"
          );
          // DCc-4: the code is CONDITIONAL. `FULFILMENT_REFUSED` promises the
          // WC lines were put back — true when none were fulfilled or the
          // rollback fully restored. A partial rollback throws UNCODED: the
          // critical toast above already told the truth, and a second toast
          // claiming the lines "were put back" would contradict it on the one
          // path where the data really is inconsistent.
          if (fulfilledCount === 0 || restoredFully) {
            (error as any).code = "FULFILMENT_REFUSED";
          }
          throw error;
        }
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
          // W2-1 (T7) + W2-2 rider: the chip's EFFECTIVE value — the operator's
          // tap when they made one, otherwise this surface's `order` default.
          // The key is still omitted entirely when there is nothing to
          // pre-select for, which is what keeps "unstated" distinguishable from
          // an asserted `other` on every other path.
          ...(effectiveIntent ? { intent: effectiveIntent } : {}),
        };

        const deductResponse = await fetch("/api/inventory/deduct-simple", {
          method: "POST",
          headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
          body: JSON.stringify(deductRequest),
        });

        if (!deductResponse.ok) {
          // P0-2: Manual deduct failed AFTER WC fulfill succeeded. Roll back the
          // WC portion by calling unfulfill, otherwise we leave the user with
          // deducted WC inventory and no undo path.
          // Pack CB1.5c: the SAME helper, over the entries the server said it
          // deducted — not every cart line, and no longer accepting a 2xx that
          // restored nothing as a rollback. Still best-effort at the wire, but
          // a rollback that did not restore every line now says so, loudly.
          if (wcFulfilled && selectedExternalOrder) {
            const restoredFully = await rollbackWcLeg(fulfilledEntries);
            if (restoredFully) wcFulfilled = false;
          }

          // Same shared reader on the deduct leg (pack REV-22 F7): a 400
          // `INSUFFICIENT_STOCK` from batch-adjust/deduct-simple now reaches the
          // toast as the server's own sentence, with its code intact.
          const errorData = await deductResponse.json().catch(() => ({}));
          const { code, context } = readApiError(errorData);
          const error = new Error(apiErrorMessage(errorData, "Failed to process order"));
          (error as any).code = code ?? undefined;
          (error as any).context = context;
          throw error;
        }

        const deductBody = await deductResponse.json();
        batchIds.deductSimpleBatchId =
          typeof deductBody?.batchId === "string" ? deductBody.batchId : null;
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
          // Pack CB1b.6: the pair travels INTACT — the Undo names the movements
          // this completion made, instead of inferring them from the items.
          batchIds,
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
                {/* OCc-7: the over-cap sentence lives HERE — the one row both
                    the WC and the non-WC paths render. Hung off the `Added
                    Manually` header it would have left a 101-line manual cart
                    with a dead Confirm and no reason on screen. */}
                {wcOver && (
                  <p className="text-sm font-medium text-destructive">
                    {`This order has ${wcItems.length} WooCommerce lines; fulfilment handles at most ${MAX_FULFILLMENT_ITEMS} per request.`}
                  </p>
                )}
                {manualOver && (
                  <p className="text-sm font-medium text-destructive">
                    {`This cart has ${manualItems.length} manual lines; deduction handles at most ${MAX_SIMPLE_DEDUCT_ITEMS} per request.`}
                  </p>
                )}
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
                    {showWcCounter && (
                      <span
                        className={`text-xs font-mono tabular-nums ${
                          wcOver ? "text-destructive font-semibold" : "text-muted-foreground"
                        }`}
                      >
                        {`${wcItems.length} of ${MAX_FULFILLMENT_ITEMS}`}
                      </span>
                    )}
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
                  <p className="text-sm font-medium flex items-center gap-1.5">
                    Added Manually ({manualItems.length})
                    {showManualCounter && (
                      <span
                        className={`text-xs font-mono tabular-nums ${
                          manualOver ? "text-destructive font-semibold" : "text-muted-foreground"
                        }`}
                      >
                        {`${manualItems.length} of ${MAX_SIMPLE_DEDUCT_ITEMS}`}
                      </span>
                    )}
                  </p>
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

              {/* W2-1 (T7): the intent chip for the manual lines above. The WC
                  lines beside them are attributed automatically by the fulfill
                  route; these are the ones nothing else can speak for. Two
                  values only — damage-loss is not offered on this surface. */}
              {showIntentChip && (
                <IntentChip
                  surface="workbench"
                  value={effectiveIntent}
                  onChange={(next) => setIntent(next as WorkbenchIntent)}
                  disabled={isProcessing}
                />
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
            // CB1.5c: plus the request caps — either leg over its own cap would
            // be refused by its route with the whole cart already spent.
            disabled={
              isProcessing ||
              csrfLoading ||
              !csrfToken ||
              !allAcknowledged ||
              wcOver ||
              manualOver
            }
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
