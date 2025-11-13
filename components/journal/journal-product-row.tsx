"use client";

import { ValueChip } from "@/components/ui/value-chip";
import { cn } from "@/lib/utils";
import { AdjustmentInput } from "./adjustment-input";
import { SwipeableAdjustment } from "./swipeable-adjustment";
import type { ProductWithQuantity } from "@/types/product";
import type { JournalAdjustment } from "@/hooks/use-journal";

interface JournalProductRowProps {
  product: ProductWithQuantity;
  adjustment?: JournalAdjustment;
  onQuantityChange: (change: number) => void;
}

export function JournalProductRow({
  product,
  adjustment,
  onQuantityChange,
}: JournalProductRowProps) {
  const currentQuantity = product.currentQuantity || 0;
  const delta = adjustment?.quantityChange || 0;
  const adjustedQuantity = currentQuantity + delta;
  const hasChange = delta !== 0;

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
        "rounded-lg border transition-colors overflow-visible",
        hasChange
          ? delta > 0
            ? "border-emerald-500/50 bg-emerald-500/5"
            : "border-red-500/50 bg-red-500/5"
          : "border-border bg-card"
      )}
      role="article"
      aria-label={`Product ${product.name}, current quantity ${currentQuantity}`}
      tabIndex={0}
    >
      <div className="p-4 pr-2">
        <div className="flex items-center gap-3 sm:gap-4">
        {/* Product Info */}
        <div className="flex-1 min-w-0">
          <h4 className="font-medium truncate" id={`product-name-${product.id}`}>{product.name}</h4>
          <div className="flex items-center gap-2 mt-1">
            <ValueChip tone="neutral" className="text-[11px]" role="status" aria-label={`Current quantity: ${currentQuantity}`}>
              Current: {currentQuantity}
            </ValueChip>
            {hasChange && (
              <>
                <span className="text-muted-foreground text-xs">-&gt;</span>
                <ValueChip
                  tone={delta > 0 ? "positive" : "negative"}
                  className="text-[11px]"
                  role="status"
                  aria-label={`New quantity will be: ${adjustedQuantity}`}
                >
                  New: {adjustedQuantity}
                </ValueChip>
              </>
            )}
          </div>
        </div>

        {/* Adjustment Controls */}
        <div className="flex items-center gap-2 flex-shrink-0">
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
          <ValueChip tone={delta > 0 ? "positive" : "negative"}>
            {delta > 0 ? "+" : ""}
            {delta} units
          </ValueChip>
        </div>
      )}
      </div>
    </SwipeableAdjustment>
  );
}
