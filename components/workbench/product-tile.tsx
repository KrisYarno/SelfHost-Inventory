"use client";

import { ProductWithQuantity } from "@/types/product";
import { ValueChip } from "@/components/ui/value-chip";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";

interface ProductTileProps {
  product: ProductWithQuantity;
  onClick: (product: ProductWithQuantity) => void;
  className?: string;
}

export function ProductTile({ product, onClick, className }: ProductTileProps) {
  const isOutOfStock = product.currentQuantity === 0;
  const isLowStock = product.currentQuantity > 0 && product.currentQuantity <= 5;

  return (
    <button
      onClick={() => !isOutOfStock && onClick(product)}
      disabled={isOutOfStock}
      className={cn(
        "group relative flex flex-col items-center p-4 rounded-2xl border border-border/70",
        "bg-surface",
        "shadow-md hover:shadow-lg",
        "hover:-translate-y-0.5 transition-all duration-200",
        "focus:outline-none focus:ring-2 focus:ring-primary/70 focus:ring-offset-2",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        "min-h-[140px]",
        className
      )}
    >
      {/* Product Info */}
      <div className="text-center space-y-1 flex-1 flex flex-col justify-center">
        <h3 className="font-medium text-sm line-clamp-1">{product.baseName}</h3>
        <p className="text-xs text-muted-foreground">{product.variant}</p>
        <div className="flex items-center justify-center gap-1.5 flex-wrap">
          <ValueChip
            tone={
              product.currentQuantity > 0
                ? "positive"
                : product.currentQuantity < 0
                ? "negative"
                : "neutral"
            }
          >
            Stock: {product.currentQuantity}
          </ValueChip>
          {isOutOfStock && (
            <StatusBadge tone="negative">Out</StatusBadge>
          )}
          {!isOutOfStock && isLowStock && (
            <StatusBadge tone="warning">Low</StatusBadge>
          )}
        </div>
      </div>

      {/* Hover effect */}
      {!isOutOfStock && (
        <div className="absolute inset-0 rounded-2xl bg-primary/10 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
      )}
    </button>
  );
}
