"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Search, Filter, RotateCcw, Save, FileSpreadsheet } from "lucide-react";
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

export default function JournalPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const { selectedLocationId } = useLocation();
  const [products, setProducts] = useState<ProductWithQuantity[]>([]);
  const [filteredProducts, setFilteredProducts] = useState<ProductWithQuantity[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [showReviewDialog, setShowReviewDialog] = useState(false);
  const [showBatchOperations, setShowBatchOperations] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

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
      
      // First get all products
      const productsResponse = await fetch("/api/products?includeInactive=true");
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
      setFilteredProducts(productsWithQuantity);
    } catch (error) {
      console.error("Error fetching products:", error);
      toast.error("Failed to load products");
    } finally {
      setIsLoading(false);
    }
  };

  const handleQuantityChange = (productId: number, change: number, notes?: string) => {
    if (change === 0) {
      removeAdjustment(productId);
    } else {
      addAdjustment({
        productId,
        quantityChange: change,
        notes,
      });
    }
  };

  const handleSubmitAdjustments = async () => {
    if (!selectedLocationId) {
      toast.error("No location selected");
      return;
    }

    setIsSubmitting(true);
    
    try {
      const adjustmentPromises = Object.values(adjustments).map(async (adjustment) => {
        const response = await fetch("/api/inventory/adjust", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            productId: adjustment.productId,
            locationId: selectedLocationId,
            delta: adjustment.quantityChange,
            notes: adjustment.notes,
          }),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || "Failed to submit adjustment");
        }

        return response.json();
      });

      await Promise.all(adjustmentPromises);
      
      toast.success("All adjustments submitted successfully");
      clearAllAdjustments();
      fetchProducts(); // Refresh quantities
      setShowReviewDialog(false);
    } catch (error) {
      console.error("Error submitting adjustments:", error);
      toast.error(error instanceof Error ? error.message : "Failed to submit adjustments");
    } finally {
      setIsSubmitting(false);
    }
  };

  const totalChanges = getTotalChanges();

  return (
    <div className="container mx-auto px-4 py-6 max-w-7xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">Inventory Journal</h1>
        <p className="text-muted-foreground">
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
              />
            </div>
            <Button
              variant="outline"
              onClick={() => setShowFilters(!showFilters)}
              className="gap-2"
            >
              <Filter className="h-4 w-4" />
              Filters
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowBatchOperations(true)}
              className="gap-2"
            >
              <FileSpreadsheet className="h-4 w-4" />
              Batch
            </Button>
          </div>
          
          {showFilters && (
            <div className="mt-4">
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
          <CardTitle>Products</CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[600px]">
            <div className="space-y-2">
              {isLoading ? (
                <div className="text-center py-8 text-muted-foreground">
                  Loading products...
                </div>
              ) : filteredProducts.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No products found
                </div>
              ) : (
                filteredProducts.map((product) => (
                  <JournalProductRow
                    key={product.id}
                    product={product}
                    adjustment={getAdjustmentForProduct(product.id)}
                    onQuantityChange={(change, notes) => 
                      handleQuantityChange(product.id, change, notes)
                    }
                  />
                ))
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Fixed Action Bar */}
      {hasChanges() && (
        <div className="fixed bottom-0 left-0 right-0 bg-background border-t p-4">
          <div className="container mx-auto max-w-7xl flex justify-between items-center">
            <div className="flex items-center gap-4">
              <Badge variant={totalChanges.total > 0 ? "default" : "destructive"}>
                Total: {totalChanges.total > 0 ? "+" : ""}{totalChanges.total}
              </Badge>
              <span className="text-sm text-muted-foreground">
                {Object.keys(adjustments).length} products affected
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={clearAllAdjustments}
                className="gap-2"
              >
                <RotateCcw className="h-4 w-4" />
                Reset
              </Button>
              <Button
                onClick={() => setShowReviewDialog(true)}
                className="gap-2"
              >
                <Save className="h-4 w-4" />
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