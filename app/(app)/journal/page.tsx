"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Search, Filter, RotateCcw, Save, FileSpreadsheet, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { JournalProductRow } from "@/components/journal/journal-product-row";
import { ChangesSummary } from "@/components/journal/changes-summary";
import { ReviewChangesDialog } from "@/components/journal/review-changes-dialog";
import { JournalFilters } from "@/components/journal/journal-filters";
import { BatchOperationsDialog } from "@/components/journal/batch-operations-dialog";
import { useJournalStore } from "@/hooks/use-journal";
import { useLocation } from "@/contexts/location-context";
import type { ProductWithQuantity } from "@/types/product";
import { getUserFriendlyMessage, handleBatchOperationErrors } from "@/lib/error-handling";
import { useInventoryChangeAnnouncer } from "@/hooks/use-accessibility-announcer";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import { fetchWithErrorHandling } from "@/lib/rate-limited-fetch";

export default function JournalPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const { selectedLocationId } = useLocation();
  const { token: csrfToken } = useCSRF();
  const [products, setProducts] = useState<ProductWithQuantity[]>([]);
  const [filteredProducts, setFilteredProducts] = useState<ProductWithQuantity[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [showReviewDialog, setShowReviewDialog] = useState(false);
  const [showBatchOperations, setShowBatchOperations] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const { announceChange, announceBatchSubmission, announceSubmissionResult } = useInventoryChangeAnnouncer();

  const {
    adjustments,
    addAdjustment,
    removeAdjustment,
    clearAllAdjustments,
    getAdjustmentForProduct,
    hasChanges,
    getTotalChanges,
    loadFromLocalStorage,
    saveToLocalStorage,
  } = useJournalStore();

  // Load products when location changes
  useEffect(() => {
    if (status === "loading") return;
    if (!session) {
      router.push("/auth/signin");
      return;
    }

    if (selectedLocationId) {
      fetchProducts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, status, router, selectedLocationId]);

  // Load draft from localStorage on mount
  useEffect(() => {
    loadFromLocalStorage();
  }, [loadFromLocalStorage]);

  // Auto-save to localStorage when adjustments change
  useEffect(() => {
    if (hasChanges()) {
      saveToLocalStorage();
    }
  }, [adjustments, hasChanges, saveToLocalStorage]);

  // Filter products based on search term
  useEffect(() => {
    const filtered = products.filter((product) =>
      product.name.toLowerCase().includes(searchTerm.toLowerCase())
    );
    setFilteredProducts(filtered);
  }, [searchTerm, products]);

  const fetchProducts = async () => {
    if (!selectedLocationId) return;
    
    try {
      setIsLoading(true);
      
      // Fetch products and inventory data in parallel with automatic retry handling
      const [productsData, inventoryData] = await Promise.all([
        fetchWithErrorHandling<{ products: any[] }>(
          "/api/products?includeInactive=true"
        ),
        fetchWithErrorHandling<{ inventory: any[] }>(
          `/api/inventory/current-fast?locationId=${selectedLocationId}`
        ),
      ]);
      
      // Map inventory quantities and versions to products
      const inventoryMap = new Map(
        inventoryData.inventory.map((item: { productId: number; quantity: number; version?: number }) => 
          [item.productId, { quantity: item.quantity, version: item.version || 0 }]
        )
      );
      
      // Update products with current quantities and versions
      const productsWithQuantity = productsData.products.map((product: any) => {
        const inventoryInfo = inventoryMap.get(product.id) as { quantity: number; version: number } | undefined;
        return {
          ...product,
          currentQuantity: inventoryInfo?.quantity || 0,
          version: inventoryInfo?.version || 0,
        };
      });
      
      setProducts(productsWithQuantity);
      setFilteredProducts(productsWithQuantity);
    } catch (error) {
      console.error("Error fetching products:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to load products";
      toast.error(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const handleQuantityChange = (productId: number, change: number) => {
    console.log(`handleQuantityChange called: productId=${productId}, change=${change}`);
    
    const product = products.find(p => p.id === productId);
    if (!product) return;
    
    if (change === 0) {
      removeAdjustment(productId);
    } else {
      addAdjustment({
        productId,
        quantityChange: change,
        version: product?.version,
      });
      
      // Announce the change for screen readers
      const newQuantity = (product.currentQuantity || 0) + change;
      announceChange(product.name, change, newQuantity);
    }
    
    // Log current state after change
    console.log('Current adjustments:', adjustments);
    console.log('Total changes:', getTotalChanges());
  };

  const handleSubmitAdjustments = async () => {
    if (!selectedLocationId) {
      toast.error("No location selected");
      return;
    }

    console.log('Starting submission with adjustments:', adjustments);
    console.log('Total changes before submission:', getTotalChanges());

    setIsSubmitting(true);
    
    // Announce submission start
    const totalChanges = getTotalChanges();
    announceBatchSubmission(Object.keys(adjustments).length, totalChanges.total);
    
    try {
      // Prepare batch adjustment request
      const batchAdjustments = Object.values(adjustments).map(adjustment => ({
        productId: adjustment.productId,
        locationId: selectedLocationId,
        delta: adjustment.quantityChange,
        expectedVersion: adjustment.version,
      }));
      
      console.log('Batch adjustments to send:', batchAdjustments);
      
      // Check if we actually have adjustments to send
      if (batchAdjustments.length === 0) {
        console.error('No adjustments to send!');
        toast.error("No adjustments to save");
        setIsSubmitting(false);
        return;
      }

      // Submit all adjustments in a single transaction
      const response = await fetch("/api/inventory/batch-adjust", {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({
          adjustments: batchAdjustments,
          type: "JOURNAL_BATCH",
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        
        // Handle structured error response
        if (errorData.error && typeof errorData.error === 'object') {
          const { message, code, context } = errorData.error;
          
          // Handle optimistic lock errors specially
          if (code === 'OPTIMISTIC_LOCK_ERROR') {
            toast.error(
              <div className="space-y-2">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="font-medium">Inventory Conflict</p>
                    <p className="text-sm">{message}</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      The page will refresh to show the latest inventory levels.
                    </p>
                  </div>
                </div>
              </div>,
              { duration: 6000 }
            );
            // Automatically refresh after a short delay
            setTimeout(() => {
              fetchProducts();
            }, 1000);
            return;
          }
          
          // Handle batch operation errors
          if (code === 'BATCH_OPERATION_PARTIAL_FAILURE' && context?.results) {
            const { successful, failed, summary } = handleBatchOperationErrors(
              context.results,
              "Journal Adjustments"
            );
            
            toast.error(
              <div className="space-y-2">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="font-medium">Partial Success</p>
                    <p className="text-sm">{summary}</p>
                    {failed.length > 0 && (
                      <ul className="text-sm mt-2 space-y-1">
                        {failed.slice(0, 3).map((f, i) => (
                          <li key={i} className="text-muted-foreground">
                            • {f.error?.message || 'Unknown error'}
                          </li>
                        ))}
                        {failed.length > 3 && (
                          <li className="text-muted-foreground">
                            • And {failed.length - 3} more errors...
                          </li>
                        )}
                      </ul>
                    )}
                  </div>
                </div>
              </div>,
              { duration: 8000 }
            );
            
            // Refresh to show what succeeded
            if (successful.length > 0) {
              clearAllAdjustments();
              fetchProducts();
              setShowReviewDialog(false);
            }
            return;
          }
          
          // Create a proper error object
          const error = new Error(message);
          (error as any).code = code;
          (error as any).context = context;
          
          throw error;
        } else {
          throw new Error(errorData.error || "Failed to submit adjustments");
        }
      }

      const result = await response.json();
      
      toast.success(`Successfully submitted ${result.logs.length} adjustments`);
      announceSubmissionResult(true, `${result.logs.length} adjustments were applied successfully.`);
      clearAllAdjustments();
      fetchProducts(); // Refresh quantities and versions
      setShowReviewDialog(false);
    } catch (error) {
      console.error("Error submitting adjustments:", error);
      
      // Generate user-friendly error message
      const friendlyError = getUserFriendlyMessage(error as Error);
      announceSubmissionResult(false, friendlyError.description);
      
      toast.error(
        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">{friendlyError.title}</p>
              <p className="text-sm">{friendlyError.description}</p>
              {friendlyError.action && (
                <p className="text-sm text-muted-foreground">{friendlyError.action}</p>
              )}
            </div>
          </div>
        </div>,
        {
          duration: 5000,
        }
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const totalChanges = getTotalChanges();
  
  // Debug: log the current state
  useEffect(() => {
    console.log('Journal page - adjustments updated:', adjustments);
    console.log('Journal page - hasChanges:', hasChanges());
    console.log('Journal page - totalChanges:', totalChanges);
  }, [adjustments, hasChanges, totalChanges]);

  return (
    <div className="container mx-auto px-4 py-6 max-w-7xl">
      <a href="#products-heading" className="skip-link">
        Skip to products list
      </a>
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2" id="page-title">Inventory Journal</h1>
        <p className="text-muted-foreground" id="page-description">
          Make bulk inventory adjustments across multiple products
        </p>
      </div>


      {/* Summary Card */}
      {hasChanges() && (
        <ChangesSummary
          totalChanges={totalChanges}
          adjustmentCount={Object.keys(adjustments).length}
          onReview={() => setShowReviewDialog(true)}
          onClear={clearAllAdjustments}
        />
      )}

      {/* Search and Filters */}
      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                placeholder="Search products..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
                aria-label="Search products"
                aria-describedby="search-description"
                role="searchbox"
              />
              <span className="sr-only" id="search-description">
                Type to filter products by name
              </span>
            </div>
            <Button
              variant="outline"
              onClick={() => setShowFilters(!showFilters)}
              className="gap-2"
              aria-label="Toggle filters"
              aria-expanded={showFilters}
              aria-controls="journal-filters"
            >
              <Filter className="h-4 w-4" aria-hidden="true" />
              Filters
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowBatchOperations(true)}
              className="gap-2"
              aria-label="Open batch operations dialog"
            >
              <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
              Batch
            </Button>
          </div>
          
          {showFilters && (
            <div className="mt-4" id="journal-filters" role="region" aria-label="Product filters">
              <JournalFilters 
                onFilterChange={(filters) => {
                  // Implement filter logic here
                  console.log("Filters:", filters);
                }}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Products List */}
      <Card>
        <CardHeader>
          <CardTitle id="products-heading">Products</CardTitle>
        </CardHeader>
        <CardContent role="main" aria-labelledby="products-heading">
          <ScrollArea className="h-[600px]" aria-label="Products list">
            <div className="space-y-2" role="list" aria-live="polite" aria-relevant="additions removals">
              {isLoading ? (
                <div className="text-center py-8 text-muted-foreground" role="status" aria-live="polite">
                  <span aria-label="Loading products">Loading products...</span>
                </div>
              ) : filteredProducts.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground" role="status" aria-live="polite">
                  <span>No products found</span>
                </div>
              ) : (
                filteredProducts.map((product, index) => (
                  <div key={product.id} role="listitem">
                    <JournalProductRow
                      product={product}
                      adjustment={getAdjustmentForProduct(product.id)}
                      onQuantityChange={(change) => 
                        handleQuantityChange(product.id, change)
                      }
                      index={index}
                    />
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Fixed Action Bar */}
      {hasChanges() && (
        <div className="fixed bottom-0 left-0 right-0 bg-background border-t p-4" role="region" aria-label="Action bar" aria-live="polite">
          <div className="container mx-auto max-w-7xl flex justify-between items-center">
            <div className="flex items-center gap-4">
              <Badge 
                variant={totalChanges.total > 0 ? "default" : "destructive"}
                role="status"
                aria-label={`Total change: ${totalChanges.total > 0 ? "+" : ""}${totalChanges.total} units`}
              >
                Total: {totalChanges.total > 0 ? "+" : ""}{totalChanges.total}
              </Badge>
              <span className="text-sm text-muted-foreground" role="status">
                {Object.keys(adjustments).length} products affected
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={clearAllAdjustments}
                className="gap-2"
                aria-label="Reset all adjustments"
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                Reset
              </Button>
              <Button
                onClick={() => setShowReviewDialog(true)}
                className="gap-2"
                aria-label={`Review ${Object.keys(adjustments).length} changes`}
              >
                <Save className="h-4 w-4" aria-hidden="true" />
                Review Changes
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Review Changes Dialog */}
      <ReviewChangesDialog
        open={showReviewDialog}
        onOpenChange={setShowReviewDialog}
        adjustments={adjustments}
        products={products}
        onConfirm={handleSubmitAdjustments}
        isSubmitting={isSubmitting}
      />

      {/* Batch Operations Dialog */}
      <BatchOperationsDialog
        open={showBatchOperations}
        onOpenChange={setShowBatchOperations}
      />
    </div>
  );
}