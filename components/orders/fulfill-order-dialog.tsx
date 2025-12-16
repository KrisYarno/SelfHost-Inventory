"use client";

import { useState, useEffect } from "react";
import { CheckCircle, AlertCircle, AlertTriangle, Package, MapPin, Loader2 } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { ExternalOrder } from "@/types/external-orders";
import type { FulfillmentValidationResult } from "@/lib/fulfillment";

interface FulfillOrderDialogProps {
  order: ExternalOrder | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  csrfToken?: string;
}

interface Location {
  id: number;
  name: string;
}

export function FulfillOrderDialog({
  order,
  open,
  onOpenChange,
  onSuccess,
  csrfToken,
}: FulfillOrderDialogProps) {
  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [validation, setValidation] = useState<FulfillmentValidationResult | null>(null);
  const [isLoadingLocations, setIsLoadingLocations] = useState(false);
  const [isLoadingValidation, setIsLoadingValidation] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  // Load locations
  useEffect(() => {
    if (open) {
      loadLocations();
    }
  }, [open]);

  // Load validation when location changes
  useEffect(() => {
    if (order && selectedLocationId) {
      loadValidation();
    }
  }, [order, selectedLocationId]);

  const loadLocations = async () => {
    setIsLoadingLocations(true);
    try {
      const response = await fetch("/api/locations");
      if (response.ok) {
        const data = await response.json();
        setLocations(data);

        // Auto-select first location if available
        if (data.length > 0 && !selectedLocationId) {
          setSelectedLocationId(data[0].id);
        }
      }
    } catch (error) {
      console.error("Failed to load locations:", error);
      toast.error("Failed to load locations");
    } finally {
      setIsLoadingLocations(false);
    }
  };

  const loadValidation = async () => {
    if (!order) return;

    setIsLoadingValidation(true);
    try {
      const url = `/api/orders/${order.id}/fulfill/validate?locationId=${selectedLocationId}`;
      const response = await fetch(url);

      if (response.ok) {
        const data = await response.json();
        setValidation(data);
      } else {
        const errorData = await response.json();
        toast.error(errorData.error?.message || "Failed to validate order");
      }
    } catch (error) {
      console.error("Failed to validate order:", error);
      toast.error("Failed to validate order");
    } finally {
      setIsLoadingValidation(false);
    }
  };

  const handleFulfill = async () => {
    if (!order || !selectedLocationId || !csrfToken) {
      toast.error("Missing required information");
      return;
    }

    if (!validation) {
      toast.error("Please wait for validation to complete");
      return;
    }

    setIsProcessing(true);

    try {
      // Build items array for fulfillment
      const items = (order.items || [])
        .filter((item) => {
          const remainingQty = item.quantity - item.fulfilledQty;
          return remainingQty > 0;
        })
        .map((item) => {
          const remainingQty = item.quantity - item.fulfilledQty;
          return {
            itemId: item.id,
            quantity: remainingQty,
            skipUnmapped: !item.isMapped, // Skip unmapped items by default
          };
        });

      if (items.length === 0) {
        toast.error("No items to fulfill");
        setIsProcessing(false);
        return;
      }

      const response = await fetch(`/api/orders/${order.id}/fulfill`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          locationId: selectedLocationId,
          items,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || "Failed to fulfill order");
      }

      const result = await response.json();

      // Show success message
      toast.success(
        <div className="flex items-center gap-2">
          <CheckCircle className="h-4 w-4" />
          <span>Order {order.orderNumber} processed</span>
        </div>,
        {
          description: `${result.summary.fulfilled} items fulfilled, ${result.summary.skipped} skipped`,
        }
      );

      // Close dialog and refresh
      onOpenChange(false);
      if (onSuccess) {
        onSuccess();
      }
    } catch (error) {
      console.error("Error fulfilling order:", error);
      toast.error(
        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">Fulfillment Failed</p>
              <p className="text-sm">
                {error instanceof Error ? error.message : "An error occurred"}
              </p>
            </div>
          </div>
        </div>,
        {
          duration: 5000,
        }
      );
    } finally {
      setIsProcessing(false);
    }
  };

  if (!order) return null;

  const totalItems = order.items?.length || 0;
  const mappedItems = order.items?.filter((item) => item.isMapped).length || 0;
  const unmappedItems = totalItems - mappedItems;
  const hasUnmappedItems = unmappedItems > 0;

  // Calculate items ready to fulfill
  const itemsWithStock = validation?.items.filter(
    (item) => item.isMapped && item.issues.length === 0
  ).length || 0;
  const itemsWithIssues = validation?.items.filter(
    (item) => item.issues.length > 0
  ).length || 0;

  const canFulfill = validation?.canFulfill && selectedLocationId !== null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <AlertDialogHeader>
          <AlertDialogTitle>Fulfill Order #{order.orderNumber}</AlertDialogTitle>
          <AlertDialogDescription className="space-y-4">
            <div>
              Review the order details and select a location to fulfill from.
            </div>

            {/* Location Selector */}
            <div className="rounded-lg border bg-muted/50 p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <MapPin className="h-4 w-4" />
                <span>Fulfillment Location</span>
              </div>
              <Select
                value={selectedLocationId?.toString()}
                onValueChange={(value) => setSelectedLocationId(parseInt(value, 10))}
                disabled={isLoadingLocations}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a location" />
                </SelectTrigger>
                <SelectContent>
                  {locations.map((location) => (
                    <SelectItem key={location.id} value={location.id.toString()}>
                      {location.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Warnings */}
            {hasUnmappedItems && (
              <div className="rounded-lg border border-warning bg-warning/10 p-4 flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-warning flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-warning-foreground">
                    {unmappedItems} unmapped {unmappedItems === 1 ? "item" : "items"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    These items will be skipped during fulfillment. Map them to internal
                    products to include them.
                  </p>
                </div>
              </div>
            )}

            {/* Validation Loading */}
            {isLoadingValidation && (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            )}

            {/* Validation Summary */}
            {validation && !isLoadingValidation && (
              <div className="space-y-3">
                <div className="flex items-center gap-4 text-sm">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-green-600" />
                    <span className="font-medium">{itemsWithStock} ready</span>
                  </div>
                  {itemsWithIssues > 0 && (
                    <div className="flex items-center gap-2">
                      <AlertCircle className="h-4 w-4 text-orange-600" />
                      <span className="font-medium">{itemsWithIssues} with issues</span>
                    </div>
                  )}
                </div>

                <Separator />

                {/* Item Details */}
                <ScrollArea className="max-h-60">
                  <div className="space-y-2">
                    {validation.items.map((item) => {
                      const hasIssues = item.issues.length > 0;
                      const locationStock = item.mapping?.availableByLocation.find(
                        (loc) => loc.locationId === selectedLocationId
                      );
                      const available = locationStock?.available || 0;

                      return (
                        <div
                          key={item.itemId}
                          className={cn(
                            "flex items-start gap-3 p-3 rounded-lg border",
                            hasIssues
                              ? "border-orange-200 bg-orange-50/50"
                              : "border-green-200 bg-green-50/50"
                          )}
                        >
                          <Package className="h-4 w-4 mt-1 flex-shrink-0 text-muted-foreground" />
                          <div className="flex-1 min-w-0 space-y-1">
                            <div className="flex items-start justify-between gap-2">
                              <p className="font-medium text-sm truncate">{item.name}</p>
                              <Badge
                                variant={hasIssues ? "destructive" : "default"}
                                className="text-xs flex-shrink-0"
                              >
                                {item.remainingQty} needed
                              </Badge>
                            </div>
                            {item.sku && (
                              <p className="text-xs text-muted-foreground">SKU: {item.sku}</p>
                            )}
                            {item.mapping && (
                              <p className="text-xs text-muted-foreground">
                                Mapped to: {item.mapping.productName} ({available} available)
                              </p>
                            )}
                            {item.issues.length > 0 && (
                              <div className="space-y-0.5">
                                {item.issues.map((issue, idx) => (
                                  <p key={idx} className="text-xs text-orange-700">
                                    • {issue}
                                  </p>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              </div>
            )}

            {/* Warning about partial fulfillment */}
            {validation && !validation.canFulfill && itemsWithStock > 0 && (
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-blue-900">Partial Fulfillment</p>
                  <p className="text-sm text-blue-700">
                    Only {itemsWithStock} of {totalItems} items can be fulfilled. Items with
                    issues will be skipped.
                  </p>
                </div>
              </div>
            )}

            <p className="text-sm text-destructive font-medium">
              This action will deduct inventory and cannot be undone.
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isProcessing}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleFulfill();
            }}
            disabled={
              isProcessing ||
              isLoadingValidation ||
              !validation ||
              !selectedLocationId ||
              itemsWithStock === 0
            }
            className={cn(
              !canFulfill && itemsWithStock > 0 && "bg-orange-600 hover:bg-orange-700"
            )}
          >
            {isProcessing ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Processing...
              </>
            ) : (
              <>
                {canFulfill
                  ? "Fulfill Order"
                  : itemsWithStock > 0
                  ? `Fulfill ${itemsWithStock} Items`
                  : "No Items to Fulfill"}
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
