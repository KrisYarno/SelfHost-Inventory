"use client";

import { ProductWithQuantity } from "@/types/product";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MoreHorizontal, Edit, Trash2, TrendingUp, TrendingDown, Package } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

interface ProductCardProps {
  product: ProductWithQuantity;
  onEdit?: (product: ProductWithQuantity) => void;
  onDelete?: (product: ProductWithQuantity) => void;
  onQuickAdjust?: (product: ProductWithQuantity) => void;
  onStockIn?: (product: ProductWithQuantity) => void;
  isAdmin?: boolean;
  showInventoryActions?: boolean;
  className?: string;
}

export function ProductCard({
  product,
  onEdit,
  onDelete,
  onQuickAdjust,
  onStockIn,
  isAdmin = false,
  showInventoryActions = false,
  className,
}: ProductCardProps) {
  return (
    <Card 
      className={cn(
        "relative overflow-hidden transition-all duration-300 hover:shadow-lg",
        className
      )}
    >
      <div className="p-4">
        {/* Actions menu */}
        {(isAdmin || showInventoryActions) && (onEdit || onDelete || onQuickAdjust || onStockIn) && (
          <div className="absolute right-2 top-2 z-10">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 bg-background/80 backdrop-blur-sm hover:bg-background"
                >
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sr-only">Open menu</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* Inventory Actions */}
                {showInventoryActions && (onQuickAdjust || onStockIn) && (
                  <>
                    {onStockIn && (
                      <DropdownMenuItem onClick={() => onStockIn(product)}>
                        <Package className="mr-2 h-4 w-4" />
                        Stock In
                      </DropdownMenuItem>
                    )}
                    {onQuickAdjust && (
                      <DropdownMenuItem onClick={() => onQuickAdjust(product)}>
                        <TrendingUp className="mr-2 h-4 w-4" />
                        Quick Adjust
                      </DropdownMenuItem>
                    )}
                    {isAdmin && (onEdit || onDelete) && <DropdownMenuSeparator />}
                  </>
                )}
                
                {/* Admin Actions */}
                {isAdmin && onEdit && (
                  <DropdownMenuItem onClick={() => onEdit(product)}>
                    <Edit className="mr-2 h-4 w-4" />
                    Edit
                  </DropdownMenuItem>
                )}
                {isAdmin && onDelete && (
                  <DropdownMenuItem 
                    onClick={() => onDelete(product)}
                    className="text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}

        {/* Product info */}
        <div className="space-y-2">
          <div>
            <h3 className="font-semibold text-lg leading-tight">
              {product.baseName}
            </h3>
            <p className="text-sm text-muted-foreground">
              {product.variant}
            </p>
          </div>

          {/* Badges */}
          <div className="flex items-center gap-2">
            <Badge 
              variant={product.currentQuantity > 0 ? "default" : "destructive"}
              className="text-xs font-mono"
            >
              Qty: {product.currentQuantity}
            </Badge>
          </div>

        </div>
      </div>
    </Card>
  );
}