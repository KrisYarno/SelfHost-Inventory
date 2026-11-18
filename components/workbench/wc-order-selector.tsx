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
  /**
   * Facelift F0-1 (OC1-1): the page's products query is loading, or is still
   * showing the PREVIOUS location's rows as placeholder data. A selection now
   * would build "in stock here" from somewhere else, so the rows wait.
   */
  stockLoading?: boolean;
  /**
   * Facelift F0 FR1-1 (e): the page's products read failed, so there is no
   * stock to build "in stock here" from. The rows wait, and say why.
   */
  stockFailed?: boolean;
  /**
   * Facelift F0 FR2-6: no location is selected, so there is no "here" and no
   * stock read in flight — "Loading stock…" would be untrue. The rows wait and
   * say why (F1-9: `noLocationSentence`).
   */
  noLocation?: boolean;
  /**
   * Facelift F1-9 (F0 FD2-3): the location list's state, which says WHY there
   * is no location — still loading, failed, none configured, or none chosen.
   * Read only with `noLocation`. Absent, the rows read the "none chosen"
   * sentence.
   */
  locationList?: LocationListState;
  /**
   * Facelift F0 FR2-5 (orchestrator ruling (a)): reads the page's stock again.
   * The failure sentence sits inside each (disabled) row, where no button can
   * go, so the stock-failed state gets ONE line above the rows: the sentence,
   * then a Retry that calls this.
   */
  onRetryStock?: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The location list as the location chip reads it (`useLocation`). */
interface LocationListState {
  isLoading: boolean;
  loadFailed: boolean;
  count: number;
}

/** F1-9: the order rows' sentence for a loaded list with nothing chosen. */
const NO_LOCATION_CHOSEN = "Choose a location first.";

/**
 * Facelift F1-9 (F0 FD2-3): why there is no location to work at, first match
 * wins. The states are the location chip's own (`LocationSwitcher`), so the
 * two never disagree: a failure is said only when nothing loaded, and a failed
 * refresh over a loaded list is still a list to choose from. `unselected` is
 * the caller's sentence for a loaded list with nothing chosen.
 */
export function noLocationSentence(list: LocationListState, unselected: string): string {
  if (list.isLoading) return "Loading locations…";
  if (list.loadFailed && list.count === 0) return "Couldn't load locations.";
  if (list.count === 0) return "No locations configured.";
  return unselected;
}

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
  stockLoading = false,
  stockFailed = false,
  noLocation = false,
  locationList,
  onRetryStock,
}: WCOrderSelectorProps) {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);

  // Show all orders except cancelled. The workbench is used by packers who
  // deduct inventory independently of the WC order lifecycle — orders may
  // already be "completed" in WC before the packer processes them. Filtering
  // to pending-only hid those orders and broke the real-world workflow.
  const { data, isFetching, error } = useExternalOrders({
    search: debouncedSearch,
    pageSize: 10,
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
        {/* FR2-5: the stock-failed line, once, above the rows (which keep their
            own disabled state and label). Not with no location: that sentence
            comes first on the rows, and there is no stock to read again. */}
        {stockFailed && !noLocation && (
          <div className="flex items-center justify-between gap-2 py-1">
            <p className="text-sm text-destructive">
              Stock couldn&apos;t be loaded — try again shortly.
            </p>
            {onRetryStock && (
              <Button
                variant="outline"
                size="sm"
                className="min-h-[44px] shrink-0"
                onClick={() => onRetryStock()}
              >
                Retry
              </Button>
            )}
          </div>
        )}

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
              No orders found
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
        {orders
          .filter((order) => order.internalStatus !== "cancelled")
          // Sort: un-stocked orders first, then stocked-out at the bottom
          .sort((a, b) => (a.stockedOut === b.stockedOut ? 0 : a.stockedOut ? 1 : -1))
          .map((order) => {
            const isStockedOut = order.stockedOut;

            return (
              <button
                key={order.id}
                onClick={() => onOrderSelected(order)}
                disabled={noLocation || stockLoading || stockFailed}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-lg",
                  "border border-border/60 bg-background px-3 py-2.5",
                  "text-left text-sm transition-colors",
                  "hover:bg-muted/50 hover:border-primary/30",
                  isStockedOut && "opacity-60"
                )}
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <Package className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-sm font-medium">
                        #{order.orderNumber}
                      </span>
                      {order.integration && getPlatformBadge(order.integration.platform)}
                      {isStockedOut && (
                        <span className="text-[10px] px-1.5 py-0 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 font-medium">
                          Stocked Out
                        </span>
                      )}
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
                <span className="text-xs text-muted-foreground shrink-0">
                  {noLocation
                    ? locationList
                      ? noLocationSentence(locationList, NO_LOCATION_CHOSEN)
                      : NO_LOCATION_CHOSEN
                    : stockFailed
                      ? "Stock couldn't be loaded — try again shortly."
                      : stockLoading
                        ? "Loading stock…"
                        : "Select"}
                </span>
              </button>
            );
          })}
      </div>
    </div>
  );
}
