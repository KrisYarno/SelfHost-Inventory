"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { OrderList } from "./order-list";
import { UnmappedItemsAlert } from "./unmapped-items-alert";
import { useWorkbench } from "@/hooks/use-workbench";
import { Package, RotateCcw, ShoppingCart } from "lucide-react";

interface MobileCartSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderReference: string;
  onOrderReferenceChange: (value: string) => void;
  totalItems: number;
  totalQuantity: number;
  onClearOrder: () => void;
  onCompleteOrder: () => void;
  canComplete: boolean;
  queuePosition?: { current: number; total: number } | null;
  /** The page's order refetch, handed to the skipped-lines alert's Map (F0-1). */
  onItemMapped?: () => void;
}

export function MobileCartSheet({
  open,
  onOpenChange,
  orderReference,
  onOrderReferenceChange,
  totalItems,
  totalQuantity,
  onClearOrder,
  onCompleteOrder,
  canComplete,
  queuePosition,
  onItemMapped,
}: MobileCartSheetProps) {
  // P2: hide the editable reference input when a WC order is active, matching
  // desktop behavior. An editable input would let users overwrite the WC order
  // number and break the undo/fulfillment trail.
  const selectedExternalOrder = useWorkbench((s) => s.selectedExternalOrder);
  const isWCOrder = !!selectedExternalOrder;
  // Facelift F0-1 (FL-C-1): the phone sees every line the customer ordered. The
  // skipped lines used to live only on the page BEHIND this sheet.
  const unmappedExternalItems = useWorkbench((s) => s.unmappedExternalItems);
  const clearExternalOrder = useWorkbench((s) => s.clearExternalOrder);
  // The page's gate for the same alert, and the dialog's for its checklist.
  const showSkippedLines = isWCOrder && unmappedExternalItems.length > 0;
  // A store order with nothing deductible here: its Clear has nothing to lose,
  // so it clears the order directly (no confirm), then closes the sheet as the
  // page's Clear-with-items does.
  const isEmptyStoreOrder = isWCOrder && totalItems === 0;
  const clearEmptyStoreOrder = () => {
    clearExternalOrder();
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[85vh] flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <ShoppingCart className="h-5 w-5" />
            Current Order
            {queuePosition && (
              <Badge variant="secondary" className="text-xs ml-1">
                {queuePosition.current} of {queuePosition.total}
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription>
            Review and complete your order
          </SheetDescription>
        </SheetHeader>

        {/* Order Reference — editable for manual orders, read-only WC banner otherwise */}
        {isWCOrder ? (
          <div className="py-4">
            <div className="rounded-lg border border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/30 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <Package className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-medium text-sm">
                      #{selectedExternalOrder.orderNumber}
                    </span>
                    <Badge variant="info" className="text-[10px] px-1.5 py-0">
                      WOO
                    </Badge>
                  </div>
                  {selectedExternalOrder.customerName && (
                    <p className="text-xs text-muted-foreground truncate">
                      {selectedExternalOrder.customerName}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="py-4 space-y-2">
            <Label htmlFor="mobile-order-reference">Order Reference</Label>
            <Input
              id="mobile-order-reference"
              placeholder="Enter order number..."
              value={orderReference}
              onChange={(e) => onOrderReferenceChange(e.target.value)}
              className="font-mono"
            />
          </div>
        )}

        {/* Order Items — F0-1: the skipped-lines alert (the page's own, with the
            same props, under the dialog's gate) and the order list share ONE
            scroll region, alert first; the footer below stays pinned. The alert
            starts collapsed here so it never pushes the cart out of view. */}
        <div className="flex-1 min-h-0 overflow-y-auto -mx-6 px-6">
          {showSkippedLines && (
            <div className="mb-2">
              <UnmappedItemsAlert
                items={unmappedExternalItems}
                integrationId={selectedExternalOrder?.integrationId}
                onItemMapped={onItemMapped}
                defaultExpanded={false}
              />
            </div>
          )}
          {isEmptyStoreOrder ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              Nothing from this order can be deducted here.
            </p>
          ) : (
            // OrderList is h-full with a ScrollArea of its own. Under the alert
            // that would make a second scroll region inside this one, so its
            // parent is left auto-height there and the list grows with its
            // lines; without the alert it fills the region exactly as before.
            <div className={showSkippedLines ? undefined : "h-full"}>
              <OrderList />
            </div>
          )}
        </div>

        {/* Order Summary and Actions */}
        <div className="mt-auto space-y-4 border-t border-border bg-background/80 -mx-6 px-6 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Total items:</span>
              <span className="font-medium">{totalItems}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Total quantity:</span>
              <span className="font-medium">{totalQuantity} units</span>
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={isEmptyStoreOrder ? clearEmptyStoreOrder : onClearOrder}
              disabled={totalItems === 0 && !isEmptyStoreOrder}
              className="flex-1"
            >
              <RotateCcw className="h-4 w-4 mr-2" />
              Clear
            </Button>
            <Button
              onClick={onCompleteOrder}
              disabled={!canComplete}
              className="flex-1"
            >
              {isWCOrder ? "Complete & Fulfill" : "Complete Order"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
