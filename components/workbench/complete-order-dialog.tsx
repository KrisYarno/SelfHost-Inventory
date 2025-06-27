"use client";

import { useRouter } from "next/navigation";
import { useWorkbench } from "@/hooks/use-workbench";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { CheckCircle } from "lucide-react";
import { useLocation } from "@/contexts/location-context";

interface CompleteOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function CompleteOrderDialog({
  open,
  onOpenChange,
  onSuccess,
}: CompleteOrderDialogProps) {
  const router = useRouter();
  const { orderItems, orderReference, clearOrder, getTotalQuantity, isProcessing, setIsProcessing } = useWorkbench();
  const { selectedLocationId } = useLocation();

  const handleComplete = async () => {
    if (!orderReference.trim()) {
      toast.error("Order reference is required");
      return;
    }

    if (!selectedLocationId) {
      toast.error("Please select a location");
      return;
    }

    setIsProcessing(true);

    try {
      const request = {
        orderReference: orderReference.trim(),
        locationId: selectedLocationId,
        items: orderItems.map((item) => ({
          productId: item.product.id,
          quantity: item.quantity,
        })),
      };

      const response = await fetch("/api/inventory/deduct-simple", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to process order");
      }

      const result = await response.json();

      // Show success message
      toast.success(
        <div className="flex items-center gap-2">
          <CheckCircle className="h-4 w-4" />
          <span>Order {orderReference} processed successfully</span>
        </div>,
        {
          description: `${result.itemsProcessed} items deducted from inventory`,
        }
      );

      // Clear the order and close dialog
      clearOrder();
      onOpenChange(false);

      // Refresh the page to update product quantities
      router.refresh();
      
      // Call the onSuccess callback to refresh products
      if (onSuccess) {
        onSuccess();
      }
    } catch (error) {
      console.error("Error processing order:", error);
      toast.error(error instanceof Error ? error.message : "Failed to process order");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Complete Order</AlertDialogTitle>
          <AlertDialogDescription className="space-y-4">
            <div>
              Are you sure you want to complete this order and deduct the items
              from inventory?
            </div>

            {/* Order Summary */}
            <div className="rounded-lg border bg-muted/50 p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="font-medium">Order Reference:</span>
                <span className="font-mono">{orderReference}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="font-medium">Total Items:</span>
                <span>{orderItems.length}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="font-medium">Total Quantity:</span>
                <span>{getTotalQuantity()} units</span>
              </div>
            </div>

            {/* Item Details */}
            <div className="space-y-1">
              <p className="text-sm font-medium">Items to deduct:</p>
              <ul className="text-sm space-y-1 max-h-32 overflow-y-auto">
                {orderItems.map((item) => (
                  <li key={item.product.id} className="flex justify-between">
                    <span className="text-muted-foreground">
                      {item.product.name}
                    </span>
                    <span className="font-medium">{item.quantity}</span>
                  </li>
                ))}
              </ul>
            </div>

            <p className="text-sm text-destructive font-medium">
              This action cannot be undone.
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isProcessing}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleComplete}
            disabled={isProcessing}
          >
            {isProcessing ? "Processing..." : "Complete Order"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}