"use client";

import { ProductWithQuantity } from "@/types/product";
import { Badge } from "@/components/ui/badge";
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
        "group relative flex flex-col items-center p-4 rounded-lg border bg-card text-card-foreground transition-all",
        "hover:shadow-md hover:border-primary/50",
        "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        "min-h-[120px]",
        className
      )}
    >
      {/* Stock badges */}
      <div className="absolute top-2 right-2">
        {isOutOfStock && (
          <Badge
            variant="destructive"
            className="text-xs px-1.5 py-0.5"
          >
            Out
          </Badge>
        )}
        {isLowStock && (
          <Badge
            variant="secondary"
            className="text-xs px-1.5 py-0.5 bg-warning/20 text-warning-foreground"
          >
            Low
          </Badge>
        )}
      </div>

      {/* Product Info */}
      <div className="text-center space-y-1 flex-1 flex flex-col justify-center pt-4">
        <h3 className="font-medium text-sm line-clamp-1">{product.baseName}</h3>
        <p className="text-xs text-muted-foreground">{product.variant}</p>
        <p className="text-xs font-medium">
          Stock: <span className={cn(
            isOutOfStock && "text-destructive",
            isLowStock && "text-warning"
          )}>{product.currentQuantity}</span>
        </p>
      </div>

      {/* Hover effect */}
      {!isOutOfStock && (
        <div className="absolute inset-0 rounded-lg bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
      )}
    </button>
  );
}