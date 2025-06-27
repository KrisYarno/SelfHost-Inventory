"use client";

import { useState } from "react";
import { ProductWithQuantity } from "@/types/product";
import { QUICK_QUANTITIES } from "@/types/workbench";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface QuantityPickerProps {
  product: ProductWithQuantity | null;
  open: boolean;
  onClose: () => void;
  onConfirm: (quantity: number) => void;
}

export function QuantityPicker({
  product,
  open,
  onClose,
  onConfirm,
}: QuantityPickerProps) {
  const [quantity, setQuantity] = useState<number>(1);
  const [customMode, setCustomMode] = useState(false);

  if (!product) return null;

  const handleQuickSelect = (value: number) => {
    if (value <= product.currentQuantity) {
      onConfirm(value);
      onClose();
      // Reset state
      setQuantity(1);
      setCustomMode(false);
    }
  };

  const handleCustomConfirm = () => {
    if (quantity > 0 && quantity <= product.currentQuantity) {
      onConfirm(quantity);
      onClose();
      // Reset state
      setQuantity(1);
      setCustomMode(false);
    }
  };

  const handleClose = () => {
    onClose();
    // Reset state
    setQuantity(1);
    setCustomMode(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Select Quantity</DialogTitle>
          <DialogDescription>
            How many units of this product?
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Product Info */}
          <div className="p-3 bg-muted/50 rounded-lg">
            <div className="text-center">
              <p className="font-medium text-sm">{product.name}</p>
              <p className="text-xs text-muted-foreground mt-1">
                Available: {product.currentQuantity} units
              </p>
            </div>
          </div>

          {/* Quick Quantity Buttons */}
          {!customMode && (
            <div className="space-y-3">
              <Label>Quick select:</Label>
              <div className="grid grid-cols-3 gap-2">
                {QUICK_QUANTITIES.map((qty) => (
                  <Button
                    key={qty}
                    variant="outline"
                    size="lg"
                    disabled={qty > product.currentQuantity}
                    onClick={() => handleQuickSelect(qty)}
                    className="h-14 text-lg font-medium"
                  >
                    {qty}
                  </Button>
                ))}
                <Button
                  variant="outline"
                  size="lg"
                  onClick={() => setCustomMode(true)}
                  className="h-14 text-lg font-medium"
                >
                  Custom
                </Button>
              </div>
            </div>
          )}

          {/* Custom Quantity Input */}
          {customMode && (
            <div className="space-y-3">
              <Label htmlFor="custom-quantity">Enter quantity:</Label>
              <Input
                id="custom-quantity"
                type="number"
                min="1"
                max={product.currentQuantity}
                value={quantity}
                onChange={(e) => setQuantity(parseInt(e.target.value) || 0)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleCustomConfirm();
                  }
                }}
                className="text-lg h-12"
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Maximum: {product.currentQuantity}
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="sm:justify-start">
          {customMode && (
            <>
              <Button
                variant="outline"
                onClick={() => setCustomMode(false)}
              >
                Back
              </Button>
              <Button
                onClick={handleCustomConfirm}
                disabled={quantity <= 0 || quantity > product.currentQuantity}
              >
                Add {quantity} to Order
              </Button>
            </>
          )}
          {!customMode && (
            <Button variant="outline" onClick={handleClose}>
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}