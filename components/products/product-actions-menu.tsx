"use client";

import { useRef } from "react";
import Link from "next/link";
import {
  Edit,
  History,
  MoreHorizontal,
  PackagePlus,
  SlidersHorizontal,
  Trash2,
  TrendingUp,
} from "lucide-react";
import type { ProductWithQuantity } from "@/types/product";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * A product's actions menu (facelift F2-7, A2 as replaced by B7). ONE controlled
 * menu per product: its trigger is the 44 px "…", so a long press on the row
 * or tile (which sets `open`) and the "…" open the SAME instance, anchored to
 * the "…". The open state is owned by the row, tile or table row.
 *
 * The trigger (B7): its own `onPointerDown` records the pointer type and, for a
 * non-mouse pointer, calls `preventDefault()`, which stops Radix's pointerdown
 * open (a scroll that starts on the "…" never opens it). A touch or pen press
 * opens on its click instead. A mouse is left to Radix's pointerdown, and the
 * keyboard (Enter / Space) to Radix's keydown.
 */
export function ProductActionsMenu({
  product,
  isAdmin,
  open,
  onOpenChange,
  onAdjust,
  onStockIn,
  onEdit,
  onDelete,
}: {
  product: ProductWithQuantity; isAdmin: boolean;
  open: boolean; onOpenChange: (open: boolean) => void;
  onAdjust: (p: ProductWithQuantity) => void; onStockIn: (p: ProductWithQuantity) => void; onEdit?: (p: ProductWithQuantity) => void; onDelete?: (p: ProductWithQuantity) => void;
}): JSX.Element {
  const pointerTypeRef = useRef<string | null>(null);
  const showAdminItems = isAdmin && (onEdit !== undefined || onDelete !== undefined);

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        asChild
        onPointerDown={(event) => {
          pointerTypeRef.current = event.pointerType;
          if (event.pointerType !== "mouse") event.preventDefault();
        }}
        onClick={() => {
          const pointerType = pointerTypeRef.current;
          pointerTypeRef.current = null;
          if (pointerType === "touch" || pointerType === "pen") onOpenChange(!open);
        }}
      >
        <Button variant="ghost" size="icon" aria-label={`More actions for ${product.name}`}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onAdjust(product)}>
          <SlidersHorizontal className="mr-2 h-4 w-4" />
          Adjust stock
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onStockIn(product)}>
          <PackagePlus className="mr-2 h-4 w-4" />
          Stock In
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* The per-product deep page: Analytics (the bare Performance URL) and
            History (the ?tab=history deep link, D-L2). */}
        <DropdownMenuItem asChild>
          <Link href={`/analytics/product/${product.id}`}>
            <TrendingUp className="mr-2 h-4 w-4" />
            Analytics
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={`/analytics/product/${product.id}?tab=history`}>
            <History className="mr-2 h-4 w-4" />
            History
          </Link>
        </DropdownMenuItem>
        {showAdminItems && (
          <>
            <DropdownMenuSeparator />
            {onEdit && (
              <DropdownMenuItem onClick={() => onEdit(product)}>
                <Edit className="mr-2 h-4 w-4" />
                Edit
              </DropdownMenuItem>
            )}
            {onDelete && (
              <DropdownMenuItem onClick={() => onDelete(product)} className="text-destructive">
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
