"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ShoppingCart } from "lucide-react";
import { cn } from "@/lib/utils";

interface FloatingCartButtonProps {
  itemCount: number;
  onClick: () => void;
  className?: string;
}

export function FloatingCartButton({
  itemCount,
  onClick,
  className,
}: FloatingCartButtonProps) {
  if (itemCount === 0) return null;

  return (
    <Button
      onClick={onClick}
      size="icon"
      className={cn(
        "fixed bottom-20 right-4 z-30",
        "h-14 w-14 rounded-full shadow-lg",
        "bg-primary hover:bg-primary/90",
        "transition-all duration-300",
        "hover:scale-110 active:scale-95",
        className
      )}
    >
      <ShoppingCart className="h-6 w-6" />
      {itemCount > 0 && (
        <Badge
          variant="destructive"
          className="absolute -top-2 -right-2 h-6 w-6 p-0 flex items-center justify-center"
        >
          {itemCount > 99 ? "99+" : itemCount}
        </Badge>
      )}
      <span className="sr-only">View cart ({itemCount} items)</span>
    </Button>
  );
}