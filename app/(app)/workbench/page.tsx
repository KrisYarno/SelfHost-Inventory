"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkbench } from "@/hooks/use-workbench";
import { useInventoryProducts } from "@/hooks/use-inventory-products";
import { invalidateInventoryCaches } from "@/hooks/use-inventory-mutations";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { groupProductsByBaseName } from "@/lib/product-utils";
import { ProductTile } from "@/components/workbench/product-tile";
import { QuantityPicker } from "@/components/workbench/quantity-picker";
import { OrderList } from "@/components/workbench/order-list";
import { OrderQueue } from "@/components/workbench/order-queue";
import {
  CompleteOrderDialog,
  type CompletionBatchIds,
  type DeductionDetail,
  type FulfilledForUndo,
} from "@/components/workbench/complete-order-dialog";
import {
  MoveBatchDialog,
  MOVE_ORDER_LEG_SENTENCE,
  type MoveResponse,
  type MoveTarget,
} from "@/components/workbench/move-batch-dialog";
import { WCOrderSelector } from "@/components/workbench/wc-order-selector";
import { UnmappedItemsAlert } from "@/components/workbench/unmapped-items-alert";
import { FloatingCartButton } from "@/components/workbench/floating-cart-button";
import { MobileCartSheet } from "@/components/workbench/mobile-cart-sheet";
import { MobileFilterSheet, StockFilter } from "@/components/products/mobile-filter-sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchInput } from "@/components/ui/search-input";
import { Checkbox } from "@/components/ui/checkbox";
import { ProductWithQuantity } from "@/types/product";
import { RotateCcw, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "@/contexts/location-context";
import { apiErrorMessage } from "@/lib/api-error";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { effectiveLowStockThreshold, isLowStock } from "@/lib/stock-threshold";
import { useLowStockDefault } from "@/hooks/use-low-stock-default";

export default function WorkbenchPage() {
  const [selectedProduct, setSelectedProduct] = useState<ProductWithQuantity | null>(null);
  const [showCompleteDialog, setShowCompleteDialog] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [showInStockOnly, setShowInStockOnly] = useState(false);
  const [showLowStockOnly, setShowLowStockOnly] = useState(false);
  const [showOutOfStockOnly, setShowOutOfStockOnly] = useState(false);
  const [stockFilter, setStockFilter] = useState<StockFilter>("all");
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  /**
   * THE WRONG-LOCATION MOVE (reconciliation Part 2, pack CB2c.4). PAGE state,
   * never the toast's: the sonner node unmounts at 10 s and would take the
   * dialog with it, mid-decision.
   */
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  /**
   * THE COMPLETION TOAST'S OWN CLOCK (F15). Dismissal was never the only way to
   * lose the Undo: the toast behind the dialog kept running its 10 s, so a slow
   * decision or a late refusal destroyed it just as surely. This holds the
   * CURRENT completion's re-issue closure — sonner updates a toast re-issued
   * under its own id — so the move can stop that clock while the dialog is open
   * and hand a fresh 10 s back when the decision goes the other way. Null once
   * the move has succeeded: a dismissed Undo is never resurrected.
   */
  const reissueUndoToastRef = useRef<((duration: number) => void) | null>(null);
  /**
   * THE ID THE COMPLETION TOAST IS LIVE UNDER (F25). The re-issue closure can
   * only re-raise it; the unmount cleanup has to DISMISS it, and sonner needs
   * the id for that. Null whenever there is nothing on screen to dismiss.
   */
  const liveUndoToastIdRef = useRef<string | null>(null);
  /**
   * `moveTarget`, readable from an unmount cleanup (F25). A cleanup registered
   * with an empty dep list closes over the FIRST render's state, so the dialog's
   * openness is mirrored here rather than read from the closure.
   */
  const moveTargetRef = useRef<MoveTarget | null>(null);

  // `selectedLocation` rides beside the id (R7-14): the toast names the LEDGER
  // location the completion deducted at, and a name read inside a callback would
  // be read from a render this callback no longer belongs to.
  const { selectedLocationId, selectedLocation } = useLocation();
  const { token: csrfToken } = useCSRF();
  const lowStockDefault = useLowStockDefault();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const { data: products = [], isLoading: loading, refetch: refetchProducts } = useInventoryProducts({
    locationId: selectedLocationId,
    sortBy: "baseNameNumeric",
    sortOrder: "asc",
  });

  const {
    orderItems,
    orderReference,
    setOrderReference,
    addItem,
    clearOrder,
    getTotalItems,
    getTotalQuantity,
    advanceQueue,
    getQueuePosition,
    orderSource,
    setOrderSource,
    selectedExternalOrder,
    unmappedExternalItems,
    selectExternalOrder,
    clearExternalOrder,
  } = useWorkbench();

  const isWCOrder = !!selectedExternalOrder;

  // Handle scroll for collapsing search bar on mobile
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 50);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // The dialog's openness, mirrored into a ref for the unmount cleanup below.
  useEffect(() => {
    moveTargetRef.current = moveTarget;
  }, [moveTarget]);

  /**
   * THE COMPLETION TOAST DOES NOT OUTLIVE THIS PAGE (F25).
   *
   * Opening the move dialog re-issues the toast with `duration: Infinity`, and
   * sonner's provider lives in the app shell — so navigating away mid-decision
   * left an Undo on screen forever, wired to callbacks belonging to a tree React
   * had already thrown away. On unmount the live toast goes with the page, and
   * the re-issue closure is nulled so nothing can bring it back.
   *
   * Snapshot the refs into locals: the cleanup must close over stable values
   * (react-hooks/exhaustive-deps).
   */
  useEffect(() => {
    const liveId = liveUndoToastIdRef;
    const reissue = reissueUndoToastRef;
    const target = moveTargetRef;
    return () => {
      if (liveId.current !== null && (target.current !== null || reissue.current !== null)) {
        toast.dismiss(liveId.current);
      }
      reissue.current = null;
      liveId.current = null;
    };
  }, []);

  /**
   * THE UNDO (reconciliation Part 2, pack CB2b.3; spec §2.5).
   *
   * A completion is up to TWO movements, so an undo is up to two calls — and
   * from B2b each of them NAMES what it is undoing:
   *
   *   THE MANUAL LEG is ONE reverse of the batch deduct-simple wrote. It used to
   *   be N positive adjusts that named nothing: no link to the batch, no bound on
   *   restoring the same units twice, and a report that read them as fresh
   *   corrections. The batch id has been threaded here since B1 for exactly this.
   *
   *   THE WC LEG stays unfulfill — the line-level `fulfilledQty` bookkeeping
   *   lives there — but its body is built from `fulfilledForUndo`, i.e. from the
   *   fulfil envelope's own `results.fulfilled`, never from the cart. What was
   *   asked for and what moved are different numbers whenever a line was clamped
   *   or skipped, and restoring the asked number takes units out of somebody
   *   else's fulfilment.
   *
   * TWO TOASTS, never one joined sentence: the legs count different things
   * (units restored vs order lines put back), they are independent requests, and
   * a refusal on one must not swallow the other's answer.
   */
  const handleUndoDeduction = useCallback(
    async (
      items: DeductionDetail[],
      orderRef: string,
      batchIds: CompletionBatchIds,
      opts: { fulfilledForUndo: FulfilledForUndo[]; externalOrderId?: string }
    ) => {
      if (!csrfToken) {
        toast.error("Session expired. Cannot undo.");
        return;
      }

      const { fulfilledForUndo, externalOrderId } = opts;
      const wcItems = items.filter((item) => item.fulfillmentItemId);
      const manualItems = items.filter((item) => !item.fulfillmentItemId);

      let movedStock = false;
      /**
       * F23 (QA-1): a 200 the page cannot READ is still a 200. The reverse route
       * only answers one once the restoration is committed, so stock HAS moved —
       * it is the SIZE that is unknown. Nothing is claimed in a toast on this
       * evidence, but the caches are told, because a stale /inventory beside a
       * moved ledger would be the second untruth.
       */
      let stockMayHaveMoved = false;

      /** Pack REV-22 F7: the SERVER's sentence, or the old fallback. */
      const refusalSentence = (body: unknown): string => {
        const detail = apiErrorMessage(body, "");
        return detail
          ? `Some items could not be restored: ${detail}`
          : "Some items could not be restored. Check inventory manually.";
      };

      const manualLeg = async () => {
        if (batchIds.deductSimpleBatchId === null) {
          // S-B5's contract makes this impossible when there ARE manual lines:
          // the leg that wrote them minted the id this undo needs. It gets its
          // OWN sentence — the QB-4 copy states a reason ("already reversed or
          // changed by someone else") that is false here.
          if (manualItems.length > 0) {
            console.error(
              `Undo: order ${orderRef} has ${manualItems.length} manual line(s) but the completion named no deduct-simple batch`
            );
            toast.error(
              `Order ${orderRef} could not be undone: the completion did not name the batch it wrote. Adjust inventory manually.`,
              { id: `undo-manual-${orderRef}` }
            );
          }
          return;
        }

        try {
          const response = await fetch(
            `/api/inventory/batches/${batchIds.deductSimpleBatchId}/reverse`,
            {
              method: "POST",
              headers: withCSRFHeaders({}, csrfToken),
            }
          );
          const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

          if (response.ok) {
            // F23 (QA-1), the move dialog's F20 shape: a body with no numeric
            // `restoredUnits` is a restoration whose size this page cannot
            // state. `0 units restored` would be a number about the ledger it
            // cannot stand behind — and a SUCCESS toast on top of it.
            if (typeof body.restoredUnits !== "number" || !Number.isFinite(body.restoredUnits)) {
              stockMayHaveMoved = true;
              console.warn(
                `Undo: order ${orderRef} — the reverse answered 200 without a numeric restoredUnits, so the units restored cannot be stated`
              );
              toast.warning(
                `Order ${orderRef}: the reverse answered without a number — check the ledger`,
                { id: `undo-manual-${orderRef}` }
              );
              return;
            }
            movedStock = true;
            const units = body.restoredUnits;
            toast.success(
              `Undone for order ${orderRef}: ${units} unit${units !== 1 ? "s" : ""} restored`,
              { id: `undo-manual-${orderRef}` }
            );
            return;
          }

          if (body.code === "ALREADY_REVERSED") {
            // The QB-4 class: nothing moved, and the server's own numbers say
            // why. A success toast here would claim a restoration that the
            // ledger already accounted for.
            const previouslyRestored =
              typeof body.previouslyRestored === "number" ? body.previouslyRestored : null;
            const totalUnits = typeof body.totalUnits === "number" ? body.totalUnits : null;
            if (previouslyRestored === null || totalUnits === null) {
              // F24 (QA-2): `0 of 0` is a PAIR of numbers this page invented —
              // and it reads as "nothing was ever put back", which is the one
              // thing an ALREADY_REVERSED refusal disproves. The F7 rule stands
              // in for the composed line: the server's own sentence, verbatim.
              toast.warning(
                apiErrorMessage(
                  body,
                  `Order ${orderRef} was already reversed — check the ledger for what was put back.`
                ),
                { id: `undo-manual-${orderRef}` }
              );
              return;
            }
            toast.warning(
              `Order ${orderRef} was already reversed — ${previouslyRestored} of ${totalUnits} units were put back earlier.`,
              { id: `undo-manual-${orderRef}` }
            );
            return;
          }

          toast.error(refusalSentence(body), { id: `undo-manual-${orderRef}` });
        } catch (err) {
          console.error("Undo reverse error:", err);
          toast.error("Failed to undo deduction. Please adjust inventory manually.", {
            id: `undo-manual-${orderRef}`,
          });
        }
      };

      const wcLeg = async () => {
        if (!externalOrderId || wcItems.length === 0) return;

        // The lines the fulfil envelope never named. They are NOT completed from
        // the cart (FD1-3's tolerated skew is retired from this path on purpose)
        // — they are left out of the body and said out loud.
        const named = new Set(fulfilledForUndo.map((entry) => entry.itemId));
        const omitted = wcItems.filter(
          (item) => !item.fulfillmentItemId || !named.has(item.fulfillmentItemId)
        ).length;
        const omittedSentence =
          omitted > 0
            ? ` ${omitted} line(s) were not restored — the fulfil response never named them.`
            : "";

        if (fulfilledForUndo.length === 0) {
          // `UnfulfillRequestSchema.items` is `.min(1)`, so there is no request
          // to make — and the operator is told the reason rather than shown a
          // 400 the page provoked.
          console.error(
            `Undo: order ${orderRef} has ${wcItems.length} WC line(s) but the fulfil response named none of them`
          );
          toast.warning(
            `Nothing was restored for order ${orderRef} — the fulfil response never named the lines it deducted.`,
            { id: `undo-wc-${orderRef}` }
          );
          return;
        }

        try {
          const response = await fetch(`/api/orders/${externalOrderId}/unfulfill`, {
            method: "POST",
            headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
            body: JSON.stringify({ items: fulfilledForUndo }),
          });
          const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

          if (!response.ok) {
            toast.error(refusalSentence(body), { id: `undo-wc-${orderRef}` });
            return;
          }

          // QB-4 (truthful data): a 200 can carry `restored: []` — every line hit
          // a pass-1 guard. Read what actually moved and say that.
          const restored = Array.isArray(body.restored) ? body.restored.length : 0;
          if (restored === 0) {
            toast.warning(
              `Nothing was restored for order ${orderRef} — the items were already reversed or changed by someone else.${omittedSentence}`,
              { id: `undo-wc-${orderRef}` }
            );
            return;
          }

          movedStock = true;
          toast.success(
            `Order ${orderRef}: ${restored} order line${restored !== 1 ? "s" : ""} put back.${omittedSentence}`,
            { id: `undo-wc-${orderRef}` }
          );
        } catch (err) {
          console.error("Undo unfulfill error:", err);
          toast.error("Failed to undo deduction. Please adjust inventory manually.", {
            id: `undo-wc-${orderRef}`,
          });
        }
      };

      // INDEPENDENT: a refusal on one leg never stops the other from answering.
      await Promise.all([manualLeg(), wcLeg()]);

      if (movedStock || stockMayHaveMoved) {
        // Stock moved through raw fetch, so the react-query caches every other
        // page reads (/inventory, dashboard, journal) have to be told. F23: a
        // 200 whose number could not be read counts here — the books moved even
        // though the toast could not say by how much.
        invalidateInventoryCaches(queryClient);
      }
    },
    [csrfToken, queryClient]
  );

  const showUndoToast = useCallback(
    (
      orderRef: string,
      items: DeductionDetail[],
      batchIds: CompletionBatchIds,
      opts: { fulfilledForUndo: FulfilledForUndo[]; externalOrderId?: string }
    ) => {
      const message = opts.externalOrderId
        ? `Order ${orderRef} fulfilled.`
        : `Order ${orderRef} completed.`;

      // The MANUAL leg's ASKED units (pack CB2c.4). Labelled as asked in the
      // dialog's consequence line and never presented as the server's figure —
      // the 200's `pairs` are what the result line prints.
      const manualUnits = items
        .filter((item) => !item.fulfillmentItemId)
        .reduce((total, item) => total + item.quantity, 0);

      // OC-1: a control whose only outcome is a dead dialog is not offered. A
      // WC-only cart wrote no movable batch, so the toast says where THAT repair
      // lives instead.
      const canMove = selectedLocationId !== null && batchIds.deductSimpleBatchId !== null;
      const orderLegOnly =
        batchIds.deductSimpleBatchId === null && batchIds.fulfilBatchId !== null;

      // ONE body, issued under ONE id, with the clock as its only variable
      // (F15). Sonner treats a re-issue under a live id as an update.
      const issue = (duration: number) => {
        toast(
          <div className="flex w-full flex-col gap-2">
            <div className="flex items-center justify-between w-full gap-3">
              <span className="text-sm">
                <span className="font-mono font-medium">{message}</span>
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-medium hover:bg-foreground/90 transition-colors shrink-0"
                  onClick={() => {
                    toast.dismiss(`undo-${orderRef}`);
                    handleUndoDeduction(items, orderRef, batchIds, opts);
                  }}
                >
                  <Undo2 className="h-3 w-3" />
                  Undo
                </button>
                {canMove && (
                  <button
                    type="button"
                    data-testid={`wrong-location-${orderRef}`}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors shrink-0"
                    onClick={() => {
                      // NOTHING but page state (F1/OC-1). Dismissing the completion
                      // toast here destroyed the Undo for anyone who then cancelled
                      // or was refused — the toast is the only place the Undo
                      // lives. The dismissal waits for the move to RESOLVE
                      // (`confirmMove`).
                      setMoveTarget({
                        batchIds,
                        ledgerLocationId: selectedLocationId as number,
                        ledgerLocationName:
                          selectedLocation?.name ?? `Location ${selectedLocationId}`,
                        units: manualUnits,
                        orderRef,
                        // The workbench's ref IS the order's (F13).
                        refKind: "order",
                        caller: "workbench",
                      });
                      // F15: and the toast STOPS COUNTING while the decision is
                      // being made. Behind the dialog it was still running its
                      // 10 s, so a slow decision lost the Undo anyway.
                      issue(Infinity);
                    }}
                  >
                    Wrong location…
                  </button>
                )}
              </div>
            </div>
            {orderLegOnly && (
              <span
                className="text-xs text-muted-foreground"
                data-testid={`order-leg-only-${orderRef}`}
              >
                {MOVE_ORDER_LEG_SENTENCE}
              </span>
            )}
          </div>,
          {
            id: `undo-${orderRef}`,
            duration,
            dismissible: true,
          },
        );
      };

      // The re-issue closure for THIS completion (last one wins — the dialog is
      // modal at page level, so only one completion's decision is ever open),
      // and the id it is live under (F25).
      reissueUndoToastRef.current = issue;
      liveUndoToastIdRef.current = `undo-${orderRef}`;
      issue(10000);
    },
    [handleUndoDeduction, selectedLocationId, selectedLocation]
  );

  /**
   * THE WORKBENCH'S OWN MOVE CALLER (pack CB2c.4). A raw fetch with this page's
   * CSRF token, rejecting with the PARSED BODY — every refusal envelope carries
   * `{ error, code }`, which is exactly what the shared dialog reads, so this
   * caller and the drill-down's `useMoveBatch` reject identically.
   */
  const confirmMove = useCallback(
    async (physicalLocationId: number): Promise<MoveResponse> => {
      try {
        const batchId = moveTarget?.batchIds.deductSimpleBatchId;
        if (!batchId) {
          throw { error: "This completion did not name a batch to move.", code: "NO_BATCH" };
        }
        if (!csrfToken) {
          throw { error: "Session expired. Cannot move this batch.", code: "CSRF_MISSING" };
        }

        const response = await fetch(`/api/inventory/batches/${batchId}/move`, {
          method: "POST",
          headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
          body: JSON.stringify({ physicalLocationId }),
        });
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) throw body;

        // Stock moved through a raw fetch, so the react-query caches every other
        // page reads have to be told.
        invalidateInventoryCaches(queryClient);
        // F1: NOW the completion toast goes. The decision is made and the books
        // have moved, so the Undo behind the dialog no longer describes anything
        // the operator would want to click. F15: and nothing may re-issue it
        // afterwards — the closure goes with it.
        if (moveTarget !== null) toast.dismiss(`undo-${moveTarget.orderRef}`);
        // F32 (codex CX-4): the two refs describe ONE live toast, by id. They
        // are cleared only when that toast is the one this move belongs to — a
        // later completion's toast keeps its re-issue closure and its unmount
        // dismissal (the dialog is modal and holds its target while a request
        // is in flight, so this is a belt).
        if (moveTarget !== null && liveUndoToastIdRef.current === `undo-${moveTarget.orderRef}`) {
          reissueUndoToastRef.current = null;
          // F25: nothing is live under that id any more, so the unmount cleanup
          // has nothing left to dismiss.
          liveUndoToastIdRef.current = null;
        }
        return body as unknown as MoveResponse;
      } catch (err) {
        // F15: a REFUSAL (or a dead network) leaves the batch exactly where it
        // was, so the Undo is still the right thing to click — with a fresh 10 s
        // to click it in, because the decision is over. F32: only this move's
        // own toast gets its clock back.
        if (moveTarget !== null && liveUndoToastIdRef.current === `undo-${moveTarget.orderRef}`) {
          reissueUndoToastRef.current?.(10000);
        }
        throw err;
      }
    },
    [moveTarget, csrfToken, queryClient]
  );

  // Sync stock filter with checkboxes
  useEffect(() => {
    if (showInStockOnly) {
      setStockFilter("in-stock");
    } else if (showLowStockOnly) {
      setStockFilter("low-stock");
    } else if (showOutOfStockOnly) {
      setStockFilter("out-of-stock");
    } else {
      setStockFilter("all");
    }
  }, [showInStockOnly, showLowStockOnly, showOutOfStockOnly]);

  // P1-9: After a user maps an unmapped item inline, refetch the external
  // order and re-select it so the cart picks up the newly mapped item. Mapping
  // links an EXISTING product, so the current `products` snapshot is sufficient
  // — we only need fresh order data to pick up the new productLink.
  const refetchExternalOrder = useCallback(async () => {
    if (!selectedExternalOrder?.id) return;
    try {
      const res = await fetch(
        `/api/orders/external/${selectedExternalOrder.id}`,
        { cache: "no-store" }
      );
      if (!res.ok) {
        toast.error("Could not refresh order after mapping. Please reselect.");
        return;
      }
      const freshOrder = await res.json();
      selectExternalOrder(freshOrder, products);
    } catch (err) {
      console.error("Refetch external order error:", err);
      toast.error("Could not refresh order after mapping.");
    }
  }, [selectedExternalOrder?.id, selectExternalOrder, products]);

  const handleProductClick = (product: ProductWithQuantity) => {
    if (product.currentQuantity > 0) {
      setSelectedProduct(product);
    }
  };

  const handleQuantityConfirm = (quantity: number) => {
    if (selectedProduct) {
      // Manual additions always use 'manual' source
      addItem(selectedProduct, quantity, 'manual');
      toast.success(`Added ${quantity} x ${selectedProduct.name}`);
    }
  };

  const handleCompleteOrder = () => {
    if (orderItems.length === 0) {
      toast.error("No items in order");
      return;
    }
    if (!orderReference.trim()) {
      toast.error("Please enter an order reference");
      return;
    }
    setShowCompleteDialog(true);
  };

  const handleClearOrder = () => {
    if (orderItems.length > 0) {
      if (confirm("Are you sure you want to clear the current order?")) {
        clearOrder();
        toast.info("Order cleared");
        setMobileCartOpen(false);
      }
    }
  };

  const handleStockFilterChange = (filter: StockFilter) => {
    setStockFilter(filter);
    // Update checkboxes to match
    setShowInStockOnly(filter === "in-stock");
    setShowLowStockOnly(filter === "low-stock");
    setShowOutOfStockOnly(filter === "out-of-stock");
  };

  const clearFilters = () => {
    setStockFilter("all");
    setShowInStockOnly(false);
    setShowLowStockOnly(false);
    setShowOutOfStockOnly(false);
    setSearchTerm("");
  };

  // Filter products based on search and stock filters
  const filteredProducts = useMemo(() => {
    return products.filter((product) => {
      // Search filter - check if any word in product name starts with search term
      if (searchTerm) {
        const searchLower = searchTerm.toLowerCase();
        const words = product.name.toLowerCase().split(/\s+/);
        const matchesSearch = words.some((word) => word.startsWith(searchLower));
        if (!matchesSearch) return false;
      }

      // Stock filters. "Low" uses the shared inheritance model + INCLUSIVE
      // predicate (R-L13) instead of a hard-coded ≤ 10.
      if (showInStockOnly && product.currentQuantity <= 0) return false;
      if (
        showLowStockOnly &&
        !isLowStock(
          product.currentQuantity,
          effectiveLowStockThreshold(product.lowStockThreshold, lowStockDefault)
        )
      )
        return false;
      if (showOutOfStockOnly && product.currentQuantity !== 0) return false;

      return true;
    });
  }, [products, searchTerm, showInStockOnly, showLowStockOnly, showOutOfStockOnly, lowStockDefault]);

  // Group filtered products by baseName
  const groupedProducts = useMemo(
    () => groupProductsByBaseName(filteredProducts),
    [filteredProducts]
  );

  // Dynamic button text based on order source
  const completeButtonText = isWCOrder ? "Complete & Fulfill" : "Complete & Deduct";

  return (
    <div className="flex flex-col h-full max-h-screen overflow-hidden">
      {/* Header */}
      <PageHeader title="Workbench" description="Quick order processing" />

      {/* Main Content - Two Column Layout. A section, not a page-level main
          landmark; the app shell owns the single page main (U4). */}
      <section aria-label="Order workbench" className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        {/* Left Side - Product Grid */}
        <div className="flex-1 p-4 sm:p-6 overflow-y-auto">
          <div className="max-w-6xl mx-auto">
            {/* Mobile: Order source toggle above search */}
            {isMobile && (
              <div className="mb-3">
                <Tabs
                  value={orderSource}
                  onValueChange={(v) => setOrderSource(v as 'manual' | 'wc-order')}
                >
                  <TabsList className="w-full">
                    <TabsTrigger value="manual" className="flex-1">Manual</TabsTrigger>
                    <TabsTrigger value="wc-order" className="flex-1">From Order</TabsTrigger>
                  </TabsList>
                  {orderSource === 'wc-order' && (
                    <TabsContent value="wc-order" className="mt-2">
                      <WCOrderSelector
                        onOrderSelected={(order) => selectExternalOrder(order, products)}
                        selectedOrder={selectedExternalOrder}
                        onClear={clearExternalOrder}
                      />
                      {unmappedExternalItems.length > 0 && (
                        <div className="mt-2">
                          <UnmappedItemsAlert
                            items={unmappedExternalItems}
                            integrationId={selectedExternalOrder?.integrationId}
                            onItemMapped={refetchExternalOrder}
                          />
                        </div>
                      )}
                    </TabsContent>
                  )}
                </Tabs>
                {/* Mobile: slim selected order banner when in WC mode */}
                {isMobile && isWCOrder && orderSource === 'manual' && (
                  <div className="mt-2 flex items-center justify-between rounded-md border border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/30 px-3 py-1.5">
                    <span className="text-xs font-mono">
                      WC #{selectedExternalOrder.orderNumber}
                      {selectedExternalOrder.customerName && (
                        <span className="ml-1.5 text-muted-foreground font-sans">
                          {selectedExternalOrder.customerName}
                        </span>
                      )}
                    </span>
                    <button
                      onClick={clearExternalOrder}
                      className="text-xs text-muted-foreground hover:text-destructive ml-2"
                    >
                      x
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Search and Filters */}
            <div
              className={cn(
                "mb-4 md:mb-6 space-y-4",
                "sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60",
                "transition-all duration-300",
                isMobile && isScrolled ? "py-2" : "pb-4"
              )}
            >
              {/* Search Bar */}
              <div className="flex gap-2">
                <SearchInput
                  placeholder={isMobile && isScrolled ? "Search..." : "Search products..."}
                  value={searchTerm}
                  onSearch={setSearchTerm}
                  className={cn(
                    "flex-1 transition-all duration-300",
                    isMobile && !isScrolled ? "max-w-none" : "max-w-md"
                  )}
                />
                {isMobile && (
                  <MobileFilterSheet
                    stockFilter={stockFilter}
                    onStockFilterChange={handleStockFilterChange}
                    onClearFilters={clearFilters}
                    activeFilterCount={stockFilter !== "all" ? 1 : 0}
                  />
                )}
              </div>

              {/* Filter Toggles - Desktop Only */}
              {!isMobile && (
                <div className="flex flex-wrap gap-4">
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="in-stock"
                      checked={showInStockOnly}
                      onCheckedChange={(checked) => {
                        setShowInStockOnly(!!checked);
                        if (checked) {
                          setShowLowStockOnly(false);
                          setShowOutOfStockOnly(false);
                        }
                      }}
                    />
                    <Label
                      htmlFor="in-stock"
                      className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                    >
                      Show in stock only
                    </Label>
                  </div>

                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="low-stock"
                      checked={showLowStockOnly}
                      onCheckedChange={(checked) => {
                        setShowLowStockOnly(!!checked);
                        if (checked) {
                          setShowInStockOnly(false);
                          setShowOutOfStockOnly(false);
                        }
                      }}
                    />
                    <Label
                      htmlFor="low-stock"
                      className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                    >
                      Show low stock only
                    </Label>
                  </div>

                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="out-of-stock"
                      checked={showOutOfStockOnly}
                      onCheckedChange={(checked) => {
                        setShowOutOfStockOnly(!!checked);
                        if (checked) {
                          setShowInStockOnly(false);
                          setShowLowStockOnly(false);
                        }
                      }}
                    />
                    <Label
                      htmlFor="out-of-stock"
                      className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                    >
                      Show out of stock only
                    </Label>
                  </div>
                </div>
              )}
            </div>
            {loading ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4">
                {Array.from({ length: 12 }).map((_, i) => (
                  <Skeleton key={i} className="h-40 rounded-lg" />
                ))}
              </div>
            ) : filteredProducts.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-muted-foreground">
                  {products.length === 0
                    ? "No products available"
                    : "No products match your filters"}
                </p>
              </div>
            ) : (
              <div className="space-y-6 pb-20 md:pb-0">
                {groupedProducts.map((group) => (
                  <div key={group.label.toLowerCase()}>
                    <div className="flex items-center gap-3 mb-3 sticky top-16 md:relative md:top-0 bg-background/95 backdrop-blur py-2 -mx-1 px-1">
                      <h3 className="text-label uppercase tracking-wider text-muted-foreground">
                        {group.label}
                      </h3>
                      <div className="flex-1 h-px bg-border" />
                      <span className="text-caption text-muted-foreground tabular-nums">
                        {group.products.length}
                      </span>
                    </div>
                    <div
                      className={cn(
                        "grid gap-3 sm:gap-4",
                        isMobile
                          ? "grid-cols-2"
                          : "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5"
                      )}
                    >
                      {group.products.map((product) => (
                        <ProductTile
                          key={product.id}
                          product={product}
                          onClick={handleProductClick}
                          className={isMobile ? "aspect-square" : ""}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Side - Order Panel (Desktop Only) */}
        {!isMobile && (
          <div className="w-full lg:w-96 border-t lg:border-t-0 lg:border-l border-border bg-muted/5 flex flex-col">
            {/* Order Queue */}
            <OrderQueue />

            {/* Order Header with Order Source Toggle */}
            <div className="p-4 border-b bg-background">
              <h2 className="text-lg font-semibold mb-3">Current Order</h2>

              {/* Order Source Tabs */}
              <Tabs
                value={orderSource}
                onValueChange={(v) => setOrderSource(v as 'manual' | 'wc-order')}
              >
                <TabsList className="w-full mb-3">
                  <TabsTrigger value="manual" className="flex-1">Manual</TabsTrigger>
                  <TabsTrigger value="wc-order" className="flex-1">From Order</TabsTrigger>
                </TabsList>

                {/* Manual tab: preserve existing text input */}
                <TabsContent value="manual">
                  <div className="space-y-2">
                    <Label htmlFor="order-reference">Order Reference</Label>
                    <Input
                      id="order-reference"
                      placeholder="Enter order number..."
                      value={orderReference}
                      onChange={(e) => setOrderReference(e.target.value)}
                      className="font-mono"
                    />
                  </div>
                </TabsContent>

                {/* From Order tab: WC order selector */}
                <TabsContent value="wc-order">
                  <WCOrderSelector
                    onOrderSelected={(order) => selectExternalOrder(order, products)}
                    selectedOrder={selectedExternalOrder}
                    onClear={clearExternalOrder}
                  />
                  {unmappedExternalItems.length > 0 && (
                    <div className="mt-2">
                      <UnmappedItemsAlert
                        items={unmappedExternalItems}
                        integrationId={selectedExternalOrder?.integrationId}
                        onItemMapped={refetchExternalOrder}
                      />
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </div>

            {/* Order Items */}
            <div className="flex-1 overflow-hidden">
              <OrderList />
            </div>

            {/* Order Actions */}
            <div className="p-4 border-t bg-background space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Total items:</span>
                <span className="font-medium">{getTotalItems()}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Total quantity:</span>
                <span className="font-medium">{getTotalQuantity()} units</span>
              </div>

              <div className="flex gap-2 pt-2">
                <Button
                  variant="outline"
                  onClick={handleClearOrder}
                  disabled={orderItems.length === 0}
                  className="flex-1"
                >
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Clear
                </Button>
                <Button
                  onClick={handleCompleteOrder}
                  disabled={orderItems.length === 0 || !orderReference.trim()}
                  className="flex-1 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
                >
                  {completeButtonText}
                </Button>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Quantity Picker Dialog */}
      <QuantityPicker
        product={selectedProduct}
        open={!!selectedProduct}
        onClose={() => setSelectedProduct(null)}
        onConfirm={handleQuantityConfirm}
      />

      {/* Mobile FAB */}
      {isMobile && (
        <FloatingCartButton itemCount={getTotalItems()} onClick={() => setMobileCartOpen(true)} />
      )}

      {/* Mobile Cart Sheet */}
      {isMobile && (
        <MobileCartSheet
          open={mobileCartOpen}
          onOpenChange={setMobileCartOpen}
          orderReference={orderReference}
          onOrderReferenceChange={setOrderReference}
          totalItems={getTotalItems()}
          totalQuantity={getTotalQuantity()}
          onClearOrder={handleClearOrder}
          onCompleteOrder={handleCompleteOrder}
          canComplete={orderItems.length > 0 && !!orderReference.trim()}
          queuePosition={getQueuePosition()}
        />
      )}

      {/* Complete Order Dialog */}
      <CompleteOrderDialog
        open={showCompleteDialog}
        onOpenChange={setShowCompleteDialog}
        onSuccess={({
          orderReference: completedRef,
          items: deductedItems,
          batchIds,
          fulfilledForUndo,
          externalOrderId,
        }) => {
          refetchProducts();
          setMobileCartOpen(false);
          // Show undo toast for 10 seconds (Amendment 7: includes unfulfill for WC orders)
          showUndoToast(completedRef, deductedItems, batchIds, {
            fulfilledForUndo,
            externalOrderId,
          });
          // Advance to the next order in the queue (Amendment 6: forces manual mode)
          const next = advanceQueue();
          if (next) {
            toast.info(`Loaded next order: ${next}`);
          }
        }}
      />

      {/* THE MOVE DIALOG, at PAGE level (pack CB2c.4) — never inside the sonner
          toast node, which unmounts with the toast at 10 s and would take a
          half-made decision with it. */}
      <MoveBatchDialog
        target={moveTarget}
        onOpenChange={(next) => {
          if (next) return;
          setMoveTarget(null);
          // F15: the decision is over one way or the other, so the toast gets
          // its clock back — a fresh 10 s on the Undo. After a move that
          // SUCCEEDED there is no closure left to call: that Undo was dismissed
          // on purpose and never comes back.
          reissueUndoToastRef.current?.(10000);
        }}
        onConfirm={confirmMove}
      />
    </div>
  );
}
