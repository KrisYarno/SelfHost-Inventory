"use client";

import { useState } from "react";
import { OrderItem } from "@/types/workbench";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Minus, Plus, Trash2, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface OrderItemProps {
  item: OrderItem;
  onUpdateQuantity: (quantity: number) => void;
  onRemove: () => void;
  className?: string;
}

export function OrderItemComponent({
  item,
  onUpdateQuantity,
  onRemove,
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

  return (
    <div
      className={cn(
        "flex items-center gap-3 p-3 rounded-lg border bg-card",
        "hover:shadow-sm transition-shadow",
        className
      )}
    >
      {/* Product Info */}
      <div className="flex-1 min-w-0">
        <h4 className="font-medium text-sm truncate">
          {item.product.name}
        </h4>
        <p className="text-xs text-muted-foreground">
          Stock: {item.product.currentQuantity}
        </p>
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
              disabled={item.quantity <= 1}
            >
              <Minus className="h-3 w-3" />
            </Button>

            <button
              onClick={() => setIsEditing(true)}
              className="min-w-[3rem] px-2 py-1 text-center font-medium hover:bg-muted rounded transition-colors"
            >
              {item.quantity}
            </button>

            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={handleIncrement}
              disabled={item.quantity >= item.product.currentQuantity}
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
              autoFocus
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={handleEditConfirm}
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
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}