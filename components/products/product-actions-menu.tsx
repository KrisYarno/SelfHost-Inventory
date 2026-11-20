"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
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

// FR1-1: the press guard is set in the commit that mounts the menu (a layout
// effect), so no pointerup can reach an item before it is set. The server
// renders no effects.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

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
 * keyboard (Enter / Space) to Radix's keydown. FR1-7: a `pointercancel` clears
 * the recorded type, and a click with no pointer behind it (`detail === 0`:
 * assistive technology, or the click that follows Radix's keydown) only ever
 * OPENS the menu, never closes it.
 *
 * The press guard (FR1-1): on Linux and macOS a right-click's `contextmenu`
 * arrives on mouse-DOWN, so a menu opened by the row's or tile's press is
 * already open under the pointer when the button is released, and Radix clicks
 * an item on a `pointerup` that had no `pointerdown` on it. When the owner
 * opened the menu by a press (`openedByPress`), no item chooses anything until
 * a `pointerdown` inside the menu: each item's `pointerup` calls
 * `preventDefault()` (Radix then skips its click) and a pointer click before
 * that is refused, leaving the menu open. Any button but the primary never
 * chooses on its `pointerup`. A keyboard selection (`detail === 0`) always works.
 */
export function ProductActionsMenu({
  product,
  isAdmin,
  open,
  onOpenChange,
  openedByPress,
  onAdjust,
  onStockIn,
  onEdit,
  onDelete,
}: {
  product: ProductWithQuantity; isAdmin: boolean;
  open: boolean; onOpenChange: (open: boolean) => void;
  /** FR1-1: true when the owner opened the menu through `useLongPress`; false through the "…" or the keyboard. */
  openedByPress: boolean;
  onAdjust: (p: ProductWithQuantity) => void; onStockIn: (p: ProductWithQuantity) => void; onEdit?: (p: ProductWithQuantity) => void; onDelete?: (p: ProductWithQuantity) => void;
}): JSX.Element {
  const pointerTypeRef = useRef<string | null>(null);
  const showAdminItems = isAdmin && (onEdit !== undefined || onDelete !== undefined);

  // FR1-1: set when `open` becomes true with `openedByPress`; cleared by the
  // first pointerdown inside the menu (and whenever it closes).
  const pressGuardRef = useRef(false);
  const wasOpenRef = useRef(false);
  useIsomorphicLayoutEffect(() => {
    if (open && !wasOpenRef.current) pressGuardRef.current = openedByPress;
    if (!open) pressGuardRef.current = false;
    wasOpenRef.current = open;
  }, [open, openedByPress]);

  // FR1-1: the guard every item carries. `run` is the item's own action (a
  // link item has none: its navigation is the action, and a refused click's
  // `preventDefault()` stops it).
  const guardItem = (run?: () => void) => ({
    onPointerUp: (event: ReactPointerEvent) => {
      if (event.button !== 0 || pressGuardRef.current) event.preventDefault();
    },
    onClick: (event: ReactMouseEvent) => {
      if (pressGuardRef.current && event.detail !== 0) {
        event.preventDefault();
        return;
      }
      run?.();
    },
  });

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        asChild
        onPointerDown={(event) => {
          pointerTypeRef.current = event.pointerType;
          if (event.pointerType !== "mouse") event.preventDefault();
        }}
        onPointerCancel={() => {
          pointerTypeRef.current = null;
        }}
        onClick={(event) => {
          const pointerType = pointerTypeRef.current;
          pointerTypeRef.current = null;
          if (event.detail === 0) {
            if (!open) onOpenChange(true);
            return;
          }
          if (pointerType === "touch" || pointerType === "pen") onOpenChange(!open);
        }}
      >
        <Button variant="ghost" size="icon" aria-label={`More actions for ${product.name}`}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onPointerDownCapture={() => {
          pressGuardRef.current = false;
        }}
      >
        <DropdownMenuItem {...guardItem(() => onAdjust(product))}>
          <SlidersHorizontal className="mr-2 h-4 w-4" />
          Adjust stock
        </DropdownMenuItem>
        <DropdownMenuItem {...guardItem(() => onStockIn(product))}>
          <PackagePlus className="mr-2 h-4 w-4" />
          Stock In
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* The per-product deep page: Analytics (the bare Performance URL) and
            History (the ?tab=history deep link, D-L2). */}
        <DropdownMenuItem asChild {...guardItem()}>
          <Link href={`/analytics/product/${product.id}`}>
            <TrendingUp className="mr-2 h-4 w-4" />
            Analytics
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild {...guardItem()}>
          <Link href={`/analytics/product/${product.id}?tab=history`}>
            <History className="mr-2 h-4 w-4" />
            History
          </Link>
        </DropdownMenuItem>
        {showAdminItems && (
          <>
            <DropdownMenuSeparator />
            {onEdit && (
              <DropdownMenuItem {...guardItem(() => onEdit(product))}>
                <Edit className="mr-2 h-4 w-4" />
                Edit
              </DropdownMenuItem>
            )}
            {onDelete && (
              <DropdownMenuItem {...guardItem(() => onDelete(product))} className="text-destructive">
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
