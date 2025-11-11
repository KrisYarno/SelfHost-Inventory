'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { SimpleInventoryLogTable } from '@/components/inventory/simple-inventory-log-table';
import { VariantProductCard } from '@/components/inventory/variant-product-card';
import { QuickAdjustDialog } from '@/components/inventory/quick-adjust-dialog';
import { StockInDialog } from '@/components/inventory/stock-in-dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';
import { BookOpen, Loader2, RefreshCw, Download, Package } from 'lucide-react';
import { toast } from 'sonner';
import { useInfiniteScroll } from '@/hooks/use-infinite-scroll';
import { useDebounce } from '@/hooks/use-debounce';
import { useLocation } from '@/contexts/location-context';
import { fetchWithErrorHandling } from '@/lib/rate-limited-fetch';
import type { 
  InventoryLogWithRelations
} from '@/types/inventory';
import type { ProductWithQuantity } from '@/types/product';


interface ProductWithLocations {
  id: number;
  name: string;
  baseName: string;
  variant: string | null;
  locations: {
    locationId: number;
    locationName: string;
    quantity: number;
  }[];
  totalQuantity: number;
}

interface PaginationInfo {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export default function InventoryPage() {
  const { selectedLocationId } = useLocation();
  const [logs, setLogs] = useState<InventoryLogWithRelations[]>([]);
  const [products, setProducts] = useState<ProductWithLocations[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<ProductWithQuantity | null>(null);
  const [showQuickAdjust, setShowQuickAdjust] = useState(false);
  const [showStockIn, setShowStockIn] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [pagination, setPagination] = useState<PaginationInfo>({
    page: 1,
    pageSize: 12,
    total: 0,
    totalPages: 0,
    hasMore: false,
  });
  const [expandedCategories, setExpandedCategories] = useState<string[]>([]);

  const debouncedSearch = useDebounce(searchQuery, 300);

  // Group products by baseName (category)
  const groupedProducts = useMemo(() => {
    const groups: Record<string, ProductWithLocations[]> = {};
    
    products.forEach(product => {
      const category = product.baseName || 'Uncategorized';
      if (!groups[category]) {
        groups[category] = [];
      }
      groups[category].push(product);
    });

    // Sort categories alphabetically and sort products within each category
    const sortedGroups: Record<string, ProductWithLocations[]> = {};
    Object.keys(groups)
      .sort((a, b) => a.localeCompare(b))
      .forEach(key => {
        sortedGroups[key] = groups[key].sort((a, b) => {
          // Sort by variant name if they exist
          if (a.variant && b.variant) {
            return a.variant.localeCompare(b.variant);
          }
          return 0;
        });
      });

    return sortedGroups;
  }, [products]);

  // Get all category keys for accordion default value
  const allCategories = useMemo(() => Object.keys(groupedProducts), [groupedProducts]);

  // Load/maintain expanded categories (stable, no auto-expand on new data)
  useEffect(() => {
    if (allCategories.length === 0) {
      setExpandedCategories([]);
      return;
    }

    try {
      const saved = localStorage.getItem('inventory-expanded-categories');
      const parsed: string[] = saved ? JSON.parse(saved) : [];
      // Keep only categories that still exist; do NOT auto-expand new ones
      const next = parsed.filter((cat) => allCategories.includes(cat));
      setExpandedCategories(next);
    } catch {
      // On parse error, default to collapsed
      setExpandedCategories([]);
    }
  }, [allCategories]);

  // Save expanded categories to localStorage when they change
  const handleAccordionChange = (value: string | string[]) => {
    const newValue = Array.isArray(value) ? value : [value];
    setExpandedCategories(newValue);
    localStorage.setItem('inventory-expanded-categories', JSON.stringify(newValue));
  };

  // Fetch products with variants and pagination
  const fetchProducts = useCallback(async (page: number = 1, append: boolean = false) => {
    if (append) {
      setIsLoadingMore(true);
    } else {
      setIsLoading(true);
    }

    try {
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: '12',
        ...(debouncedSearch && { search: debouncedSearch }),
        // Don't filter by location - show all locations for each product
      });

      const data = await fetchWithErrorHandling(`/api/inventory/variants?${params}`);
      
      if (append) {
        setProducts(prev => [...prev, ...data.products]);
      } else {
        setProducts(data.products);
      }
      
      setPagination(data.pagination);
    } catch (error) {
      console.error('Error fetching inventory:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to load inventory';
      toast.error(errorMessage);
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  }, [debouncedSearch, selectedLocationId]);

  // Fetch inventory logs
  const fetchLogs = async () => {
    try {
      const data = await fetchWithErrorHandling('/api/inventory/logs?pageSize=20');
      setLogs(data.logs);
    } catch {
      toast.error('Failed to load inventory logs');
    }
  };

  // Load more items
  const loadMore = useCallback(() => {
    if (!isLoadingMore && pagination.hasMore) {
      fetchProducts(pagination.page + 1, true);
    }
  }, [fetchProducts, isLoadingMore, pagination]);

  // Pull to refresh handler
  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([
        fetchProducts(1, false),
        fetchLogs()
      ]);
      toast.success('Inventory refreshed');
    } catch {
      toast.error('Failed to refresh inventory');
    } finally {
      setIsRefreshing(false);
    }
  };

  // Setup infinite scroll
  const { loadMoreRef } = useInfiniteScroll({
    loading: isLoadingMore,
    hasMore: pagination.hasMore,
    onLoadMore: loadMore,
  });

  // Initial load
  useEffect(() => {
    fetchProducts();
    fetchLogs();
  }, []); // Removed selectedLocationId dependency

  // Search effect
  useEffect(() => {
    if (debouncedSearch !== undefined) {
      fetchProducts(1, false);
    }
  }, [debouncedSearch, fetchProducts]);

  // Touch/Pull to refresh setup for mobile
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let startY = 0;
    let currentY = 0;
    let pulling = false;
    const pullIndicator = document.createElement('div');
    pullIndicator.className = 'fixed top-0 left-0 right-0 h-16 bg-background/80 backdrop-blur-sm flex items-center justify-center transition-transform duration-300 z-40';
    pullIndicator.style.transform = 'translateY(-100%)';
    pullIndicator.innerHTML = '<div class="flex items-center gap-2"><svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><span class="text-sm">Pull to refresh</span></div>';
    document.body.appendChild(pullIndicator);

    const handleTouchStart = (e: TouchEvent) => {
      if (window.scrollY === 0) {
        startY = e.touches[0].clientY;
        pulling = true;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!pulling) return;
      currentY = e.touches[0].clientY;
      const pullDistance = currentY - startY;

      if (pullDistance > 0 && window.scrollY === 0) {
        e.preventDefault();
        const progress = Math.min(pullDistance / 120, 1);
        pullIndicator.style.transform = `translateY(${-100 + progress * 100}%)`;
      }
    };

    const handleTouchEnd = () => {
      if (!pulling) return;
      pulling = false;
      const pullDistance = currentY - startY;

      if (pullDistance > 80 && !isRefreshing) {
        handleRefresh();
      }
      
      pullIndicator.style.transform = 'translateY(-100%)';
    };

    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);

    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      if (pullIndicator.parentNode) {
        pullIndicator.parentNode.removeChild(pullIndicator);
      }
    };
  }, [isRefreshing]);

  const handleProductAction = (productId: number, action: 'adjust' | 'stockIn') => {
    // Find the product and convert to ProductWithQuantity format
    const product = products.find(p => p.id === productId);
    if (!product) return;
    
    const productWithQuantity: ProductWithQuantity = {
      id: product.id,
      name: product.name,
      baseName: product.baseName || '',
      variant: product.variant,
      unit: null,
      numericValue: null,
      quantity: product.totalQuantity,
      location: 1,
      lowStockThreshold: 1,
      // default prices for client-side constructed object
      costPrice: 0 as any,
      retailPrice: 0 as any,
      currentQuantity: product.totalQuantity,
      lastUpdated: new Date(),
      deletedAt: null,
      deletedBy: null
    };
    
    setSelectedProduct(productWithQuantity);
    if (action === 'adjust') {
      setShowQuickAdjust(true);
    } else {
      setShowStockIn(true);
    }
  };

  const refreshData = () => {
    fetchProducts();
    fetchLogs();
  };

  const handleExportCSV = async () => {
    try {
      const response = await fetch("/api/inventory/export", {
        method: "GET",
      });
      
      if (!response.ok) throw new Error("Failed to export data");
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `inventory-${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      toast.success("Export completed successfully");
    } catch (error) {
      toast.error("Failed to export data");
      console.error(error);
    }
  };

  return (
    <div className="space-y-6">
      {/* Pull to refresh indicator */}
      {isRefreshing && (
        <div className="fixed top-0 left-0 right-0 z-50 flex justify-center p-4 bg-background/80 backdrop-blur-sm">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Refreshing...</span>
          </div>
        </div>
      )}

      <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Inventory Management</h1>
          <p className="text-sm sm:text-base text-muted-foreground">
            Track inventory levels, view transaction history, and manage stock adjustments.
          </p>
        </div>
        <div className="flex gap-2 w-full sm:w-auto">
          <Button asChild variant="outline" size="sm" className="flex-1 sm:flex-initial">
            <Link href="/journal" className="gap-2">
              <BookOpen className="h-4 w-4" />
              <span className="hidden sm:inline">Journal Mode</span>
              <span className="sm:hidden">Journal</span>
            </Link>
          </Button>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={handleExportCSV}
            className="flex-1 sm:flex-initial"
          >
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">Export CSV</span>
            <span className="sm:hidden">Export</span>
          </Button>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="sm:hidden"
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Current Inventory Levels */}
      <Card>
        <CardHeader>
          <CardTitle>Current Stock Levels</CardTitle>
          <CardDescription>Real-time inventory quantities across all products and locations</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Search Bar and Controls */}
          <div className="mb-6 space-y-4">
            <div className="flex flex-col sm:flex-row gap-4">
              <Input
                type="search"
                placeholder="Search products..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="max-w-sm"
              />
              {products.length > 0 && (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setExpandedCategories(allCategories);
                      localStorage.setItem('inventory-expanded-categories', JSON.stringify(allCategories));
                    }}
                    className="whitespace-nowrap"
                  >
                    Expand All
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setExpandedCategories([]);
                      localStorage.setItem('inventory-expanded-categories', JSON.stringify([]));
                    }}
                    className="whitespace-nowrap"
                  >
                    Collapse All
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Loading State */}
          {isLoading && products.length === 0 ? (
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {[...Array(6)].map((_, i) => (
                <Card key={i}>
                  <CardContent className="p-6">
                    <div className="space-y-3">
                      <Skeleton className="h-6 w-3/4" />
                      <Skeleton className="h-4 w-1/2" />
                      <Skeleton className="h-20 w-full" />
                      <div className="flex gap-2">
                        <Skeleton className="h-9 flex-1" />
                        <Skeleton className="h-9 flex-1" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : products.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground">
                {searchQuery ? 'No products found matching your search.' : 'No products found in inventory.'}
              </p>
              {!searchQuery && (
                <Button asChild className="mt-4">
                  <Link href="/products">Add Products</Link>
                </Button>
              )}
            </div>
          ) : (
            <>
              <Accordion 
                type="multiple" 
                value={expandedCategories}
                onValueChange={handleAccordionChange}
                className="space-y-4"
              >
                {Object.entries(groupedProducts).map(([category, categoryProducts]) => (
                  <AccordionItem key={category} value={category} className="border-border">
                    <AccordionTrigger className="hover:no-underline">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between w-full pr-4 gap-2">
                        <div className="flex items-center gap-2 sm:gap-3">
                          <Package className="h-4 w-4 sm:h-5 sm:w-5 text-muted-foreground shrink-0" />
                          <span className="text-sm sm:text-base font-semibold truncate">{category}</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs sm:text-sm">
                          <Badge variant="secondary" className="font-normal px-2 py-0.5">
                            {categoryProducts.length} {categoryProducts.length === 1 ? 'variant' : 'variants'}
                          </Badge>
                          <Badge variant="outline" className="font-normal px-2 py-0.5">
                            {categoryProducts.reduce((sum, p) => sum + p.totalQuantity, 0)} units
                          </Badge>
                        </div>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 pt-4">
                        {categoryProducts.map((product) => (
                          <VariantProductCard
                            key={product.id}
                            product={product}
                            onStockIn={(id, locationId) => handleProductAction(id, 'stockIn')}
                            onAdjust={(id, locationId) => handleProductAction(id, 'adjust')}
                          />
                        ))}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>

              {/* Load More Trigger */}
              <div ref={loadMoreRef} className="h-20 flex items-center justify-center">
                {isLoadingMore && (
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-sm text-muted-foreground">Loading more...</span>
                  </div>
                )}
                {!pagination.hasMore && products.length > 0 && (
                  <p className="text-sm text-muted-foreground">
                    Showing all {pagination.total} products in {Object.keys(groupedProducts).length} categories
                  </p>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Tabs for different views */}
      <Tabs defaultValue="logs" className="space-y-4">
        <TabsList className="w-full sm:w-auto overflow-x-auto">
          <TabsTrigger value="logs">Recent Activity</TabsTrigger>
          <TabsTrigger value="transactions">Transactions</TabsTrigger>
          <TabsTrigger value="adjustments">Adjustments</TabsTrigger>
        </TabsList>

        <TabsContent value="logs" className="space-y-4">
          <SimpleInventoryLogTable logs={logs} />
        </TabsContent>

        <TabsContent value="transactions" className="space-y-4">
          <Card>
            <CardContent className="py-8">
              <p className="text-center text-muted-foreground">Transactions feature is not available with the current database schema.</p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="adjustments" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Stock Adjustment</CardTitle>
              <CardDescription>Manually adjust inventory levels</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="product">Product</Label>
                    <Select>
                      <SelectTrigger id="product">
                        <SelectValue placeholder="Select product" />
                      </SelectTrigger>
                      <SelectContent>
                        {products.map((product) => (
                          <SelectItem 
                            key={product.id} 
                            value={product.id.toString()}
                          >
                            {product.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div className="space-y-2">
                    <Label htmlFor="quantity">Quantity Change</Label>
                    <Input 
                      id="quantity" 
                      type="number" 
                      placeholder="Enter positive or negative number"
                    />
                  </div>
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="reason">Reason</Label>
                  <Input 
                    id="reason" 
                    placeholder="e.g., Damaged goods, Stock count correction"
                  />
                </div>
                
                <Button type="submit">Submit Adjustment</Button>
              </form>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Quick Adjust Dialog */}
      {selectedProduct && (
        <QuickAdjustDialog
          open={showQuickAdjust}
          onOpenChange={setShowQuickAdjust}
          product={selectedProduct}
          onSuccess={refreshData}
        />
      )}

      {/* Stock In Dialog */}
      {selectedProduct && (
        <StockInDialog
          open={showStockIn}
          onOpenChange={setShowStockIn}
          product={selectedProduct}
          onSuccess={refreshData}
        />
      )}
    </div>
  );
}
