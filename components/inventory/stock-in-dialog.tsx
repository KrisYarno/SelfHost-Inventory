"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Package, Calendar, FileText, AlertCircle } from "lucide-react";
import { useLocation } from "@/contexts/location-context";
import { getUserFriendlyMessage } from "@/lib/error-handling";
import { useProductLocationQuantity } from "@/hooks/use-product-location-quantity";
import { useStockIn } from "@/hooks/use-inventory-mutations";
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
import { ReceivingRedirectPrompt } from "@/components/inventory/receiving-redirect-prompt";
import type { DialogProduct } from "@/types/inventory";

interface StockInDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: DialogProduct;
  onSuccess?: () => void;
}

export function StockInDialog({
  open,
  onOpenChange,
  product,
  onSuccess,
}: StockInDialogProps) {
  const { selectedLocationId } = useLocation();
  const [quantity, setQuantity] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [notes, setNotes] = useState("");

  const quantityQuery = useProductLocationQuantity(product.id, selectedLocationId, {
    enabled: open,
  });
  const stockInMutation = useStockIn();
  const isSubmitting = stockInMutation.isPending;

  const currentQuantity = quantityQuery.data ?? 0;
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

    try {
      await stockInMutation.mutateAsync({
        productId: product.id,
        locationId: selectedLocationId,
        quantity: quantityNum,
        orderNumber: orderNumber || undefined,
        notes: notes || undefined,
      });

      toast.success(`Added ${quantityNum} units to ${product.name}`);
      onOpenChange(false);
      onSuccess?.();

      // Reset form
      setQuantity("");
      setOrderNumber("");
      setNotes("");
    } catch (error) {
      console.error("Error adding stock:", error);

      // Generate user-friendly error message
      const friendlyError = getUserFriendlyMessage(error as Error);

      toast.error(
        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">{friendlyError.title}</p>
              <p className="text-sm">{friendlyError.description}</p>
              {friendlyError.action && (
                <p className="text-sm text-muted-foreground">{friendlyError.action}</p>
              )}
            </div>
          </div>
        </div>,
        {
          duration: 5000,
        }
      );
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
            <div role="status" aria-live="polite" className="flex items-center gap-4 mt-1">
              <div className="flex items-center gap-1">
                <Package className="h-4 w-4 text-muted-foreground" />
                {quantityQuery.isError ? (
                  <span className="text-sm text-destructive">Could not load current stock</span>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    Current: {quantityQuery.isLoading ? "Loading..." : currentQuantity}
                  </span>
                )}
              </div>
              {quantityNum > 0 ? (
                <>
                  <span className="text-muted-foreground">→</span>
                  <Badge variant="default" className="text-xs">
                    New: {newQuantity}
                  </Badge>
                </>
              ) : null}
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
              inputMode="numeric"
              pattern="[0-9]*"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="Enter quantity"
              className="text-lg"
              autoFocus
            />
          </div>

          {/* T5 (pack REV-3): every stock-in is a positive delta, so the prompt
              turns on as soon as a quantity is entered. Once per session, and
              declining leaves this stock-in exactly as it was. */}
          <ReceivingRedirectPrompt active={quantityNum > 0} />

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
                This stock-in will be recorded with today&apos;s date and time for tracking purposes.
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
