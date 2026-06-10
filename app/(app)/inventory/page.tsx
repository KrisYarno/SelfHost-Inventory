"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { SimpleInventoryLogTable } from "@/components/inventory/simple-inventory-log-table";
import { TransferDialog } from "@/components/inventory/transfer-dialog";
import { TransferLogTable } from "@/components/inventory/transfer-log-table";
import { VariantProductCard } from "@/components/inventory/variant-product-card";
import { QuickAdjustDialog } from "@/components/inventory/quick-adjust-dialog";
import { StockInDialog } from "@/components/inventory/stock-in-dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { BookOpen, Loader2, RefreshCw, Download, Package } from "lucide-react";
import { toast } from "sonner";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
import { useInventoryVariants, groupByBaseName } from "@/hooks/use-inventory-variants";
import { useInventoryLogs, useInventoryTransfers } from "@/hooks/use-inventory-activity";
import { getJSON, setJSON } from "@/lib/safe-storage";
import { shouldAutoLoad, AUTO_LOAD_PAGE_LIMIT } from "@/lib/inventory-page-utils";
import type { DialogProduct } from "@/types/inventory";

// Lazy-mounted tab panes (design A5): each fetches only once its tab mounts.
function LogsTabContent() {
  const logsQuery = useInventoryLogs();
  return <SimpleInventoryLogTable logs={logsQuery.data ?? []} />;
}

function TransfersTabContent() {
  const transfersQuery = useInventoryTransfers();
  return <TransferLogTable logs={transfersQuery.data ?? []} />;
}

export default function InventoryPage() {
  const queryClient = useQueryClient();

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<DialogProduct | null>(null);
  const [showQuickAdjust, setShowQuickAdjust] = useState(false);
  const [showStockIn, setShowStockIn] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [autoLoadLimit, setAutoLoadLimit] = useState(AUTO_LOAD_PAGE_LIMIT);
  // Init empty for hydration safety; restored from localStorage after mount.
  const [expandedCategories, setExpandedCategories] = useState<string[]>([]);

  useEffect(() => {
    const saved = getJSON<string[]>("inventory-expanded-categories", []);
    setExpandedCategories(Array.isArray(saved) ? saved : []);
  }, []);

  const variants = useInventoryVariants(searchQuery);
  const variantsData = variants.data;
  const products = useMemo(() => variantsData?.products ?? [], [variantsData]);
  const total = variants.data?.total ?? 0;
  const pagesLoaded = variants.data?.pagesLoaded ?? 0;
  const remaining = Math.max(0, total - products.length);

  const groupedProducts = useMemo(() => groupByBaseName(products), [products]);
  const allCategories = useMemo(() => Object.keys(groupedProducts), [groupedProducts]);

  // Single guarded path: update state + persist expanded categories
  const persistExpanded = (next: string[]) => {
    setExpandedCategories(next);
    setJSON("inventory-expanded-categories", next);
  };

  const handleAccordionChange = (value: string | string[]) => {
    persistExpanded(Array.isArray(value) ? value : [value]);
  };

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    setAutoLoadLimit(AUTO_LOAD_PAGE_LIMIT);
  };

  const { loadMoreRef } = useInfiniteScroll({
    loading: variants.isFetchingNextPage,
    hasMore: shouldAutoLoad(pagesLoaded, !!variants.hasNextPage, autoLoadLimit),
    onLoadMore: () => variants.fetchNextPage(),
  });

  const handleLoadMore = () => {
    setAutoLoadLimit((l) => l + AUTO_LOAD_PAGE_LIMIT);
    variants.fetchNextPage();
  };

  const isRefreshing = variants.isRefetching;
  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["inventory-variants"] });
    queryClient.invalidateQueries({ queryKey: ["inventory-logs"] });
    queryClient.invalidateQueries({ queryKey: ["inventory-transfers"] });
  };

  const handleProductAction = (productId: number, action: "adjust" | "stockIn" | "transfer") => {
    const product = products.find((p) => p.id === productId);
    if (!product) return;

    setSelectedProduct({ id: product.id, name: product.name });
    if (action === "adjust") {
      setShowQuickAdjust(true);
    } else if (action === "stockIn") {
      setShowStockIn(true);
    } else if (action === "transfer") {
      setShowTransfer(true);
    }
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
      a.download = `inventory-${new Date().toISOString().split("T")[0]}.csv`;
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
      <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Inventory Management</h1>
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
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Current Inventory Levels */}
      <Card>
        <CardHeader>
          <CardTitle>Current Stock Levels</CardTitle>
          <CardDescription>
            Real-time inventory quantities across all products and locations
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Search Bar and Controls */}
          <div className="mb-6 space-y-4">
            <div className="flex flex-col sm:flex-row gap-4">
              <Input
                type="search"
                placeholder="Search products..."
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="max-w-sm"
              />
              {products.length > 0 && (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => persistExpanded(allCategories)}
                    className="whitespace-nowrap"
                  >
                    Expand All
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => persistExpanded([])}
                    className="whitespace-nowrap"
                  >
                    Collapse All
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Loading State */}
          {variants.isLoading ? (
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
          ) : variants.isError ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-8 text-center">
              <p className="text-sm text-destructive">Could not load inventory.</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => variants.refetch()}
                className="mt-3"
              >
                Retry
              </Button>
            </div>
          ) : products.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground">
                {searchQuery
                  ? "No products found matching your search."
                  : "No products found in inventory."}
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
                          <span className="text-sm sm:text-base font-semibold truncate">
                            {category}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-xs sm:text-sm">
                          <Badge variant="secondary" className="font-normal px-2 py-0.5">
                            {categoryProducts.length}{" "}
                            {categoryProducts.length === 1 ? "variant" : "variants"}
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
                            onStockIn={(id) => handleProductAction(id, "stockIn")}
                            onAdjust={(id) => handleProductAction(id, "adjust")}
                            onTransfer={(id) => handleProductAction(id, "transfer")}
                          />
                        ))}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>

              {/* Load More Trigger */}
              <div ref={loadMoreRef} className="h-20 flex items-center justify-center">
                {variants.isFetchingNextPage ? (
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-sm text-muted-foreground">Loading more...</span>
                  </div>
                ) : variants.hasNextPage && !shouldAutoLoad(pagesLoaded, true, autoLoadLimit) ? (
                  <Button variant="outline" size="sm" onClick={handleLoadMore}>
                    Load more ({remaining} remaining)
                  </Button>
                ) : products.length > 0 && !variants.hasNextPage && !variants.isPlaceholderData ? (
                  <p className="text-sm text-muted-foreground">
                    Showing all {total} products in {allCategories.length} categories
                  </p>
                ) : null}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Tabs for different views */}
      <Tabs defaultValue="logs" className="space-y-4">
        <TabsList className="w-full sm:w-auto overflow-x-auto">
          <TabsTrigger value="logs">Recent Activity</TabsTrigger>
          <TabsTrigger value="transfers">Transfers</TabsTrigger>
        </TabsList>

        <TabsContent value="logs" className="space-y-4">
          <LogsTabContent />
        </TabsContent>

        <TabsContent value="transfers" className="space-y-4">
          <TransfersTabContent />
        </TabsContent>
      </Tabs>

      {/* Quick Adjust Dialog */}
      {selectedProduct && (
        <QuickAdjustDialog
          open={showQuickAdjust}
          onOpenChange={setShowQuickAdjust}
          product={selectedProduct}
        />
      )}

      {/* Stock In Dialog */}
      {selectedProduct && (
        <StockInDialog open={showStockIn} onOpenChange={setShowStockIn} product={selectedProduct} />
      )}

      {/* Transfer Dialog */}
      {selectedProduct && (
        <TransferDialog
          open={showTransfer}
          onOpenChange={setShowTransfer}
          product={selectedProduct}
        />
      )}
    </div>
  );
}
