"use client";

import { ProductWithQuantity } from "@/types/product";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Package } from "lucide-react";

interface ProductCardMobileProps {
  product: ProductWithQuantity;
  onClick?: (product: ProductWithQuantity) => void;
  className?: string;
}

export function ProductCardMobile({
  product,
  onClick,
  className,
}: ProductCardMobileProps) {
  const isOutOfStock = product.currentQuantity === 0;
  const isLowStock = product.currentQuantity > 0 && product.currentQuantity <= 10;

  return (
    <Card
      className={cn(
        "relative overflow-hidden transition-all duration-200",
        "hover:shadow-md active:scale-[0.98]",
        "cursor-pointer aspect-square",
        isOutOfStock && "opacity-75",
        className
      )}
      onClick={() => onClick?.(product)}
    >
      {/* Out of Stock Ribbon */}
      {isOutOfStock && (
        <div className="absolute inset-0 z-10 pointer-events-none">
          <div className="absolute top-0 right-0 w-20 h-20 overflow-hidden">
            <div className="absolute transform rotate-45 bg-destructive text-destructive-foreground text-[10px] font-semibold py-0.5 text-center w-24 -right-6 top-4">
              OUT
            </div>
          </div>
        </div>
      )}

      {/* Stock Badge */}
      <div className="absolute top-2 left-2 z-10">
        <Badge
          variant={
            isOutOfStock
              ? "destructive"
              : isLowStock
              ? "warning"
              : "default"
          }
          className="text-[10px] px-1.5 py-0.5 font-mono"
        >
          {product.currentQuantity}
        </Badge>
      </div>

      {/* Content */}
      <div className="flex flex-col items-center justify-center h-full p-3 text-center">
        <Package className="h-8 w-8 text-muted-foreground/30 mb-2" />
        <h3 className="font-medium text-sm leading-tight line-clamp-2">
          {product.baseName}
        </h3>
        {product.variant && (
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
            {product.variant}
          </p>
        )}
      </div>
    </Card>
  );
}