"use client";

import { ValueChip } from "@/components/ui/value-chip";
import { StatusBadge } from "@/components/ui/status-badge";
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

  const isOutOfStock = currentQuantity === 0;
  const isLowStock = currentQuantity > 0 && currentQuantity <= (product.lowStockThreshold || 10);

  const handleQuantityChange = (change: number) => {
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
        "rounded-xl border transition-colors overflow-visible shadow-md",
        hasChange
          ? delta > 0
            ? "border-positive-border bg-positive-muted"
            : "border-negative-border bg-negative-muted"
          : isOutOfStock
            ? "border-negative-border/50 bg-negative-muted/30"
            : isLowStock
              ? "border-warning-border/50 bg-warning-muted/30"
              : "border-border/70 bg-surface"
      )}
      role="article"
      aria-label={`Product ${product.name}, current quantity ${currentQuantity}`}
      tabIndex={0}
    >
      <div className="p-3 sm:p-4">
        {/* Desktop: single row */}
        <div className="hidden sm:flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="text-h4 truncate" id={`product-name-${product.id}`}>{product.name}</h4>
              {isOutOfStock && (
                <StatusBadge tone="negative" className="flex-shrink-0">Out</StatusBadge>
              )}
              {isLowStock && (
                <StatusBadge tone="warning" className="flex-shrink-0">Low</StatusBadge>
              )}
            </div>
          </div>
          <div className="text-right flex-shrink-0 mr-2">
            <div className="text-metric font-mono tabular-nums" role="status" aria-label={`Current quantity: ${currentQuantity}`}>
              {currentQuantity}
            </div>
            <div className="text-caption text-muted-foreground">current</div>
          </div>
          <AdjustmentInput
            value={adjustment?.quantityChange || 0}
            onChange={handleQuantityChange}
            currentQuantity={currentQuantity}
            productName={product.name}
          />
        </div>

        {/* Mobile: stacked layout */}
        <div className="sm:hidden space-y-2">
          {/* Row 1: Name + badges + current qty */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <h4 className="text-body-lg font-semibold truncate" id={`product-name-mobile-${product.id}`}>{product.name}</h4>
              {isOutOfStock && <StatusBadge tone="negative" className="flex-shrink-0 text-[10px] px-1.5 py-0">Out</StatusBadge>}
              {isLowStock && <StatusBadge tone="warning" className="flex-shrink-0 text-[10px] px-1.5 py-0">Low</StatusBadge>}
            </div>
            <div className="text-right flex-shrink-0">
              <span className="text-lg font-bold font-mono tabular-nums" role="status" aria-label={`Current quantity: ${currentQuantity}`}>
                {currentQuantity}
              </span>
              <span className="text-[10px] text-muted-foreground ml-1">current</span>
            </div>
          </div>
          {/* Row 2: Full-width adjustment controls */}
          <div className="flex justify-center">
            <AdjustmentInput
              value={adjustment?.quantityChange || 0}
              onChange={handleQuantityChange}
              currentQuantity={currentQuantity}
              productName={product.name}
            />
          </div>
        </div>

        {/* Change preview row */}
        {hasChange && (
          <div className="mt-2 flex items-center justify-end gap-2" role="status" aria-live="polite">
            <span className="text-caption text-muted-foreground">New:</span>
            <ValueChip tone={delta > 0 ? "positive" : "negative"} className="text-body-sm font-mono tabular-nums">
              {adjustedQuantity}
            </ValueChip>
            <ValueChip tone={delta > 0 ? "positive" : "negative"} className="text-caption">
              {delta > 0 ? "+" : ""}{delta}
            </ValueChip>
          </div>
        )}
      </div>
    </SwipeableAdjustment>
  );
}
