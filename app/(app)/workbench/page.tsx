"use client";

import { useState, useEffect, useMemo } from "react";
import { useWorkbench } from "@/hooks/use-workbench";
import { ProductTile } from "@/components/workbench/product-tile";
import { QuantityPicker } from "@/components/workbench/quantity-picker";
import { OrderList } from "@/components/workbench/order-list";
import { CompleteOrderDialog } from "@/components/workbench/complete-order-dialog";
import { FloatingCartButton } from "@/components/workbench/floating-cart-button";
import { MobileCartSheet } from "@/components/workbench/mobile-cart-sheet";
import { MobileFilterSheet, StockFilter } from "@/components/products/mobile-filter-sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchInput } from "@/components/ui/search-input";
import { Checkbox } from "@/components/ui/checkbox";
import { ProductWithQuantity } from "@/types/product";
import { Package, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "@/contexts/location-context";
import { cn } from "@/lib/utils";

export default function WorkbenchPage() {
  const [products, setProducts] = useState<ProductWithQuantity[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedProduct, setSelectedProduct] = useState<ProductWithQuantity | null>(null);
  const [showCompleteDialog, setShowCompleteDialog] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [showInStockOnly, setShowInStockOnly] = useState(false);
  const [showLowStockOnly, setShowLowStockOnly] = useState(false);
  const [showOutOfStockOnly, setShowOutOfStockOnly] = useState(false);
  const [stockFilter, setStockFilter] = useState<StockFilter>("all");
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  
  const { selectedLocationId } = useLocation();
  
  const {
    orderItems,
    orderReference,
    setOrderReference,
    addItem,
    clearOrder,
    getTotalItems,
    getTotalQuantity,
  } = useWorkbench();

  // Check if mobile on mount and resize
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Handle scroll for collapsing search bar on mobile
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

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

  // Fetch products when location changes
  useEffect(() => {
    if (selectedLocationId) {
      fetchProducts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLocationId]);

  const fetchProducts = async () => {
    if (!selectedLocationId) return;
    
    setLoading(true);
    try {
      // First get all products
      const productsResponse = await fetch("/api/products?isActive=true&pageSize=100");
      if (!productsResponse.ok) throw new Error("Failed to fetch products");
      
      const productsData = await productsResponse.json();
      
      // Then get inventory levels for the selected location
      const inventoryResponse = await fetch(`/api/inventory/current-fast?locationId=${selectedLocationId}`);
      if (!inventoryResponse.ok) throw new Error("Failed to fetch inventory");
      
      const inventoryData = await inventoryResponse.json();
      
      // Map inventory quantities to products
      const inventoryMap = new Map(
        inventoryData.inventory.map((item: { productId: number; quantity: number }) => [item.productId, item.quantity])
      );
      
      // Update products with current quantities
      const productsWithQuantity = productsData.products.map((product: { id: number; [key: string]: unknown }) => ({
        ...product,
        currentQuantity: inventoryMap.get(product.id) || 0,
      }));
      
      setProducts(productsWithQuantity);
    } catch (error) {
      console.error("Error fetching products:", error);
      toast.error("Failed to load products");
    } finally {
      setLoading(false);
    }
  };

  const handleProductClick = (product: ProductWithQuantity) => {
    if (product.currentQuantity > 0) {
      setSelectedProduct(product);
    }
  };

  const handleQuantityConfirm = (quantity: number) => {
    if (selectedProduct) {
      addItem(selectedProduct, quantity);
      toast.success(`Added ${quantity} × ${selectedProduct.name}`);
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
        const matchesSearch = words.some(word => word.startsWith(searchLower));
        if (!matchesSearch) return false;
      }

      // Stock filters
      if (showInStockOnly && product.currentQuantity <= 0) return false;
      if (showLowStockOnly && (product.currentQuantity <= 0 || product.currentQuantity > 10)) return false;
      if (showOutOfStockOnly && product.currentQuantity !== 0) return false;

      return true;
    });
  }, [products, searchTerm, showInStockOnly, showLowStockOnly, showOutOfStockOnly]);

  // Group filtered products by baseName
  const groupedProducts = filteredProducts.reduce((acc, product) => {
    const baseName = product.baseName || 'Other';
    if (!acc[baseName]) {
      acc[baseName] = [];
    }
    acc[baseName].push(product);
    return acc;
  }, {} as Record<string, ProductWithQuantity[]>);

  return (
    <div className="flex flex-col h-full max-h-screen overflow-hidden">
      {/* Header */}
      <header className="border-b border-border bg-background px-4 sm:px-6 py-3 sm:py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2">
              <Package className="h-5 w-5 sm:h-6 sm:w-6" />
              Workbench
            </h1>
            <p className="text-xs sm:text-sm text-muted-foreground">
              Quick order processing
            </p>
          </div>
        </div>
      </header>

      {/* Main Content - Two Column Layout */}
      <main className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        {/* Left Side - Product Grid */}
        <div className="flex-1 p-4 sm:p-6 overflow-y-auto">
          <div className="max-w-6xl mx-auto">
            {/* Search and Filters */}
            <div className={cn(
              "mb-4 md:mb-6 space-y-4",
              "sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60",
              "transition-all duration-300",
              isMobile && isScrolled ? "py-2" : "pb-4"
            )}>
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
                {Object.entries(groupedProducts).map(([baseName, groupProducts]) => (
                  <div key={baseName}>
                    <h3 className="font-medium text-sm text-muted-foreground mb-3 sticky top-16 md:relative md:top-0 bg-background/95 backdrop-blur py-1 -mx-1 px-1">
                      {baseName}
                    </h3>
                    <div className={cn(
                      "grid gap-3 sm:gap-4",
                      isMobile
                        ? "grid-cols-2"
                        : "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5"
                    )}>
                      {groupProducts.map((product) => (
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
            {/* Order Header */}
            <div className="p-4 border-b bg-background">
              <h2 className="text-lg font-semibold mb-3">Current Order</h2>
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
                  className="flex-1"
                >
                  Complete & Deduct
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
        <FloatingCartButton
          itemCount={getTotalItems()}
          onClick={() => setMobileCartOpen(true)}
        />
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
        />
      )}

      {/* Complete Order Dialog */}
      <CompleteOrderDialog
        open={showCompleteDialog}
        onOpenChange={setShowCompleteDialog}
        onSuccess={() => {
          fetchProducts();
          setMobileCartOpen(false);
        }}
      />
    </div>
  );
}