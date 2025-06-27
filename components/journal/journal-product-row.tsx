"use client";

import { useState } from "react";
import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { AdjustmentInput } from "./adjustment-input";
import { SwipeableAdjustment } from "./swipeable-adjustment";
import type { ProductWithQuantity } from "@/types/product";
import type { JournalAdjustment } from "@/hooks/use-journal";

interface JournalProductRowProps {
  product: ProductWithQuantity;
  adjustment?: JournalAdjustment;
  onQuantityChange: (change: number, notes?: string) => void;
}

export function JournalProductRow({
  product,
  adjustment,
  onQuantityChange,
}: JournalProductRowProps) {
  const [showNotes, setShowNotes] = useState(!!adjustment?.notes);
  const [notes, setNotes] = useState(adjustment?.notes || "");

  const currentQuantity = product.currentQuantity || 0;
  const adjustedQuantity = currentQuantity + (adjustment?.quantityChange || 0);
  const hasChange = adjustment && adjustment.quantityChange !== 0;

  const handleNotesChange = (value: string) => {
    setNotes(value);
    if (adjustment) {
      onQuantityChange(adjustment.quantityChange, value);
    }
  };

  const handleQuantityChange = (change: number) => {
    onQuantityChange(change, notes || undefined);
  };

  const handleSwipeRight = () => {
    handleQuantityChange((adjustment?.quantityChange || 0) + 1);
  };

  const handleSwipeLeft = () => {
    handleQuantityChange((adjustment?.quantityChange || 0) - 1);
  };

  return (
    <SwipeableAdjustment
      onSwipeRight={handleSwipeRight}
      onSwipeLeft={handleSwipeLeft}
      className={cn(
        "rounded-lg border transition-colors",
        hasChange && "border-primary/50 bg-primary/5"
      )}
    >
      <div className="p-4">
        <div className="flex items-center gap-4">
        {/* Product Info */}
        <div className="flex-1 min-w-0">
          <h4 className="font-medium truncate">{product.name}</h4>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant="outline" className="text-xs">
              Current: {currentQuantity}
            </Badge>
            {hasChange && (
              <>
                <span className="text-muted-foreground">→</span>
                <Badge
                  variant={adjustment.quantityChange > 0 ? "default" : "destructive"}
                  className="text-xs"
                >
                  New: {adjustedQuantity}
                </Badge>
              </>
            )}
          </div>
        </div>

        {/* Adjustment Controls */}
        <div className="flex items-center gap-2">
          <AdjustmentInput
            value={adjustment?.quantityChange || 0}
            onChange={handleQuantityChange}
            currentQuantity={currentQuantity}
          />
          
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowNotes(!showNotes)}
            className={cn(
              "transition-colors",
              (showNotes || notes) && "text-primary"
            )}
          >
            <MessageSquare className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Notes Section */}
      {showNotes && (
        <div className="mt-3 pl-[72px]">
          <Input
            placeholder="Add notes for this adjustment..."
            value={notes}
            onChange={(e) => handleNotesChange(e.target.value)}
            className="text-sm"
          />
        </div>
      )}

      {/* Change Indicator */}
      {hasChange && (
        <div className="mt-2 pl-[72px]">
          <span
            className={cn(
              "text-sm font-medium",
              adjustment.quantityChange > 0 ? "text-green-600" : "text-red-600"
            )}
          >
            {adjustment.quantityChange > 0 ? "+" : ""}
            {adjustment.quantityChange} units
          </span>
        </div>
      )}
      </div>
    </SwipeableAdjustment>
  );
}