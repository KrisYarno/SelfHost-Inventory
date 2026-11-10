"use client";

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { CheckCircle, AlertCircle, AlertTriangle, Package, MapPin, Loader2, Link2 } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { ProductMapDialog } from "@/components/products/product-map-dialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useFulfillmentValidation, useFulfillOrder } from "@/hooks/use-orders";
import { CAP_COUNTER_FROM, MAX_FULFILLMENT_ITEMS } from "@/lib/inventory/request-limits";
import { primaryRefusal } from "@/lib/orders/refusal";
import { isCatalogProductId, NO_STORE_PRODUCT_LINE_HINT } from "@/lib/orders/catalog-product-id";
import type { ExternalOrder } from "@/types/external-orders";

type OrderLine = NonNullable<ExternalOrder["items"]>[number];

/**
 * The lines this dialog would SEND — reconciliation Part 2, pack CB1.5c.
 *
 * One spelling, module-level, because two different readers of "how many lines
 * is this" is how a cap counter ends up disagreeing with the request it counts:
 * `handleFulfill` builds its items from this, and the cap guard measures this.
 * A line is open when part of it is still unfulfilled — a fully fulfilled line
 * is never sent, so it never counts against the request cap either.
 */
export function openLines(items: OrderLine[]): OrderLine[] {
  return items.filter((item) => item.quantity - item.fulfilledQty > 0);
}

/** A count the envelope may simply not carry (FD1-9) — absent reads as 0. */
const asCount = (v: unknown) => (typeof v === "number" ? v : 0);

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
  const { data: session } = useSession();
  const isAdmin = session?.user?.isAdmin ?? false;
  const [mapDialogOpen, setMapDialogOpen] = useState(false);
  const [mappingItem, setMappingItem] = useState<{
    externalId: string;
    externalVariantId?: string;
    title: string;
    sku?: string;
  } | null>(null);

  // Locations for the fulfillment picker (read).
  const locationsQuery = useQuery<Location[]>({
    queryKey: ["locations"],
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/locations", { signal });
      if (!res.ok) throw new Error("Failed to load locations");
      return res.json();
    },
    enabled: open,
  });
  const locations = locationsQuery.data ?? [];
  const isLoadingLocations = locationsQuery.isLoading;

  // Auto-select first location once loaded (preserves prior behavior).
  useEffect(() => {
    const locs = locationsQuery.data;
    if (locs && locs.length > 0 && selectedLocationId === null) {
      setSelectedLocationId(locs[0].id);
    }
  }, [locationsQuery.data, selectedLocationId]);

  useEffect(() => {
    if (locationsQuery.isError) {
      toast.error("Failed to load locations");
    }
  }, [locationsQuery.isError]);

  // Pre-fulfillment validation for the chosen location (read).
  const validationQuery = useFulfillmentValidation(order?.id ?? null, selectedLocationId, {
    enabled: open && !!order && selectedLocationId !== null,
  });
  const validation = validationQuery.data ?? null;
  const isLoadingValidation = validationQuery.isFetching;

  // Preserve the prior toast-on-validation-failure surface.
  useEffect(() => {
    if (validationQuery.isError) {
      toast.error(
        validationQuery.error instanceof Error
          ? validationQuery.error.message
          : "Failed to validate order",
      );
    }
  }, [validationQuery.isError, validationQuery.error]);

  // Fulfill mutation — invalidates orders + inventory caches on success.
  const fulfillMutation = useFulfillOrder();
  const isProcessing = fulfillMutation.isPending;

  const handleFulfill = async () => {
    if (!order || !selectedLocationId || !csrfToken) {
      toast.error("Missing required information");
      return;
    }

    if (!validation) {
      toast.error("Please wait for validation to complete");
      return;
    }

    // Build items array for fulfillment — the SAME predicate the cap counter
    // renders from (pack CB1.5c), so the two can never drift apart.
    const items = openLines(order.items || []).map((item) => {
      const remainingQty = item.quantity - item.fulfilledQty;
      return {
        itemId: item.id,
        quantity: remainingQty,
        skipUnmapped: !item.isMapped, // Skip unmapped items by default
      };
    });

    if (items.length === 0) {
      toast.error("No items to fulfill");
      return;
    }

    try {
      const result = await fulfillMutation.mutateAsync({
        orderId: order.id,
        locationId: selectedLocationId,
        items,
      });

      // ---------------------------------------------------------------------
      // THE ENVELOPE, READ (reconciliation Part 2, pack CB1.5c / seam S-B15).
      //
      // A 200 is not a success — it is an ANSWER. Until B1.5 this dialog
      // toasted "processed" and called onSuccess for every 200 without ever
      // reading `summary.failed`, which is the surface that hid DR-1 for two
      // weeks. From B1.5 a partial 200 (a short line lands in `skipped`) is
      // reachable in production, so the toast tiers by what actually happened.
      // ---------------------------------------------------------------------
      const summary = result?.summary;
      const refusal = primaryRefusal(result?.results);

      // THE GUARDED READ (OC-2 / G2s-1). `use-orders.ts` resolves a 200 whose
      // body fails to parse as `{}`, and a `summary` without a numeric
      // `fulfilled` used to fall through BOTH comparisons below into the success
      // branch as "undefined fulfilled" — the exact false success this block
      // exists to delete. A body this dialog cannot read is not a refusal
      // either: the fulfil is COMMITTED by the time it answers, and reporting it
      // as a failure sends the operator back to retry a done fulfilment. So an
      // unreadable envelope is assumed to have worked, and says nothing it
      // cannot stand behind — no counts.
      const fulfilled = typeof summary?.fulfilled === "number" ? summary.fulfilled : null;

      /** The success title — ONE spelling, for both success tiers below. */
      const processedTitle = (
        <div className="flex items-center gap-2">
          <CheckCircle className="h-4 w-4" />
          <span>Order {order.orderNumber} processed</span>
        </div>
      );

      if (fulfilled === 0) {
        // Nothing moved. The dialog STAYS OPEN and onSuccess is NOT called:
        // there is no new state to refresh into, and closing would tell the
        // operator the order was dealt with.
        toast.error(
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            <span>Nothing was fulfilled</span>
          </div>,
          {
            description: refusal ?? undefined,
            duration: 5000,
          }
        );
        // QA-1: and the strip BEHIND the toast is re-read. It was rendered from
        // the pre-fulfil validation, so on the one tier that keeps the dialog
        // open it still says the line is ready with the confirm enabled —
        // contradicting the refusal the operator was just handed, and inviting
        // the same tap again. Same idiom the mapping dialog uses on its return.
        await validationQuery.refetch();
        return;
      }

      if (fulfilled === null) {
        // The unreadable envelope: today's success toast, with no counts.
        toast.success(processedTitle);
      } else if (fulfilled < items.length) {
        // Legitimate state: part of the order IS fulfilled, and the validation
        // step already showed which lines had issues. Close and refresh — but
        // never call it "processed". The counts are spelled only here, where
        // there is a readable summary to spell them from.
        // FD1-9: the other two counts are guarded the way `fulfilled` already
        // is. A body carrying a numeric `fulfilled` and nothing else reaches
        // here, and reading the pair raw spelled "undefined skipped, undefined
        // failed" at the one tier that quotes counts at all.
        const counts = `${fulfilled} fulfilled, ${asCount(summary.skipped)} skipped, ${asCount(summary.failed)} failed`;
        toast.warning(
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            <span>Order {order.orderNumber} partially processed</span>
          </div>,
          {
            description: refusal ? `${counts} — ${refusal}` : counts,
            duration: 5000,
          }
        );
      } else {
        toast.success(processedTitle, {
          description:
            `${fulfilled} fulfilled` +
            (summary.skipped > 0 ? `, ${summary.skipped} skipped` : "") +
            (summary.failed > 0 ? `, ${summary.failed} failed` : ""),
        });
      }

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

  // The request cap, client-side (pack CB1.5c / seam S-B10, the journal's
  // threshold-gated idiom): the counter appears while the order is still under
  // the cap — a bound an operator meets for the first time as a 400 is a bound
  // they were never told about. The numbers come from the ONE owner.
  const openCount = openLines(order.items ?? []).length;
  const showCounter = openCount > CAP_COUNTER_FROM;
  const overCap = openCount > MAX_FULFILLMENT_ITEMS;

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
                  {/* "Map them …" only when at least one unmapped line CAN be
                      mapped: a line with no store product ("" / "0", e.g. typed
                      by hand in the store) says so itself, and the advice would
                      contradict it (HTL-QA-4). */}
                  <p className="text-sm text-muted-foreground">
                    These items will be skipped during fulfillment.
                    {order.items?.some(
                      (item) => !item.isMapped && isCatalogProductId(item.externalProductId),
                    ) && " Map them to internal products to include them."}
                  </p>
                  <div className="mt-2 space-y-1">
                    {order.items
                      ?.filter((item) => !item.isMapped)
                      .map((item) => (
                        <div key={item.id} className="flex flex-wrap items-center gap-x-2">
                          <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                            {item.name}{item.variantName ? ` — ${item.variantName}` : ''}
                          </span>
                          {/* A line with no store product ("" / "0", e.g. typed by
                              hand in the store) has nothing to map: the hint, for
                              everyone, in place of the admin's Map button. It takes
                              its own line (basis-full in a wrapping row) so it never
                              squeezes the name on a narrow screen (HTL-FD1-1). */}
                          {!isCatalogProductId(item.externalProductId) && (
                            <span
                              className="basis-full text-xs text-muted-foreground"
                              data-testid="no-store-product-hint"
                            >
                              {NO_STORE_PRODUCT_LINE_HINT}
                            </span>
                          )}
                          {isAdmin && isCatalogProductId(item.externalProductId) && (
                            <Button
                              size="sm"
                              variant="link"
                              className="h-auto p-0 text-xs"
                              onClick={() => {
                                setMappingItem({
                                  externalId: item.externalProductId,
                                  externalVariantId: item.externalVariantId || undefined,
                                  title: item.productLink?.externalTitle || item.name,
                                  sku: item.productLink?.externalSku || item.sku || undefined,
                                });
                                setMapDialogOpen(true);
                              }}
                            >
                              <Link2 className="h-3 w-3 mr-1" />
                              Map now
                            </Button>
                          )}
                        </div>
                      ))}
                  </div>
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

                {showCounter && (
                  <p
                    className={cn(
                      "text-xs",
                      overCap
                        ? "text-destructive font-semibold"
                        : "font-mono tabular-nums text-muted-foreground"
                    )}
                  >
                    {overCap
                      ? `This order has ${openCount} open lines; fulfilment handles at most ${MAX_FULFILLMENT_ITEMS} per request.`
                      : `${openCount} of ${MAX_FULFILLMENT_ITEMS} lines`}
                  </p>
                )}

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
              itemsWithStock === 0 ||
              overCap
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

      {/* Product Mapping Dialog */}
      {mappingItem && order?.integration && (
        <ProductMapDialog
          open={mapDialogOpen}
          onOpenChange={setMapDialogOpen}
          integrationId={order.integration.id}
          externalProduct={mappingItem}
          onMapped={() => {
            // Re-validate to see updated mapping status
            validationQuery.refetch();
          }}
        />
      )}
    </AlertDialog>
  );
}
