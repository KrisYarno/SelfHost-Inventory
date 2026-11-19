"use client";

import { useId, useState } from "react";
import type { ProductWithQuantity } from "@/types/product";
import { StatusBadge } from "@/components/ui/status-badge";
import { useLongPress } from "@/hooks/use-long-press";
import { ProductStock } from "./product-stock";
import { ProductActionsMenu } from "./product-actions-menu";

interface ProductRowProps {
  product: ProductWithQuantity;
  isAdmin: boolean;
  /** The answer's `hereLocationId` echo. */
  hereLocationId: number | null | undefined;
  /** The CONFIRMED location's id, or null. */
  selectedLocationId: number | null;
  onAdjust: (product: ProductWithQuantity) => void;
  onStockIn: (product: ProductWithQuantity) => void;
  onEdit?: (product: ProductWithQuantity) => void;
  onDelete?: (product: ProductWithQuantity) => void;
}

/**
 * One product in the List view below `lg` (facelift F2-8). The host renders the
 * rows inside one bordered `bg-surface rounded-lg divide-y` container.
 *
 * The main area is a button: a tap opens Adjust stock, a long press opens the
 * actions menu (the same instance as the "…"). No icon, no aspect ratio, no
 * ribbon, no `active:scale`, and no absolutely positioned children.
 */
export function ProductRow({
  product,
  isAdmin,
  hereLocationId,
  selectedLocationId,
  onAdjust,
  onStockIn,
  onEdit,
  onDelete,
}: ProductRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  // Idempotent opener (A2): a long press never closes the menu.
  const { handlers, shouldIgnoreClick } = useLongPress(() => setMenuOpen(true));
  // B12: per-instance ids; the row and the table row are in the DOM at once.
  const id = useId();
  const stockId = `${id}-stock`;
  const pendingId = `${id}-pending`;
  const isPending = product.approvalStatus === "PENDING_REVIEW";

  return (
    <div className="flex min-h-14 items-center gap-2 px-3">
      <button
        type="button"
        className="min-w-0 flex-1 text-left flex items-center gap-3 self-stretch select-none [-webkit-user-select:none] [-webkit-touch-callout:none]"
        aria-label={`Adjust stock for ${product.name}`}
        aria-describedby={isPending ? `${stockId} ${pendingId}` : stockId}
        {...handlers}
        onClick={(event) => {
          // B6: a keyboard click (detail 0) is never ignored.
          if (event.detail !== 0 && shouldIgnoreClick()) return;
          onAdjust(product);
        }}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate">{product.baseName}</div>
          {(product.variant || isPending) && (
            <div className="flex min-w-0 items-center gap-2">
              {product.variant && (
                <div className="text-xs text-muted-foreground truncate">{product.variant}</div>
              )}
              {isPending && (
                <StatusBadge id={pendingId} tone="info" className="shrink-0">
                  Pending review
                </StatusBadge>
              )}
            </div>
          )}
        </div>
        <ProductStock
          id={stockId}
          product={product}
          hereLocationId={hereLocationId}
          selectedLocationId={selectedLocationId}
          className="shrink-0 items-end text-right"
        />
      </button>
      <ProductActionsMenu
        product={product}
        isAdmin={isAdmin}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        onAdjust={onAdjust}
        onStockIn={onStockIn}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    </div>
  );
}
