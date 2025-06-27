"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { Plus, Minus, Package } from "lucide-react";
import { useLocation } from "@/contexts/location-context";
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
import { Badge } from "@/components/ui/badge";
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
  const { data: session } = useSession();
  const { selectedLocationId } = useLocation();
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
  
  const isValid = quantityNum > 0 && reason.trim() && adjustedQuantity >= 0;

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
        headers: { "Content-Type": "application/json" },
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
        <div className="p-4 rounded-lg bg-muted/50">
          <div>
            <h4 className="font-medium">{product.name}</h4>
            <div className="flex items-center gap-2 mt-1">
              <Package className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Current Stock: {loadingQuantity ? "Loading..." : currentQuantity}
              </span>
            </div>
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
            <Label htmlFor="quantity">Quantity</Label>
            <Input
              id="quantity"
              type="number"
              min="1"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="Enter quantity"
            />
            {quantityNum > 0 && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">New quantity:</span>
                <Badge
                  variant={adjustedQuantity < 0 ? "destructive" : "outline"}
                >
                  {adjustedQuantity}
                </Badge>
              </div>
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
          >
            {isSubmitting ? "Adjusting..." : "Confirm Adjustment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}