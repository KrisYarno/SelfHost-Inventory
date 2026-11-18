"use client";

import { useState } from "react";
import { OrderItem } from "@/types/workbench";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Minus, Plus, Trash2, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ValueChip } from "@/components/ui/value-chip";
import { StatusBadge } from "@/components/ui/status-badge";

interface OrderItemProps {
  item: OrderItem;
  onUpdateQuantity: (quantity: number) => void;
  onRemove: () => void;
  /**
   * Facelift F0 FR2-1: the steppers, the quantity editor and the bin are
   * disabled — the cart is about to be replaced and an edit would be lost.
   */
  readOnly?: boolean;
  className?: string;
}

export function OrderItemComponent({
  item,
  onUpdateQuantity,
  onRemove,
  readOnly = false,
  className,
}: OrderItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(item.quantity.toString());

  const handleIncrement = () => {
    if (item.quantity < item.product.currentQuantity) {
      onUpdateQuantity(item.quantity + 1);
    }
  };

  const handleDecrement = () => {
    if (item.quantity > 1) {
      onUpdateQuantity(item.quantity - 1);
    }
  };

  const handleEditConfirm = () => {
    if (readOnly) return;
    const newQuantity = parseInt(editValue);
    if (
      !isNaN(newQuantity) &&
      newQuantity > 0 &&
      newQuantity <= item.product.currentQuantity
    ) {
      onUpdateQuantity(newQuantity);
      setIsEditing(false);
    } else {
      setEditValue(item.quantity.toString());
      setIsEditing(false);
    }
  };

  const handleEditCancel = () => {
    setEditValue(item.quantity.toString());
    setIsEditing(false);
  };

  const availableStock = item.product.currentQuantity ?? 0;
  const isOverPicked = item.quantity > availableStock;
  // Facelift F0-1 (FL-C-2): a store-order line that holds fewer units than the
  // order still needs (capped at the stock here, or stepped down) says so on
  // the row. The cap toast it used to rely on alone was gone in seconds.
  const neededQuantity = item.neededQuantity;
  const isShortOfNeeded = neededQuantity !== undefined && item.quantity < neededQuantity;

  return (
    <div
      className={cn(
        "flex items-center gap-3 p-3 rounded-xl border border-border/70",
        "bg-surface",
        "shadow-md hover:shadow-lg transition-shadow",
        isOverPicked && "border-amber-500/60 bg-amber-500/10",
        className
      )}
    >
      {/* Product Info */}
      <div className="flex-1 min-w-0">
        <h4 className="font-medium text-sm truncate">
          {item.product.name}
        </h4>
        {isShortOfNeeded && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {`${neededQuantity} needed · ${item.product.currentQuantity} in stock here · ${neededQuantity - item.quantity} not in this cart`}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <ValueChip
            tone={
              availableStock > 0
                ? "positive"
                : availableStock < 0
                ? "negative"
                : "neutral"
            }
          >
            Stock: {availableStock}
          </ValueChip>
          {item.source === 'wc-order' && (
            <span className="inline-flex items-center rounded-full bg-blue-50 dark:bg-blue-950/40 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
              from order
            </span>
          )}
          {isOverPicked && (
            <StatusBadge tone="warning">Over picked</StatusBadge>
          )}
        </div>
        {isOverPicked && (
          <p className="text-[11px] text-amber-400">
            Requested {item.quantity}, only {availableStock} in stock.
          </p>
        )}
      </div>

      {/* Quantity Controls */}
      <div className="flex items-center gap-1">
        {!isEditing ? (
          <>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={handleDecrement}
              disabled={readOnly || item.quantity <= 1}
            >
              <Minus className="h-3 w-3" />
            </Button>

            <button
              onClick={() => setIsEditing(true)}
              disabled={readOnly}
              className="min-w-[3rem] px-2 py-1 text-center font-medium hover:bg-muted rounded transition-colors disabled:pointer-events-none disabled:opacity-50"
            >
              {item.quantity}
            </button>

            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={handleIncrement}
              disabled={readOnly || item.quantity >= item.product.currentQuantity}
            >
              <Plus className="h-3 w-3" />
            </Button>
          </>
        ) : (
          <>
            <Input
              type="number"
              min="1"
              max={item.product.currentQuantity}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleEditConfirm();
                if (e.key === "Escape") handleEditCancel();
              }}
              className="h-8 w-16 text-center"
              disabled={readOnly}
              autoFocus
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={handleEditConfirm}
              disabled={readOnly}
            >
              <Check className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={handleEditCancel}
            >
              <X className="h-3 w-3" />
            </Button>
          </>
        )}
      </div>

      {/* Remove Button */}
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-destructive hover:text-destructive"
        onClick={onRemove}
        disabled={readOnly}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}
