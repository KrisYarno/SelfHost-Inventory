"use client";

import { AlertTriangle, TrendingUp, TrendingDown } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { ProductWithQuantity } from "@/types/product";
import type { JournalAdjustment } from "@/hooks/use-journal";

interface ReviewChangesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adjustments: Record<number, JournalAdjustment>;
  products: ProductWithQuantity[];
  onConfirm: () => void;
  isSubmitting?: boolean;
}

export function ReviewChangesDialog({
  open,
  onOpenChange,
  adjustments,
  products,
  onConfirm,
  isSubmitting = false,
}: ReviewChangesDialogProps) {
  const adjustmentList = Object.values(adjustments);
  const productMap = new Map(products.map((p) => [p.id, p]));

  const totals = adjustmentList.reduce(
    (acc, adj) => {
      if (adj.quantityChange > 0) {
        acc.additions += adj.quantityChange;
      } else {
        acc.removals += Math.abs(adj.quantityChange);
      }
      acc.net += adj.quantityChange;
      return acc;
    },
    { additions: 0, removals: 0, net: 0 }
  );

  // Check for any products that would go negative
  const negativeStockWarnings = adjustmentList.filter((adj) => {
    const product = productMap.get(adj.productId);
    if (!product) return false;
    const newQuantity = (product.currentQuantity || 0) + adj.quantityChange;
    return newQuantity < 0;
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" aria-describedby="dialog-description">
        <DialogHeader>
          <DialogTitle id="dialog-title">Review Changes</DialogTitle>
          <DialogDescription id="dialog-description">
            Please review your inventory adjustments before submitting.
          </DialogDescription>
        </DialogHeader>

        {/* Summary Stats */}
        <div className="grid grid-cols-3 gap-4 py-4" role="group" aria-label="Summary statistics">
          <div className="text-center">
            <div className="text-2xl font-bold" aria-hidden="true">{adjustmentList.length}</div>
            <div className="text-sm text-muted-foreground">Products</div>
            <span className="sr-only">{adjustmentList.length} products will be adjusted</span>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-green-600" aria-hidden="true">
              +{totals.additions}
            </div>
            <div className="text-sm text-muted-foreground">Added</div>
            <span className="sr-only">{totals.additions} units will be added to inventory</span>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-red-600" aria-hidden="true">
              -{totals.removals}
            </div>
            <div className="text-sm text-muted-foreground">Removed</div>
            <span className="sr-only">{totals.removals} units will be removed from inventory</span>
          </div>
        </div>

        <Separator />

        {/* Warnings */}
        {negativeStockWarnings.length > 0 && (
          <>
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4" role="alert" aria-live="assertive">
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" aria-hidden="true" />
                <span className="font-medium" id="warning-title">Stock Warning</span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {negativeStockWarnings.length} product(s) would have negative stock after these adjustments.
              </p>
            </div>
            <Separator />
          </>
        )}

        {/* Adjustment List */}
        <ScrollArea className="h-[300px] pr-4" aria-label="List of inventory adjustments">
          <div className="space-y-3" role="list">
            {adjustmentList.map((adjustment) => {
              const product = productMap.get(adjustment.productId);
              if (!product) return null;

              const newQuantity = (product.currentQuantity || 0) + adjustment.quantityChange;
              const isNegative = newQuantity < 0;

              return (
                <div
                  key={adjustment.productId}
                  className="flex items-center gap-3 p-3 rounded-lg border"
                  role="listitem"
                  aria-label={`${product.name}: changing from ${product.currentQuantity || 0} to ${newQuantity}`}
                >
                  <div className="flex-1">
                    <h3 className="font-medium">{product.name}</h3>
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">
                        {product.currentQuantity || 0}
                      </span>
                      <span className="text-muted-foreground">→</span>
                      <span className={isNegative ? "text-destructive" : ""}>
                        {newQuantity}
                      </span>
                      {isNegative && (
                        <Badge variant="destructive" className="text-xs" role="alert">
                          Negative Stock
                        </Badge>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2" aria-hidden="true">
                    {adjustment.quantityChange > 0 ? (
                      <TrendingUp className="h-4 w-4 text-green-600" aria-label="Increase" />
                    ) : (
                      <TrendingDown className="h-4 w-4 text-red-600" aria-label="Decrease" />
                    )}
                    <span
                      className={
                        adjustment.quantityChange > 0
                          ? "text-green-600 font-medium"
                          : "text-red-600 font-medium"
                      }
                    >
                      {adjustment.quantityChange > 0 ? "+" : ""}
                      {adjustment.quantityChange}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>

        <Separator />

        {/* Net Change */}
        <div className="flex items-center justify-between py-2" role="status" aria-live="polite">
          <span className="font-medium">Net Change</span>
          <Badge variant="outline" className="text-lg font-mono" aria-label={`Net change: ${totals.net > 0 ? "+" : ""}${totals.net} units`}>
            {totals.net > 0 ? "+" : ""}{totals.net}
          </Badge>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
            aria-label="Cancel and close dialog"
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={isSubmitting || negativeStockWarnings.length > 0}
            aria-label={isSubmitting ? "Submitting adjustments" : "Confirm and submit adjustments"}
            aria-describedby={negativeStockWarnings.length > 0 ? "negative-stock-warning" : undefined}
          >
            {isSubmitting ? "Submitting..." : "Confirm Adjustments"}
          </Button>
        </DialogFooter>
        {negativeStockWarnings.length > 0 && (
          <span className="sr-only" id="negative-stock-warning">
            Cannot submit because some products would have negative stock
          </span>
        )}
      </DialogContent>
    </Dialog>
  );
}