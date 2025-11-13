"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Plus, Minus, Package, MapPin } from "lucide-react";
import { useLocation } from "@/contexts/location-context";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ValueChip } from "@/components/ui/value-chip";
import { ContextTag } from "@/components/ui/context-tag";
import { InlineHighlight } from "@/components/ui/inline-highlight";
import type { ProductWithQuantity } from "@/types/product";

interface QuickAdjustDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: ProductWithQuantity;
  onSuccess?: () => void;
}

export function QuickAdjustDialog({
  open,
  onOpenChange,
  product,
  onSuccess,
}: QuickAdjustDialogProps) {
  const { selectedLocationId, locations } = useLocation();
  const { token: csrfToken } = useCSRF();
  const [adjustmentType, setAdjustmentType] = useState<"add" | "remove">("add");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [locationQuantity, setLocationQuantity] = useState<number | null>(null);
  const [loadingQuantity, setLoadingQuantity] = useState(false);

  // Fetch location-specific quantity when dialog opens
  useEffect(() => {
    if (open && product && selectedLocationId) {
      setLoadingQuantity(true);
      fetch(`/api/inventory/product/${product.id}?locationId=${selectedLocationId}`)
        .then(res => res.json())
        .then(data => {
          if (data.currentQuantity !== undefined) {
            setLocationQuantity(data.currentQuantity);
          }
        })
        .catch(err => {
          console.error("Failed to fetch location quantity:", err);
          toast.error("Failed to fetch current quantity");
        })
        .finally(() => setLoadingQuantity(false));
    }
  }, [open, product, selectedLocationId]);

  if (!product) {
    return null;
  }

  const currentQuantity = locationQuantity !== null ? locationQuantity : (product.currentQuantity || 0);
  const quantityNum = parseInt(quantity, 10) || 0;
  const adjustedQuantity = adjustmentType === "add" 
    ? currentQuantity + quantityNum 
    : currentQuantity - quantityNum;
  const selectedLocationName =
    locations.find((loc) => loc.id === selectedLocationId)?.name ?? "Selected location";
  
  const isValid = quantityNum > 0 && reason.trim() && adjustedQuantity >= 0;

  const handleIncrement = () => {
    setQuantity((prev) => {
      const current = Number.parseInt(prev, 10) || 0;
      const next = Math.max(current + 1, 1);
      return String(next);
    });
  };

  const handleDecrement = () => {
    setQuantity((prev) => {
      const current = Number.parseInt(prev, 10) || 1;
      const next = Math.max(current - 1, 1);
      return String(next);
    });
  };

  const handleSubmit = async () => {
    if (!selectedLocationId) {
      toast.error("No location selected");
      return;
    }

    if (!isValid) {
      toast.error("Please fill in all required fields");
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch("/api/inventory/adjust", {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({
          productId: product.id,
          locationId: selectedLocationId,
          delta: adjustmentType === "add" ? quantityNum : -quantityNum,
          reason,
          notes: notes || undefined,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to adjust inventory");
      }

      toast.success(
        adjustmentType === "add"
          ? `Added ${quantityNum} units to ${product.name}`
          : `Removed ${quantityNum} units from ${product.name}`
      );

      onOpenChange(false);
      onSuccess?.();
      
      // Reset form
      setQuantity("");
      setReason("");
      setNotes("");
      setLocationQuantity(null);
      setAdjustmentType("add");
    } catch (error) {
      console.error("Error adjusting inventory:", error);
      toast.error(error instanceof Error ? error.message : "Failed to adjust inventory");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Quick Inventory Adjustment</DialogTitle>
          <DialogDescription>
            Adjust the inventory level for this product.
          </DialogDescription>
        </DialogHeader>

        {/* Product Info */}
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Package className="h-4 w-4" />
            <span>Product</span>
          </div>
          <h4 className="mt-1 text-base font-semibold">{product.name}</h4>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <ContextTag icon={<MapPin className="h-3 w-3 text-muted-foreground" />}>
              {selectedLocationName}
            </ContextTag>
            <ValueChip
              tone={currentQuantity > 0 ? "positive" : currentQuantity < 0 ? "negative" : "neutral"}
            >
              {loadingQuantity ? "Loading..." : `${currentQuantity} units`}
            </ValueChip>
          </div>
        </div>

        <div className="space-y-4">
          {/* Adjustment Type */}
          <div className="space-y-2">
            <Label>Adjustment Type</Label>
            <RadioGroup
              value={adjustmentType}
              onValueChange={(value: "add" | "remove") => setAdjustmentType(value)}
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="add" id="add" />
                <label
                  htmlFor="add"
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <Plus className="h-4 w-4 text-green-600" />
                  Add Stock
                </label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="remove" id="remove" />
                <label
                  htmlFor="remove"
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <Minus className="h-4 w-4 text-red-600" />
                  Remove Stock
                </label>
              </div>
            </RadioGroup>
          </div>

          {/* Quantity */}
          <div className="space-y-2">
            <Label htmlFor="quantity" className="text-xs font-medium text-muted-foreground">
              Quantity
            </Label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-10 w-10 rounded-md border-border"
                onClick={handleDecrement}
                disabled={quantityNum <= 1}
              >
                <Minus className="h-4 w-4" />
              </Button>
              <Input
                id="quantity"
                type="number"
                min="1"
                inputMode="numeric"
                pattern="[0-9]*"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="Enter quantity"
                className="h-10 flex-1 text-center text-lg font-semibold tabular-nums"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-10 w-10 rounded-md border-border"
                onClick={handleIncrement}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            {quantityNum > 0 && (
              <p className="text-[11px] text-muted-foreground">
                After adjustment,{" "}
                <InlineHighlight>{selectedLocationName}</InlineHighlight>{" "}
                would have{" "}
                <span
                  className={
                    adjustedQuantity < 0
                      ? "text-destructive font-semibold"
                      : "text-emerald-500 font-semibold"
                  }
                >
                  {adjustedQuantity} units
                </span>
                .
              </p>
            )}
          </div>

          {/* Reason */}
          <div className="space-y-2">
            <Label htmlFor="reason">Reason (required)</Label>
            <Input
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g., Damaged goods, Inventory count, Customer return"
            />
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">Additional Notes (optional)</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any additional details..."
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!isValid || isSubmitting}
            className="bg-sky-600 text-slate-50 hover:bg-sky-500"
          >
            {isSubmitting ? "Adjusting..." : "Confirm Adjustment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
