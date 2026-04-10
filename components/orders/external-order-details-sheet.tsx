"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useLocation } from "@/contexts/location-context";
import { Package, Check, AlertTriangle, ExternalLink, ShoppingCart, RefreshCw, Link2, ChevronDown, RotateCcw } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PlatformBadge } from "@/components/orders/platform-badge";
import { FulfillOrderDialog } from "@/components/orders/fulfill-order-dialog";
import { ProductMapDialog } from "@/components/products/product-map-dialog";
import { cn } from "@/lib/utils";
import type { ExternalOrder } from "@/types/external-orders";
import { STATUS_COLORS } from "@/types/external-orders";
import { formatDistanceToNow, format } from "date-fns";

interface ExternalOrderDetailsSheetProps {
  order: ExternalOrder | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRefresh?: () => void;
  csrfToken?: string;
}

export function ExternalOrderDetailsSheet({
  order,
  open,
  onOpenChange,
  onRefresh,
  csrfToken,
}: ExternalOrderDetailsSheetProps) {
  const [showFulfillDialog, setShowFulfillDialog] = useState(false);
  const [isRechecking, setIsRechecking] = useState(false);
  const { data: session } = useSession();
  const isAdmin = session?.user?.isAdmin ?? false;
  const [mapDialogOpen, setMapDialogOpen] = useState(false);
  const [mappingItem, setMappingItem] = useState<{
    externalId: string;
    externalVariantId?: string;
    title: string;
    sku?: string;
  } | null>(null);
  const { selectedLocationId } = useLocation();
  const [stockByProductId, setStockByProductId] = useState<Record<number, number>>({});

  // Fetch live stock for mapped items at the user's selected location
  useEffect(() => {
    if (!open || !order?.items || !selectedLocationId) {
      setStockByProductId({});
      return;
    }

    const mappedProductIds = order.items
      .filter((item) => item.isMapped && item.productLink?.internalProductId)
      .map((item) => item.productLink!.internalProductId);

    if (mappedProductIds.length === 0) {
      setStockByProductId({});
      return;
    }

    const uniqueIds = Array.from(new Set(mappedProductIds));
    // Fetch current stock via the inventory API
    fetch(`/api/inventory/current-fast?locationId=${selectedLocationId}`)
      .then((res) => (res.ok ? res.json() : { quantities: {} }))
      .then((data) => {
        const map: Record<number, number> = {};
        const quantities = data.quantities || {};
        for (const id of uniqueIds) {
          map[id] = quantities[String(id)] ?? 0;
        }
        setStockByProductId(map);
      })
      .catch(() => setStockByProductId({}));
  }, [open, order?.items, selectedLocationId]);

  if (!order) return null;

  const timeElapsed = formatDistanceToNow(
    new Date(order.externalCreatedAt || order.createdAt),
    { addSuffix: true }
  );

  // Calculate fulfillment status
  const totalItems = order.items?.reduce((sum, item) => sum + item.quantity, 0) || 0;
  const fulfilledItems = order.items?.reduce((sum, item) => sum + item.fulfilledQty, 0) || 0;
  const remainingItems = totalItems - fulfilledItems;
  const fulfillmentPercent = totalItems > 0 ? Math.round((fulfilledItems / totalItems) * 100) : 0;

  // Check if order can be fulfilled
  const canFulfill = order.internalStatus !== "fulfilled" && order.internalStatus !== "cancelled";
  const hasUnmappedItems = order.items?.some((item) => !item.isMapped) || false;

  const statusColors = STATUS_COLORS;
  const statusColor = statusColors[order.internalStatus];

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="h-[85vh] flex flex-col">
          <SheetHeader className="pb-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <SheetTitle className="text-2xl font-bold flex items-center gap-2">
                  #{order.orderNumber}
                  {order.integration && (
                    <PlatformBadge platform={order.integration.platform} size="sm" />
                  )}
                </SheetTitle>
                <SheetDescription className="space-y-1 mt-2">
                  <div>Created {timeElapsed}</div>
                  {order.integration && (
                    <div className="text-xs text-muted-foreground">
                      from {order.integration.name}
                    </div>
                  )}
                </SheetDescription>
              </div>
              <Badge variant="outline" className={cn("text-sm border", statusColor)}>
                {order.internalStatus.charAt(0).toUpperCase() +
                  order.internalStatus.slice(1)}
              </Badge>
            </div>

            {/* Fulfillment Progress */}
            {totalItems > 0 && (
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">Fulfillment Progress</span>
                  <span className="text-muted-foreground">
                    {fulfilledItems} / {totalItems} items ({fulfillmentPercent}%)
                  </span>
                </div>
                <div className="w-full bg-muted rounded-full h-2">
                  <div
                    className={cn(
                      "h-2 rounded-full transition-all",
                      fulfillmentPercent === 100
                        ? "bg-green-500"
                        : fulfillmentPercent > 0
                        ? "bg-blue-500"
                        : "bg-muted"
                    )}
                    style={{ width: `${fulfillmentPercent}%` }}
                  />
                </div>
              </div>
            )}

            {/* Customer Info */}
            {(order.customerName || order.customerEmail) && (
              <>
                <Separator />
                <div className="space-y-1 pt-2">
                  <h4 className="text-sm font-medium">Customer</h4>
                  {order.customerName && (
                    <p className="text-sm text-muted-foreground">{order.customerName}</p>
                  )}
                  {order.customerEmail && (
                    <p className="text-xs text-muted-foreground">{order.customerEmail}</p>
                  )}
                </div>
              </>
            )}

            {/* Warnings */}
            {hasUnmappedItems && canFulfill && (
              <div className="rounded-lg border border-warning bg-warning/10 p-3 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-warning flex-shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <p className="text-sm font-medium text-warning-foreground">
                    Unmapped Items
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Some items are not mapped to internal products. They will be skipped
                    during fulfillment.
                  </p>
                </div>
              </div>
            )}
          </SheetHeader>

          <Separator />

          <ScrollArea className="flex-1 py-4">
            <div className="space-y-4">
              {/* Order Items */}
              <div>
                <h3 className="font-semibold mb-3 text-lg flex items-center gap-2">
                  <ShoppingCart className="h-5 w-5" />
                  Order Items
                </h3>
                <div className="space-y-3">
                  {order.items?.map((item) => {
                    const remainingQty = item.quantity - item.fulfilledQty;
                    const isFullyFulfilled = remainingQty <= 0;

                    return (
                      <div
                        key={item.id}
                        className={cn(
                          "flex items-start gap-3 p-3 rounded-lg border",
                          isFullyFulfilled
                            ? "bg-green-50/50 border-green-200"
                            : !item.isMapped
                            ? "bg-orange-50/50 border-orange-200"
                            : "bg-muted/50"
                        )}
                      >
                        <div className="w-10 h-10 bg-muted rounded-md flex items-center justify-center flex-shrink-0">
                          <Package className="w-5 h-5 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0 space-y-1">
                          <div className="flex items-start justify-between gap-2">
                            <p className="font-medium text-sm">
                              {item.name}
                              {item.variantName && (
                                <span className="text-muted-foreground font-normal"> — {item.variantName}</span>
                              )}
                            </p>
                            {isFullyFulfilled && (
                              <Check className="h-4 w-4 text-green-600 flex-shrink-0" />
                            )}
                          </div>
                          {item.sku && (
                            <p className="text-xs text-muted-foreground">SKU: {item.sku}</p>
                          )}

                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge variant="secondary" className="text-xs">
                              Qty: {item.quantity}
                            </Badge>
                            {item.fulfilledQty > 0 && (
                              <Badge variant="default" className="text-xs bg-green-600">
                                Fulfilled: {item.fulfilledQty}
                              </Badge>
                            )}
                            {remainingQty > 0 && !isFullyFulfilled && (
                              <Badge variant="outline" className="text-xs">
                                To Fill: {remainingQty}
                              </Badge>
                            )}
                            {/* Show live stock at user's location for mapped items */}
                            {item.isMapped && item.productLink?.internalProductId && selectedLocationId && (
                              <Badge
                                variant="outline"
                                className={cn(
                                  "text-xs",
                                  (stockByProductId[item.productLink.internalProductId] ?? 0) <= 0
                                    ? "border-red-300 text-red-700 dark:text-red-400"
                                    : (stockByProductId[item.productLink.internalProductId] ?? 0) < remainingQty
                                    ? "border-amber-300 text-amber-700 dark:text-amber-400"
                                    : "border-green-300 text-green-700 dark:text-green-400"
                                )}
                              >
                                In Stock: {stockByProductId[item.productLink.internalProductId] ?? 0}
                              </Badge>
                            )}
                          </div>

                          {item.isMapped && item.productLink?.internalProduct ? (
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <ExternalLink className="h-3 w-3" />
                              <span>
                                Mapped to: {item.productLink.internalProduct.name}
                              </span>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <div className="flex items-center gap-1.5 text-xs text-orange-700">
                                <AlertTriangle className="h-3 w-3" />
                                <span>Not mapped to internal product</span>
                              </div>
                              {isAdmin && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 px-2 text-xs"
                                  onClick={(e) => {
                                    e.stopPropagation();
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
                                  Map
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="font-semibold text-sm">
                            ${item.price.toFixed(2)}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <Separator />

              {/* Order Summary */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="font-medium">
                    ${order.total.toFixed(2)} {order.currency}
                  </span>
                </div>
                <Separator />
                <div className="flex items-center justify-between py-2">
                  <span className="font-semibold text-lg">Total</span>
                  <span className="font-bold text-2xl">
                    ${order.total.toFixed(2)} {order.currency}
                  </span>
                </div>
              </div>

              {/* Order Metadata */}
              <Separator />
              <div className="space-y-2">
                <h4 className="font-semibold text-sm">Order Information</h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">External ID:</span>
                    <p className="font-mono text-xs">{order.externalId}</p>
                  </div>
                  {order.integration?.platform !== "SHOPIFY" && (
                    <div>
                      <span className="text-muted-foreground">Platform Status:</span>
                      <p className="break-words">{order.nativeStatus}</p>
                    </div>
                  )}
                  {order.integration?.platform === "SHOPIFY" && order.financialStatus && (
                    <div>
                      <span className="text-muted-foreground">Payment:</span>
                      <p className="break-words">{order.financialStatus}</p>
                    </div>
                  )}
                  {order.integration?.platform === "SHOPIFY" && order.fulfillmentStatus && (
                    <div>
                      <span className="text-muted-foreground">Fulfillment:</span>
                      <p className="break-words">{order.fulfillmentStatus}</p>
                    </div>
                  )}
                  {order.externalCreatedAt && (
                    <div>
                      <span className="text-muted-foreground">Order Date:</span>
                      <p>{format(new Date(order.externalCreatedAt), "MMM d, yyyy")}</p>
                    </div>
                  )}
                  {order.externalUpdatedAt && (
                    <div>
                      <span className="text-muted-foreground">Source Updated:</span>
                      <p>{format(new Date(order.externalUpdatedAt), "MMM d, yyyy h:mm a")}</p>
                    </div>
                  )}
                  {order.lastSeenAt && (
                    <div>
                      <span className="text-muted-foreground">Last Checked:</span>
                      <p>{format(new Date(order.lastSeenAt), "MMM d, yyyy h:mm a")}</p>
                    </div>
                  )}
                  {/* P2: externalOrderUrl comes from the raw WC/Shopify payload,
                      which could inject a javascript: URL or internal-network
                      address. Only render as a clickable link when the URL
                      starts with https://. */}
                  {order.externalOrderUrl && order.externalOrderUrl.startsWith('https://') && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">Source Link:</span>
                      <a
                        href={order.externalOrderUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline break-all block"
                      >
                        {order.externalOrderUrl}
                      </a>
                    </div>
                  )}
                </div>
              </div>

              {/* Fulfillment Info */}
              {order.fulfilledAt && order.fulfilledByUser && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <h4 className="font-semibold text-sm">Fulfillment Details</h4>
                    <div className="text-sm space-y-1">
                      <p className="text-muted-foreground">
                        Fulfilled by {order.fulfilledByUser.username}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(order.fulfilledAt), "MMM d, yyyy 'at' h:mm a")}
                      </p>
                    </div>

                    {/* Fulfillment push status indicator */}
                    {order.integration?.fulfillmentPushEnabled && (
                      <div className="mt-2">
                        {order.internalStatus === "fulfilled" ? (
                          <div className="flex items-center gap-1.5 text-xs text-green-700">
                            <Check className="h-3 w-3" />
                            <span>
                              Status synced to{" "}
                              {order.integration.platform === "SHOPIFY"
                                ? "Shopify"
                                : "WooCommerce"}
                            </span>
                          </div>
                        ) : order.internalStatus === "processing" ? (
                          <div className="flex items-center gap-1.5 text-xs text-blue-700">
                            <Check className="h-3 w-3" />
                            <span>
                              Partial status synced to{" "}
                              {order.integration.platform === "SHOPIFY"
                                ? "Shopify"
                                : "WooCommerce"}
                            </span>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </ScrollArea>

          {/* Footer Actions */}
          {(canFulfill && remainingItems > 0) || csrfToken ? (
            <>
              <Separator />
              <SheetFooter className="gap-2 sm:gap-2">
                {canFulfill && remainingItems > 0 && (
                  <Button
                    size="lg"
                    onClick={() => setShowFulfillDialog(true)}
                    className="flex-1 h-12"
                  >
                    <Check className="w-4 h-4 mr-2" />
                    Fulfill Order
                  </Button>
                )}
                {/* Split button: Recheck Status (safe reconcile) + Force Resync dropdown */}
                <div className="flex-1 flex">
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    disabled={!csrfToken || isRechecking}
                    onClick={async () => {
                      if (!order || !csrfToken) return;
                      setIsRechecking(true);
                      try {
                        const response = await fetch(
                          `/api/orders/external/${order.id}/recheck`,
                          {
                            method: "POST",
                            headers: {
                              "Content-Type": "application/json",
                              "X-CSRF-Token": csrfToken,
                            },
                            body: JSON.stringify({ mode: "reconcile" }),
                          }
                        );
                        if (!response.ok) {
                          const data = await response.json().catch(() => ({}));
                          throw new Error(data.error || "Recheck failed");
                        }
                        if (onRefresh) onRefresh();
                      } finally {
                        setIsRechecking(false);
                      }
                    }}
                    className="flex-1 h-12 rounded-r-none border-r-0"
                  >
                    <RefreshCw className={cn("w-4 h-4 mr-2", isRechecking && "animate-spin")} />
                    Recheck Status
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="lg"
                        disabled={!csrfToken || isRechecking}
                        className="h-12 px-2 rounded-l-none"
                        aria-label="More recheck options"
                      >
                        <ChevronDown className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-72">
                      <DropdownMenuLabel>Sync options</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={async () => {
                          if (!order || !csrfToken) return;
                          const confirmed = window.confirm(
                            `Force Resync will OVERWRITE local status with whatever WooCommerce currently shows.\n\nThis bypasses the protection that keeps locally-fulfilled orders fulfilled. Use this when local state is stuck and you want to reset from WC truth.\n\nOrder: #${order.orderNumber}\nCurrent local status: ${order.internalStatus}\nCurrent WC status: ${order.nativeStatus}\n\nProceed?`
                          );
                          if (!confirmed) return;
                          setIsRechecking(true);
                          try {
                            const response = await fetch(
                              `/api/orders/external/${order.id}/recheck`,
                              {
                                method: "POST",
                                headers: {
                                  "Content-Type": "application/json",
                                  "X-CSRF-Token": csrfToken,
                                },
                                body: JSON.stringify({ mode: "compute" }),
                              }
                            );
                            if (!response.ok) {
                              const data = await response.json().catch(() => ({}));
                              throw new Error(data.error || "Force resync failed");
                            }
                            if (onRefresh) onRefresh();
                          } finally {
                            setIsRechecking(false);
                          }
                        }}
                        className="cursor-pointer"
                      >
                        <RotateCcw className="w-4 h-4 mr-2" />
                        <div className="flex flex-col">
                          <span className="font-medium">Force Resync</span>
                          <span className="text-xs text-muted-foreground">
                            Overwrite local status from WC
                          </span>
                        </div>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </SheetFooter>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      {/* Fulfillment Dialog */}
      <FulfillOrderDialog
        order={order}
        open={showFulfillDialog}
        onOpenChange={setShowFulfillDialog}
        onSuccess={() => {
          if (onRefresh) {
            onRefresh();
          }
          onOpenChange(false);
        }}
        csrfToken={csrfToken}
      />

      {/* Product Mapping Dialog */}
      {mappingItem && order.integration && (
        <ProductMapDialog
          open={mapDialogOpen}
          onOpenChange={setMapDialogOpen}
          integrationId={order.integration.id}
          externalProduct={mappingItem}
          onMapped={() => {
            // Refresh order data to show updated mapping status
            if (onRefresh) {
              onRefresh();
            }
          }}
        />
      )}
    </>
  );
}
