"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ShoppingCart } from "lucide-react";
import { cn } from "@/lib/utils";

interface FloatingCartButtonProps {
  itemCount: number;
  /**
   * Facelift F0-1: the selected store order's skipped lines (0 with no store
   * order). An order whose every line is skipped has an empty cart, and this
   * button is the phone's only way into the sheet that lists those lines.
   */
  skippedCount: number;
  onClick: () => void;
  className?: string;
}

export function FloatingCartButton({
  itemCount,
  skippedCount,
  onClick,
  className,
}: FloatingCartButtonProps) {
  if (itemCount === 0 && skippedCount === 0) return null;

  return (
    <Button
      onClick={onClick}
      size="icon"
      className={cn(
        "fixed right-4 z-30",
        "h-14 w-14 rounded-full shadow-lg",
        "bg-primary hover:bg-primary/90",
        "transition-all duration-300",
        "hover:scale-110 active:scale-95",
        className
      )}
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 4.5rem)" }}
    >
      <ShoppingCart className="h-6 w-6" />
      <Badge
        variant="destructive"
        className="absolute -top-2 -right-2 h-6 w-6 p-0 flex items-center justify-center"
      >
        {itemCount > 0 ? (itemCount > 99 ? "99+" : itemCount) : "!"}
      </Badge>
      <span className="sr-only">
        {skippedCount === 0
          ? `View cart (${itemCount} items)`
          : `View order (${itemCount} items, ${skippedCount} not deducted)`}
      </span>
    </Button>
  );
}
