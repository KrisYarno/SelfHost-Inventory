"use client";

import { useState, useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Package, RefreshCw, Loader2, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryState } from "@/components/ui/query-state";
import { Page } from "@/components/layout/page";
import { ExternalOrderCard } from "@/components/orders/external-order-card";
import { OrderFilters } from "@/components/orders/order-filters";
import { ExternalOrderDetailsSheet } from "@/components/orders/external-order-details-sheet";
import { useExternalOrders, useUserCompanies } from "@/hooks/use-external-orders";
import { useCSRF } from "@/hooks/use-csrf";
import { cn } from "@/lib/utils";
import type { ExternalOrder, PlatformType, InternalOrderStatus } from "@/types/external-orders";

// "Load More" asks for 50 more (F0-7). The API's pageSize is unbounded, so the
// client caps it: past 200, search or filter narrows the list instead.
const ORDERS_PAGE_STEP = 50;
const ORDERS_PAGE_CAP = 200;

export default function OrdersPage() {
  // State for filters
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [platform, setPlatform] = useState<PlatformType | "ALL">("ALL");
  const [status, setStatus] = useState<InternalOrderStatus | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [pageSize, setPageSize] = useState(ORDERS_PAGE_STEP);
  // FR1-9 (ruled): the size the list had before the last Load More, until that
  // bigger read answers. Null when no Load More is outstanding.
  const [loadMoreFrom, setLoadMoreFrom] = useState<number | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<ExternalOrder | null>(null);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const { token: csrfToken } = useCSRF();

  // Fetch user's companies
  const companiesQuery = useUserCompanies();
  const companiesData = companiesQuery.data;
  const companies = useMemo(() => companiesData?.companies || [], [companiesData?.companies]);

  // Set default company when companies are loaded
  useEffect(() => {
    if (companies.length > 0 && !selectedCompanyId) {
      setSelectedCompanyId(companies[0].id);
    }
  }, [companies, selectedCompanyId]);

  // Fetch orders with filters
  const ordersQuery = useExternalOrders({
    companyId: selectedCompanyId || undefined,
    platform,
    status,
    search: searchQuery,
    page: 1,
    pageSize,
  });
  const { data: ordersData, error: ordersError, refetch, isFetching, isPlaceholderData } = ordersQuery;

  // Memoized so the identity is stable across renders — the rebind effect below
  // depends on `orders`, and a fresh array each render would re-run it endlessly.
  const orders = useMemo(() => ordersData?.orders || [], [ordersData?.orders]);
  const hasMore = ordersData?.hasMore || false;
  const atCap = pageSize >= ORDERS_PAGE_CAP;

  // Any change of what is listed starts again at the first 50. Reset in the
  // handlers (not an effect), so the new filter is never fetched at the old size.
  const resetPageSize = () => {
    setPageSize(ORDERS_PAGE_STEP);
    setLoadMoreFrom(null);
  };
  const handleLoadMore = () => {
    setLoadMoreFrom(pageSize);
    setPageSize((size) => Math.min(size + ORDERS_PAGE_STEP, ORDERS_PAGE_CAP));
  };

  // FR1-9 (orchestrator ruling): Load More asks under a NEW query key, and when
  // that read fails react-query drops the placeholder rows — the list would
  // vanish behind the error panel. So a failed Load More puts the size back:
  // the key returns to the last SUCCESSFUL list (still cached), the operator is
  // told, and Load More is offered again. A layout effect, so the failed key's
  // empty render is never painted. A failed POLL is not this: it keeps its rows.
  useLayoutEffect(() => {
    if (loadMoreFrom === null) return;
    if (ordersError && ordersData === undefined) {
      setPageSize(loadMoreFrom);
      setLoadMoreFrom(null);
      toast.error("Couldn't load more orders — try again.");
    } else if (ordersData !== undefined && !isPlaceholderData) {
      setLoadMoreFrom(null);
    }
  }, [loadMoreFrom, ordersError, ordersData, isPlaceholderData]);
  const handleCompanyChange = (companyId: string) => {
    setSelectedCompanyId(companyId);
    resetPageSize();
  };
  const handlePlatformChange = (next: PlatformType | "ALL") => {
    setPlatform(next);
    resetPageSize();
  };
  const handleStatusChange = (next: InternalOrderStatus | "all") => {
    setStatus(next);
    resetPageSize();
  };
  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    resetPageSize();
  };

  // Handle order selection
  const handleOrderSelect = useCallback((order: ExternalOrder) => {
    setSelectedOrder(order);
    setIsSheetOpen(true);
  }, []);

  // Handle refresh
  const handleRefresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  // Issue 1b fix: when the orders list refetches, find the currently-selected
  // order in the new list and rebind selectedOrder to the fresh version.
  // Without this, the detail sheet keeps rendering stale data after a mapping
  // / fulfillment / recheck even though the underlying list updated.
  useEffect(() => {
    if (!selectedOrder) return;
    const fresh = orders.find((o) => o.id === selectedOrder.id);
    if (fresh && fresh !== selectedOrder) {
      setSelectedOrder(fresh);
    }
  }, [orders, selectedOrder]);

  // Facelift F1-7: the companies read says its own states inside the page
  // frame — loading, a failed read (never "no companies"), and an ANSWER of
  // none. A list with companies renders the page below.
  if (companies.length === 0) {
    return (
      <Page title="Orders" width="wide">
        <QueryState
          query={companiesQuery}
          skeleton={
            <div className="flex items-center justify-center min-h-[400px]">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          }
          isEmpty={(data) => (data?.companies ?? []).length === 0}
          empty={
            <div className="flex flex-col items-center justify-center min-h-[400px] text-center px-4">
              <Package className="h-16 w-16 text-muted-foreground/50 mb-4" />
              <h2 className="text-2xl font-semibold mb-2">No Companies Found</h2>
              <p className="text-muted-foreground max-w-md">
                You need to be associated with a company to view orders. Please contact your administrator.
              </p>
            </div>
          }
          errorText="Couldn't load your companies."
        >
          {() => null}
        </QueryState>
      </Page>
    );
  }

  return (
    <Page
      title="Orders"
      description="Manage external orders from Shopify and WooCommerce"
      width="wide"
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={isFetching}
          className="gap-2"
          aria-label="Refresh"
        >
          <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      }
    >
      <div className="space-y-6">
        {/* Filters */}
        <OrderFilters
          companies={companies}
          selectedCompanyId={selectedCompanyId}
          onCompanyChange={handleCompanyChange}
          platform={platform}
          onPlatformChange={handlePlatformChange}
          status={status}
          onStatusChange={handleStatusChange}
          searchQuery={searchQuery}
          onSearchChange={handleSearchChange}
        />

        {/* Orders List — F1-7: error only with nothing loaded (the list polls
            every 30 s, and a failed poll over loaded rows keeps the rows); empty
            only on an answer, never on placeholder rows. */}
        <div className="space-y-4">
          <QueryState
            query={ordersQuery}
            skeleton={
              <div className="space-y-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-32 w-full rounded-lg" />
                ))}
              </div>
            }
            isEmpty={(data) => (data.orders ?? []).length === 0}
            empty={
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="rounded-2xl bg-muted/50 p-6 mb-6">
                  <Package className="h-16 w-16 text-muted-foreground/40" />
                </div>
                <h3 className="text-h3 mb-2">No Orders Found</h3>
                {searchQuery || status !== "all" ? (
                  <p className="text-body text-muted-foreground max-w-sm">
                    No orders match your current filters. Try adjusting your search or status filter.
                  </p>
                ) : (
                  <>
                    <p className="text-body text-muted-foreground max-w-sm mb-6">
                      Orders will appear here once you connect a Shopify or WooCommerce store.
                      Set up an integration to start syncing orders automatically.
                    </p>
                    <Button asChild variant="outline">
                      <Link href="/admin/integrations">
                        <Plug className="h-4 w-4 mr-2" />
                        Set Up Integration
                      </Link>
                    </Button>
                  </>
                )}
              </div>
            }
            errorTitle="Failed to Load Orders"
            errorText="Please check your connection and try again"
          >
            {() => (
              <>
                <div className="grid gap-3 grid-cols-1 lg:grid-cols-2 xl:grid-cols-3">
                  {orders.map((order) => (
                    <ExternalOrderCard
                      key={order.id}
                      order={order}
                      onSelect={handleOrderSelect}
                    />
                  ))}
                </div>

                {/* Load More: 50 more per click, the current list kept on screen
                    while the bigger page loads; at the cap, a sentence instead. */}
                {hasMore &&
                  (atCap && !isPlaceholderData ? (
                    <p className="pt-4 text-center text-sm text-muted-foreground">
                      Showing the newest 200 — search or filter to find older orders.
                    </p>
                  ) : (
                    <div className="flex justify-center pt-4">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isPlaceholderData}
                        onClick={handleLoadMore}
                      >
                        {isPlaceholderData ? "Loading…" : "Load More"}
                      </Button>
                    </div>
                  ))}

                {/* Results summary */}
                <div className="text-center text-sm text-muted-foreground py-4">
                  Showing {orders.length} of {ordersData?.total || 0} orders
                </div>
              </>
            )}
          </QueryState>
        </div>

        {/* Order Details Sheet */}
        {selectedOrder && (
          <ExternalOrderDetailsSheet
            order={selectedOrder}
            open={isSheetOpen}
            onOpenChange={setIsSheetOpen}
            onRefresh={handleRefresh}
            csrfToken={csrfToken || undefined}
          />
        )}
      </div>
    </Page>
  );
}
