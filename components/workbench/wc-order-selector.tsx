"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useExternalOrders } from "@/hooks/use-external-orders";
import { useDebounce } from "@/hooks/use-debounce";
import {
  Search,
  X,
  ShoppingCart,
  Package,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ExternalOrder } from "@/types/external-orders";
import type { SelectedExternalOrder } from "@/types/workbench";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WCOrderSelectorProps {
  onOrderSelected: (order: ExternalOrder) => void;
  selectedOrder: SelectedExternalOrder | null;
  onClear: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function getPlatformBadge(platform?: string) {
  if (!platform) return null;
  const label = platform === "WOOCOMMERCE" ? "WOO" : platform === "SHOPIFY" ? "SHO" : platform;
  const bgClass =
    platform === "WOOCOMMERCE"
      ? "bg-purple-600 text-white"
      : platform === "SHOPIFY"
        ? "bg-green-600 text-white"
        : "bg-muted text-muted-foreground";
  return (
    <Badge variant="secondary" className={cn("text-[10px] px-1.5 py-0", bgClass)}>
      {label}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WCOrderSelector({
  onOrderSelected,
  selectedOrder,
  onClear,
}: WCOrderSelectorProps) {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);

  const { data, isFetching, error } = useExternalOrders({
    search: debouncedSearch,
    status: "pending",
    pageSize: 5,
  });

  const orders = data?.orders ?? [];

  // -- Selected order banner --
  if (selectedOrder) {
    return (
      <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2.5 min-w-0 flex-1">
            <ShoppingCart className="h-4 w-4 mt-0.5 text-primary shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-semibold">
                  #{selectedOrder.orderNumber}
                </span>
                {getPlatformBadge("WOOCOMMERCE")}
              </div>
              <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
                {selectedOrder.customerName && (
                  <span>{selectedOrder.customerName}</span>
                )}
                {selectedOrder.customerName && selectedOrder.total != null && (
                  <span aria-hidden="true">&middot;</span>
                )}
                {selectedOrder.total != null && (
                  <span>{formatCurrency(selectedOrder.total)}</span>
                )}
              </div>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onClear}
            aria-label="Clear selected order"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  // -- Search + results --
  return (
    <div className="space-y-2">
      {/* Search input */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by order #..."
          className="pl-9 pr-8"
        />
        {isFetching && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      {/* Results list */}
      <div className="space-y-1">
        {/* Loading skeleton */}
        {isFetching && orders.length === 0 && (
          <div className="space-y-1.5">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        )}

        {/* Error state */}
        {error && !isFetching && (
          <p className="py-3 text-center text-sm text-destructive">
            Failed to load orders. Try again.
          </p>
        )}

        {/* Empty state */}
        {!isFetching &&
          !error &&
          orders.length === 0 &&
          debouncedSearch.length > 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No pending orders found
            </p>
          )}

        {/* Default prompt */}
        {!isFetching &&
          !error &&
          orders.length === 0 &&
          debouncedSearch.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Search for a WooCommerce order to auto-fill the cart
            </p>
          )}

        {/* Order results */}
        {orders.map((order) => (
          <button
            key={order.id}
            onClick={() => onOrderSelected(order)}
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded-lg",
              "border border-border/60 bg-background px-3 py-2.5",
              "text-left text-sm transition-colors",
              "hover:bg-muted/50 hover:border-primary/30"
            )}
          >
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              <Package className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium">
                    #{order.orderNumber}
                  </span>
                  {order.integration && getPlatformBadge(order.integration.platform)}
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {order.customerName && (
                    <span className="truncate">{order.customerName}</span>
                  )}
                  {order.customerName && order.total != null && (
                    <span aria-hidden="true">&middot;</span>
                  )}
                  {order.total != null && (
                    <span className="shrink-0">{formatCurrency(order.total)}</span>
                  )}
                </div>
              </div>
            </div>
            <span className="text-xs text-muted-foreground shrink-0">Select</span>
          </button>
        ))}
      </div>
    </div>
  );
}
