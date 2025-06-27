"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { Package, Calendar, FileText } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import type { ProductWithQuantity } from "@/types/product";

interface StockInDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: ProductWithQuantity;
  onSuccess?: () => void;
}

export function StockInDialog({
  open,
  onOpenChange,
  product,
  onSuccess,
}: StockInDialogProps) {
  const { data: session } = useSession();
  const { selectedLocationId } = useLocation();
  const [quantity, setQuantity] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
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
  const newQuantity = currentQuantity + quantityNum;
  
  const isValid = quantityNum > 0;

  const handleSubmit = async () => {
    if (!selectedLocationId) {
      toast.error("No location selected");
      return;
    }

    if (!isValid) {
      toast.error("Please enter a valid quantity");
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch("/api/inventory/stock-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: product.id,
          locationId: selectedLocationId,
          quantity: quantityNum,
          orderNumber: orderNumber || undefined,
          notes: notes || undefined,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to add stock");
      }

      toast.success(`Added ${quantityNum} units to ${product.name}`);
      onOpenChange(false);
      onSuccess?.();
      
      // Reset form
      setQuantity("");
      setOrderNumber("");
      setNotes("");
      setLocationQuantity(null);
    } catch (error) {
      console.error("Error adding stock:", error);
      toast.error(error instanceof Error ? error.message : "Failed to add stock");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Stock In - Add Inventory</DialogTitle>
          <DialogDescription>
            Add new stock for this product from a purchase order or delivery.
          </DialogDescription>
        </DialogHeader>

        {/* Product Info */}
        <div className="p-4 rounded-lg bg-muted/50">
          <div>
            <h4 className="font-medium">{product.name}</h4>
            <div className="flex items-center gap-4 mt-1">
              <div className="flex items-center gap-1">
                <Package className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  Current: {loadingQuantity ? "Loading..." : currentQuantity}
                </span>
              </div>
              {quantityNum > 0 && (
                <>
                  <span className="text-muted-foreground">→</span>
                  <Badge variant="default" className="text-xs">
                    New: {newQuantity}
                  </Badge>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          {/* Quantity */}
          <div className="space-y-2">
            <Label htmlFor="quantity">
              Quantity to Add <span className="text-destructive">*</span>
            </Label>
            <Input
              id="quantity"
              type="number"
              min="1"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="Enter quantity"
              className="text-lg"
              autoFocus
            />
          </div>

          {/* Order Number */}
          <div className="space-y-2">
            <Label htmlFor="order-number">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Order/Reference Number
              </div>
            </Label>
            <Input
              id="order-number"
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value)}
              placeholder="e.g., PO-2024-001"
            />
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">Additional Notes</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g., Supplier details, batch number, expiry date..."
              rows={3}
            />
          </div>

          {/* Info Box */}
          <div className="rounded-lg border bg-muted/50 p-3">
            <div className="flex items-start gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground mt-0.5" />
              <div className="text-sm text-muted-foreground">
                This stock-in will be recorded with today's date and time for tracking purposes.
              </div>
            </div>
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
            {isSubmitting ? "Adding Stock..." : `Add ${quantityNum || 0} Units`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}