"use client";

import { useId, useState } from "react";
import type { ProductWithQuantity } from "@/types/product";
import { StatusBadge } from "@/components/ui/status-badge";
import { useLongPress } from "@/hooks/use-long-press";
import { ProductStock } from "./product-stock";
import { ProductActionsMenu } from "./product-actions-menu";

interface ProductGridTileProps {
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
 * One product in the Grid view, every width (facelift F2-8, A19, A24, B3). The
 * host lays the tiles out in `grid grid-cols-2 gap-2 sm:grid-cols-3
 * lg:grid-cols-4 xl:grid-cols-5`.
 *
 * A full-tile button (a tap opens Adjust stock, a long press the actions menu)
 * with the "…" in an absolutely positioned WRAPPER (B3): the Button inside it
 * carries no `absolute`, so it keeps the 44 px phone floor. The text block's
 * `pr-12` keeps it clear of the "…". No icon, aspect ratio or ribbon.
 */
export function ProductGridTile({
  product,
  isAdmin,
  hereLocationId,
  selectedLocationId,
  onAdjust,
  onStockIn,
  onEdit,
  onDelete,
}: ProductGridTileProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  // Idempotent opener (A2): a long press never closes the menu.
  const { handlers, shouldIgnoreClick } = useLongPress(() => setMenuOpen(true));
  // B12: per-instance ids.
  const id = useId();
  const stockId = `${id}-stock`;
  const pendingId = `${id}-pending`;
  const isPending = product.approvalStatus === "PENDING_REVIEW";

  return (
    <div className="relative rounded-lg border bg-surface">
      <button
        type="button"
        className="p-3 text-left min-h-28 flex h-full w-full flex-col gap-2 select-none [-webkit-user-select:none] [-webkit-touch-callout:none]"
        aria-label={`Adjust stock for ${product.name}`}
        aria-describedby={isPending ? `${stockId} ${pendingId}` : stockId}
        {...handlers}
        onClick={(event) => {
          // B6: a keyboard click (detail 0) is never ignored.
          if (event.detail !== 0 && shouldIgnoreClick()) return;
          onAdjust(product);
        }}
      >
        <div className="min-w-0 pr-12">
          <div className="text-sm font-semibold line-clamp-2">{product.baseName}</div>
          {product.variant && (
            <div className="text-xs text-muted-foreground truncate">{product.variant}</div>
          )}
          {isPending && (
            <StatusBadge id={pendingId} tone="info" className="mt-1">
              Pending review
            </StatusBadge>
          )}
        </div>
        <ProductStock
          id={stockId}
          product={product}
          hereLocationId={hereLocationId}
          selectedLocationId={selectedLocationId}
          className="mt-auto"
        />
      </button>
      <div className="absolute right-1 top-1">
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
    </div>
  );
}
