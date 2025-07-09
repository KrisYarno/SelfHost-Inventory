"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { AdjustmentInput } from "./adjustment-input";
import { SwipeableAdjustment } from "./swipeable-adjustment";
import type { ProductWithQuantity } from "@/types/product";
import type { JournalAdjustment } from "@/hooks/use-journal";

interface JournalProductRowProps {
  product: ProductWithQuantity;
  adjustment?: JournalAdjustment;
  onQuantityChange: (change: number) => void;
  index?: number;
}

export function JournalProductRow({
  product,
  adjustment,
  onQuantityChange,
  index = 0,
}: JournalProductRowProps) {
  const currentQuantity = product.currentQuantity || 0;
  const adjustedQuantity = currentQuantity + (adjustment?.quantityChange || 0);
  const hasChange = adjustment && adjustment.quantityChange !== 0;

  const handleQuantityChange = (change: number) => {
    console.log(`JournalProductRow: handleQuantityChange for product ${product.id} (${product.name}), new change: ${change}`);
    onQuantityChange(change);
  };

  const handleSwipeRight = () => {
    handleQuantityChange((adjustment?.quantityChange || 0) + 1);
  };

  const handleSwipeLeft = () => {
    handleQuantityChange((adjustment?.quantityChange || 0) - 1);
  };

  return (
    <SwipeableAdjustment
      onSwipeRight={handleSwipeRight}
      onSwipeLeft={handleSwipeLeft}
      className={cn(
        "rounded-lg border transition-colors",
        hasChange && "border-primary/50 bg-primary/5"
      )}
      role="article"
      aria-label={`Product ${product.name}, current quantity ${currentQuantity}`}
      tabIndex={0}
    >
      <div className="p-4">
        <div className="flex items-center gap-4">
        {/* Product Info */}
        <div className="flex-1 min-w-0">
          <h4 className="font-medium truncate" id={`product-name-${product.id}`}>{product.name}</h4>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant="outline" className="text-xs" role="status" aria-label={`Current quantity: ${currentQuantity}`}>
              Current: {currentQuantity}
            </Badge>
            {hasChange && (
              <>
                <span className="text-muted-foreground">→</span>
                <Badge
                  variant={adjustment.quantityChange > 0 ? "default" : "destructive"}
                  className="text-xs"
                  role="status"
                  aria-label={`New quantity will be: ${adjustedQuantity}`}
                >
                  New: {adjustedQuantity}
                </Badge>
              </>
            )}
          </div>
        </div>

        {/* Adjustment Controls */}
        <div className="flex items-center gap-2">
          <AdjustmentInput
            value={adjustment?.quantityChange || 0}
            onChange={handleQuantityChange}
            currentQuantity={currentQuantity}
            productName={product.name}
          />
        </div>
      </div>

      {/* Change Indicator */}
      {hasChange && (
        <div className="mt-2 pl-[72px]" role="status" aria-live="polite">
          <span
            className={cn(
              "text-sm font-medium",
              adjustment.quantityChange > 0 ? "text-green-600" : "text-red-600"
            )}
            aria-label={`Change: ${adjustment.quantityChange > 0 ? "increase" : "decrease"} by ${Math.abs(adjustment.quantityChange)} units`}
          >
            {adjustment.quantityChange > 0 ? "+" : ""}
            {adjustment.quantityChange} units
          </span>
        </div>
      )}
      </div>
    </SwipeableAdjustment>
  );
}