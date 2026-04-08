"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useWorkbench } from "@/hooks/use-workbench";
import { useInventoryProducts } from "@/hooks/use-inventory-products";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { groupProductsByBaseName } from "@/lib/product-utils";
import { ProductTile } from "@/components/workbench/product-tile";
import { QuantityPicker } from "@/components/workbench/quantity-picker";
import { OrderList } from "@/components/workbench/order-list";
import { OrderQueue } from "@/components/workbench/order-queue";
import { CompleteOrderDialog, type DeductionDetail } from "@/components/workbench/complete-order-dialog";
import { WCOrderSelector } from "@/components/workbench/wc-order-selector";
import { UnmappedItemsAlert } from "@/components/workbench/unmapped-items-alert";
import { FloatingCartButton } from "@/components/workbench/floating-cart-button";
import { MobileCartSheet } from "@/components/workbench/mobile-cart-sheet";
import { MobileFilterSheet, StockFilter } from "@/components/products/mobile-filter-sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchInput } from "@/components/ui/search-input";
import { Checkbox } from "@/components/ui/checkbox";
import { ProductWithQuantity } from "@/types/product";
import { RotateCcw, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "@/contexts/location-context";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";

export default function WorkbenchPage() {
  const [selectedProduct, setSelectedProduct] = useState<ProductWithQuantity | null>(null);
  const [showCompleteDialog, setShowCompleteDialog] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [showInStockOnly, setShowInStockOnly] = useState(false);
  const [showLowStockOnly, setShowLowStockOnly] = useState(false);
  const [showOutOfStockOnly, setShowOutOfStockOnly] = useState(false);
  const [stockFilter, setStockFilter] = useState<StockFilter>("all");
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);

  const { selectedLocationId } = useLocation();
  const { token: csrfToken } = useCSRF();
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMobile = useIsMobile();
  const { data: products = [], isLoading: loading, refetch: refetchProducts } = useInventoryProducts({
    locationId: selectedLocationId,
    sortBy: "baseNameNumeric",
    sortOrder: "asc",
  });

  const {
    orderItems,
    orderReference,
    setOrderReference,
    addItem,
    clearOrder,
    getTotalItems,
    getTotalQuantity,
    advanceQueue,
    getQueuePosition,
    orderSource,
    setOrderSource,
    selectedExternalOrder,
    unmappedExternalItems,
    selectExternalOrder,
    clearExternalOrder,
  } = useWorkbench();

  const isWCOrder = !!selectedExternalOrder;

  // Handle scroll for collapsing search bar on mobile
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 50);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // Clean up undo timer on unmount
  useEffect(() => {
    return () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    };
  }, []);

  // Amendment 7: Undo handler with unfulfill API for WC orders
  const handleUndoDeduction = useCallback(
    async (items: DeductionDetail[], orderRef: string, externalOrderId?: string) => {
      if (!csrfToken) {
        toast.error("Session expired. Cannot undo.");
        return;
      }

      try {
        const wcItems = items.filter((item) => item.fulfillmentItemId);
        const manualItems = items.filter((item) => !item.fulfillmentItemId);

        const promises: Promise<Response>[] = [];

        // Undo WC fulfillment via unfulfill API
        if (externalOrderId && wcItems.length > 0) {
          promises.push(
            fetch(`/api/orders/${externalOrderId}/unfulfill`, {
              method: "POST",
              headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
              body: JSON.stringify({
                items: wcItems.map((item) => ({
                  itemId: item.fulfillmentItemId,
                  productId: item.productId,
                  quantity: item.quantity,
                  locationId: item.locationId,
                })),
              }),
            })
          );
        }

        // Undo manual deductions via adjust API (same as existing)
        for (const item of manualItems) {
          promises.push(
            fetch("/api/inventory/adjust", {
              method: "POST",
              headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
              body: JSON.stringify({
                productId: item.productId,
                locationId: item.locationId,
                delta: item.quantity, // positive delta to add back
                logType: "ADJUSTMENT",
              }),
            })
          );
        }

        const results = await Promise.all(promises);
        const allOk = results.every((r) => r.ok);
        if (allOk) {
          toast.success(`Undone: ${items.length} item${items.length !== 1 ? "s" : ""} restored for order ${orderRef}`);
          refetchProducts();
        } else {
          toast.error("Some items could not be restored. Check inventory manually.");
        }
      } catch (err) {
        console.error("Undo deduction error:", err);
        toast.error("Failed to undo deduction. Please adjust inventory manually.");
      }
    },
    [csrfToken, refetchProducts]
  );

  const showUndoToast = useCallback(
    (orderRef: string, items: DeductionDetail[], externalOrderId?: string) => {
      const message = externalOrderId
        ? `Order ${orderRef} fulfilled.`
        : `Order ${orderRef} completed.`;

      toast(
        <div className="flex items-center justify-between w-full gap-3">
          <span className="text-sm">
            <span className="font-mono font-medium">{message}</span>
          </span>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-medium hover:bg-foreground/90 transition-colors shrink-0"
            onClick={() => {
              toast.dismiss(`undo-${orderRef}`);
              handleUndoDeduction(items, orderRef, externalOrderId);
            }}
          >
            <Undo2 className="h-3 w-3" />
            Undo
          </button>
        </div>,
        {
          id: `undo-${orderRef}`,
          duration: 10000,
          dismissible: true,
        }
      );
    },
    [handleUndoDeduction]
  );

  // Sync stock filter with checkboxes
  useEffect(() => {
    if (showInStockOnly) {
      setStockFilter("in-stock");
    } else if (showLowStockOnly) {
      setStockFilter("low-stock");
    } else if (showOutOfStockOnly) {
      setStockFilter("out-of-stock");
    } else {
      setStockFilter("all");
    }
  }, [showInStockOnly, showLowStockOnly, showOutOfStockOnly]);

  const handleProductClick = (product: ProductWithQuantity) => {
    if (product.currentQuantity > 0) {
      setSelectedProduct(product);
    }
  };

  const handleQuantityConfirm = (quantity: number) => {
    if (selectedProduct) {
      // Manual additions always use 'manual' source
      addItem(selectedProduct, quantity, 'manual');
      toast.success(`Added ${quantity} x ${selectedProduct.name}`);
    }
  };

  const handleCompleteOrder = () => {
    if (orderItems.length === 0) {
      toast.error("No items in order");
      return;
    }
    if (!orderReference.trim()) {
      toast.error("Please enter an order reference");
      return;
    }
    setShowCompleteDialog(true);
  };

  const handleClearOrder = () => {
    if (orderItems.length > 0) {
      if (confirm("Are you sure you want to clear the current order?")) {
        clearOrder();
        toast.info("Order cleared");
        setMobileCartOpen(false);
      }
    }
  };

  const handleStockFilterChange = (filter: StockFilter) => {
    setStockFilter(filter);
    // Update checkboxes to match
    setShowInStockOnly(filter === "in-stock");
    setShowLowStockOnly(filter === "low-stock");
    setShowOutOfStockOnly(filter === "out-of-stock");
  };

  const clearFilters = () => {
    setStockFilter("all");
    setShowInStockOnly(false);
    setShowLowStockOnly(false);
    setShowOutOfStockOnly(false);
    setSearchTerm("");
  };

  // Filter products based on search and stock filters
  const filteredProducts = useMemo(() => {
    return products.filter((product) => {
      // Search filter - check if any word in product name starts with search term
      if (searchTerm) {
        const searchLower = searchTerm.toLowerCase();
        const words = product.name.toLowerCase().split(/\s+/);
        const matchesSearch = words.some((word) => word.startsWith(searchLower));
        if (!matchesSearch) return false;
      }

      // Stock filters
      if (showInStockOnly && product.currentQuantity <= 0) return false;
      if (showLowStockOnly && (product.currentQuantity <= 0 || product.currentQuantity > 10))
        return false;
      if (showOutOfStockOnly && product.currentQuantity !== 0) return false;

      return true;
    });
  }, [products, searchTerm, showInStockOnly, showLowStockOnly, showOutOfStockOnly]);

  // Group filtered products by baseName
  const groupedProducts = useMemo(
    () => groupProductsByBaseName(filteredProducts),
    [filteredProducts]
  );

  // Dynamic button text based on order source
  const completeButtonText = isWCOrder ? "Complete & Fulfill" : "Complete & Deduct";

  return (
    <div className="flex flex-col h-full max-h-screen overflow-hidden">
      {/* Header */}
      <PageHeader title="Workbench" description="Quick order processing" />

      {/* Main Content - Two Column Layout */}
      <main className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        {/* Left Side - Product Grid */}
        <div className="flex-1 p-4 sm:p-6 overflow-y-auto">
          <div className="max-w-6xl mx-auto">
            {/* Mobile: Order source toggle above search */}
            {isMobile && (
              <div className="mb-3">
                <Tabs
                  value={orderSource}
                  onValueChange={(v) => setOrderSource(v as 'manual' | 'wc-order')}
                >
                  <TabsList className="w-full">
                    <TabsTrigger value="manual" className="flex-1">Manual</TabsTrigger>
                    <TabsTrigger value="wc-order" className="flex-1">From Order</TabsTrigger>
                  </TabsList>
                  {orderSource === 'wc-order' && (
                    <TabsContent value="wc-order" className="mt-2">
                      <WCOrderSelector
                        onOrderSelected={(order) => selectExternalOrder(order, products)}
                        selectedOrder={selectedExternalOrder}
                        onClear={clearExternalOrder}
                      />
                      {unmappedExternalItems.length > 0 && (
                        <div className="mt-2">
                          <UnmappedItemsAlert
                            items={unmappedExternalItems}
                            onItemMapped={() => {
                              // Re-select the same order to re-populate after mapping
                              if (selectedExternalOrder) {
                                // The WCOrderSelector handles re-fetch internally
                              }
                            }}
                          />
                        </div>
                      )}
                    </TabsContent>
                  )}
                </Tabs>
                {/* Mobile: slim selected order banner when in WC mode */}
                {isMobile && isWCOrder && orderSource === 'manual' && (
                  <div className="mt-2 flex items-center justify-between rounded-md border border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/30 px-3 py-1.5">
                    <span className="text-xs font-mono">
                      WC #{selectedExternalOrder.orderNumber}
                      {selectedExternalOrder.customerName && (
                        <span className="ml-1.5 text-muted-foreground font-sans">
                          {selectedExternalOrder.customerName}
                        </span>
                      )}
                    </span>
                    <button
                      onClick={clearExternalOrder}
                      className="text-xs text-muted-foreground hover:text-destructive ml-2"
                    >
                      x
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Search and Filters */}
            <div
              className={cn(
                "mb-4 md:mb-6 space-y-4",
                "sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60",
                "transition-all duration-300",
                isMobile && isScrolled ? "py-2" : "pb-4"
              )}
            >
              {/* Search Bar */}
              <div className="flex gap-2">
                <SearchInput
                  placeholder={isMobile && isScrolled ? "Search..." : "Search products..."}
                  value={searchTerm}
                  onSearch={setSearchTerm}
                  className={cn(
                    "flex-1 transition-all duration-300",
                    isMobile && !isScrolled ? "max-w-none" : "max-w-md"
                  )}
                />
                {isMobile && (
                  <MobileFilterSheet
                    stockFilter={stockFilter}
                    onStockFilterChange={handleStockFilterChange}
                    onClearFilters={clearFilters}
                    activeFilterCount={stockFilter !== "all" ? 1 : 0}
                  />
                )}
              </div>

              {/* Filter Toggles - Desktop Only */}
              {!isMobile && (
                <div className="flex flex-wrap gap-4">
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="in-stock"
                      checked={showInStockOnly}
                      onCheckedChange={(checked) => {
                        setShowInStockOnly(!!checked);
                        if (checked) {
                          setShowLowStockOnly(false);
                          setShowOutOfStockOnly(false);
                        }
                      }}
                    />
                    <Label
                      htmlFor="in-stock"
                      className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                    >
                      Show in stock only
                    </Label>
                  </div>

                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="low-stock"
                      checked={showLowStockOnly}
                      onCheckedChange={(checked) => {
                        setShowLowStockOnly(!!checked);
                        if (checked) {
                          setShowInStockOnly(false);
                          setShowOutOfStockOnly(false);
                        }
                      }}
                    />
                    <Label
                      htmlFor="low-stock"
                      className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                    >
                      Show low stock only
                    </Label>
                  </div>

                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="out-of-stock"
                      checked={showOutOfStockOnly}
                      onCheckedChange={(checked) => {
                        setShowOutOfStockOnly(!!checked);
                        if (checked) {
                          setShowInStockOnly(false);
                          setShowLowStockOnly(false);
                        }
                      }}
                    />
                    <Label
                      htmlFor="out-of-stock"
                      className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                    >
                      Show out of stock only
                    </Label>
                  </div>
                </div>
              )}
            </div>
            {loading ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4">
                {Array.from({ length: 12 }).map((_, i) => (
                  <Skeleton key={i} className="h-40 rounded-lg" />
                ))}
              </div>
            ) : filteredProducts.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-muted-foreground">
                  {products.length === 0
                    ? "No products available"
                    : "No products match your filters"}
                </p>
              </div>
            ) : (
              <div className="space-y-6 pb-20 md:pb-0">
                {groupedProducts.map((group) => (
                  <div key={group.label.toLowerCase()}>
                    <div className="flex items-center gap-3 mb-3 sticky top-16 md:relative md:top-0 bg-background/95 backdrop-blur py-2 -mx-1 px-1">
                      <h3 className="text-label uppercase tracking-wider text-muted-foreground">
                        {group.label}
                      </h3>
                      <div className="flex-1 h-px bg-border" />
                      <span className="text-caption text-muted-foreground tabular-nums">
                        {group.products.length}
                      </span>
                    </div>
                    <div
                      className={cn(
                        "grid gap-3 sm:gap-4",
                        isMobile
                          ? "grid-cols-2"
                          : "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5"
                      )}
                    >
                      {group.products.map((product) => (
                        <ProductTile
                          key={product.id}
                          product={product}
                          onClick={handleProductClick}
                          className={isMobile ? "aspect-square" : ""}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Side - Order Panel (Desktop Only) */}
        {!isMobile && (
          <div className="w-full lg:w-96 border-t lg:border-t-0 lg:border-l border-border bg-muted/5 flex flex-col">
            {/* Order Queue */}
            <OrderQueue />

            {/* Order Header with Order Source Toggle */}
            <div className="p-4 border-b bg-background">
              <h2 className="text-lg font-semibold mb-3">Current Order</h2>

              {/* Order Source Tabs */}
              <Tabs
                value={orderSource}
                onValueChange={(v) => setOrderSource(v as 'manual' | 'wc-order')}
              >
                <TabsList className="w-full mb-3">
                  <TabsTrigger value="manual" className="flex-1">Manual</TabsTrigger>
                  <TabsTrigger value="wc-order" className="flex-1">From Order</TabsTrigger>
                </TabsList>

                {/* Manual tab: preserve existing text input */}
                <TabsContent value="manual">
                  <div className="space-y-2">
                    <Label htmlFor="order-reference">Order Reference</Label>
                    <Input
                      id="order-reference"
                      placeholder="Enter order number..."
                      value={orderReference}
                      onChange={(e) => setOrderReference(e.target.value)}
                      className="font-mono"
                    />
                  </div>
                </TabsContent>

                {/* From Order tab: WC order selector */}
                <TabsContent value="wc-order">
                  <WCOrderSelector
                    onOrderSelected={(order) => selectExternalOrder(order, products)}
                    selectedOrder={selectedExternalOrder}
                    onClear={clearExternalOrder}
                  />
                  {unmappedExternalItems.length > 0 && (
                    <div className="mt-2">
                      <UnmappedItemsAlert
                        items={unmappedExternalItems}
                        onItemMapped={() => {
                          // Re-select triggers re-fetch through the selector
                        }}
                      />
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </div>

            {/* Order Items */}
            <div className="flex-1 overflow-hidden">
              <OrderList />
            </div>

            {/* Order Actions */}
            <div className="p-4 border-t bg-background space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Total items:</span>
                <span className="font-medium">{getTotalItems()}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Total quantity:</span>
                <span className="font-medium">{getTotalQuantity()} units</span>
              </div>

              <div className="flex gap-2 pt-2">
                <Button
                  variant="outline"
                  onClick={handleClearOrder}
                  disabled={orderItems.length === 0}
                  className="flex-1"
                >
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Clear
                </Button>
                <Button
                  onClick={handleCompleteOrder}
                  disabled={orderItems.length === 0 || !orderReference.trim()}
                  className="flex-1 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
                >
                  {completeButtonText}
                </Button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Quantity Picker Dialog */}
      <QuantityPicker
        product={selectedProduct}
        open={!!selectedProduct}
        onClose={() => setSelectedProduct(null)}
        onConfirm={handleQuantityConfirm}
      />

      {/* Mobile FAB */}
      {isMobile && (
        <FloatingCartButton itemCount={getTotalItems()} onClick={() => setMobileCartOpen(true)} />
      )}

      {/* Mobile Cart Sheet */}
      {isMobile && (
        <MobileCartSheet
          open={mobileCartOpen}
          onOpenChange={setMobileCartOpen}
          orderReference={orderReference}
          onOrderReferenceChange={setOrderReference}
          totalItems={getTotalItems()}
          totalQuantity={getTotalQuantity()}
          onClearOrder={handleClearOrder}
          onCompleteOrder={handleCompleteOrder}
          canComplete={orderItems.length > 0 && !!orderReference.trim()}
          queuePosition={getQueuePosition()}
        />
      )}

      {/* Complete Order Dialog */}
      <CompleteOrderDialog
        open={showCompleteDialog}
        onOpenChange={setShowCompleteDialog}
        onSuccess={({ orderReference: completedRef, items: deductedItems, externalOrderId }) => {
          refetchProducts();
          setMobileCartOpen(false);
          // Show undo toast for 10 seconds (Amendment 7: includes unfulfill for WC orders)
          showUndoToast(completedRef, deductedItems, externalOrderId);
          // Advance to the next order in the queue (Amendment 6: forces manual mode)
          const next = advanceQueue();
          if (next) {
            toast.info(`Loaded next order: ${next}`);
          }
        }}
      />
    </div>
  );
}
