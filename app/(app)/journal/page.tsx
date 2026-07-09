"use client";

import { useState, useEffect, useMemo } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Search,
  Filter,
  RotateCcw,
  Save,
  AlertCircle,
  MapPin,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ValueChip } from "@/components/ui/value-chip";
import { JournalProductRow } from "@/components/journal/journal-product-row";
import { ReviewChangesDialog } from "@/components/journal/review-changes-dialog";
import { JournalFilters } from "@/components/journal/journal-filters";
import type { JournalFilters as JournalFilterState } from "@/components/journal/journal-filters";
import { useQueryClient } from "@tanstack/react-query";
import { useJournalStore } from "@/hooks/use-journal";
import { useInventoryProducts } from "@/hooks/use-inventory-products";
import { invalidateInventoryCaches } from "@/hooks/use-inventory-mutations";
import { useLocation } from "@/contexts/location-context";
import { getUserFriendlyMessage, handleBatchOperationErrors } from "@/lib/error-handling";
import { useInventoryChangeAnnouncer } from "@/hooks/use-accessibility-announcer";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import { ContextTag } from "@/components/ui/context-tag";
import { PageHeader } from "@/components/layout/page-header";

export default function JournalPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const { selectedLocationId, locations } = useLocation();
  const { token: csrfToken } = useCSRF();
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [showReviewDialog, setShowReviewDialog] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [filters, setFilters] = useState<JournalFilterState>({
    showWithChanges: true,
    showWithoutChanges: true,
    stockLevel: "all",
    sortBy: "name",
  });

  const { announceChange, announceBatchSubmission, announceSubmissionResult } =
    useInventoryChangeAnnouncer();

  const {
    adjustments,
    addAdjustment,
    removeAdjustment,
    clearAllAdjustments,
    getAdjustmentForProduct,
    hasChanges,
    getTotalChanges,
  } = useJournalStore();

  const { data: products = [], isLoading, refetch: refetchProducts } = useInventoryProducts({
    locationId: selectedLocationId,
  });

  // Redirect unauthenticated users
  useEffect(() => {
    if (status === "loading") return;
    if (!session) {
      router.push("/auth/signin");
    }
  }, [session, status, router]);

  // Filter + sort products based on the search term and the advanced filter panel.
  // Product Status (active/inactive) filters were dropped from the panel: the
  // journal's data source has no active/inactive concept (soft-deleted products
  // are already excluded server-side), so filtering on it would be inventing
  // state. Everything below is computed from data already on the client.
  const filteredProducts = useMemo(() => {
    let result = products;

    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter((product) => product.name.toLowerCase().includes(term));
    }

    // Change status — has a pending adjustment in the journal store, or not.
    const hasChange = (id: number) => Boolean(adjustments[id]);
    if (!filters.showWithChanges) {
      result = result.filter((product) => !hasChange(product.id));
    }
    if (!filters.showWithoutChanges) {
      result = result.filter((product) => hasChange(product.id));
    }

    // Stock level — derived from current quantity vs. the product's threshold.
    if (filters.stockLevel !== "all") {
      result = result.filter((product) => {
        const qty = product.currentQuantity ?? 0;
        const threshold = product.lowStockThreshold ?? 0;
        switch (filters.stockLevel) {
          case "out":
            return qty <= 0;
          case "low":
            return qty > 0 && threshold > 0 && qty <= threshold;
          case "normal":
            return threshold > 0 ? qty > threshold : qty > 0;
          default:
            return true;
        }
      });
    }

    // Sort — name is the server default; quantity surfaces low stock first;
    // changes surfaces the largest pending adjustment first.
    const sorted = [...result];
    if (filters.sortBy === "quantity") {
      sorted.sort((a, b) => (a.currentQuantity ?? 0) - (b.currentQuantity ?? 0));
    } else if (filters.sortBy === "changes") {
      sorted.sort(
        (a, b) =>
          Math.abs(adjustments[b.id]?.quantityChange ?? 0) -
          Math.abs(adjustments[a.id]?.quantityChange ?? 0)
      );
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    }

    return sorted;
  }, [searchTerm, products, filters, adjustments]);

  const handleQuantityChange = (productId: number, change: number) => {
    const product = products.find((p) => p.id === productId);
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

  };

  const handleSubmitAdjustments = async () => {
    if (!selectedLocationId) {
      toast.error("No location selected");
      return;
    }

    setIsSubmitting(true);

    // Announce submission start
    const totalChanges = getTotalChanges();
    announceBatchSubmission(Object.keys(adjustments).length, totalChanges.total);

    try {
      // Prepare batch adjustment request
      const batchAdjustments = Object.values(adjustments).map((adjustment) => ({
        productId: adjustment.productId,
        locationId: selectedLocationId,
        delta: adjustment.quantityChange,
        expectedVersion: adjustment.version,
      }));

      // Check if we actually have adjustments to send
      if (batchAdjustments.length === 0) {
        console.error("No adjustments to send!");
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

        // apiHandler returns flat 409 bodies ({ error: string, code: "OPTIMISTIC_LOCK_ERROR" });
        // normalize to the nested shape so the conflict toast + auto-refresh below fire.
        if (errorData.code === "OPTIMISTIC_LOCK_ERROR" && typeof errorData.error === "string") {
          errorData.error = { message: errorData.error, code: errorData.code };
        }

        // Handle structured error response
        if (errorData.error && typeof errorData.error === "object") {
          const { message, code, context } = errorData.error;

          // Handle optimistic lock errors specially
          if (code === "OPTIMISTIC_LOCK_ERROR") {
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
              refetchProducts();
            }, 1000);
            return;
          }

          // Handle batch operation errors
          if (code === "BATCH_OPERATION_PARTIAL_FAILURE" && context?.results) {
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
                            • {f.error?.message || "Unknown error"}
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
              refetchProducts();
              // Partial success still mutated inventory; keep other pages coherent.
              invalidateInventoryCaches(queryClient);
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
      announceSubmissionResult(
        true,
        `${result.logs.length} adjustments were applied successfully.`
      );
      clearAllAdjustments();
      refetchProducts(); // Refresh quantities and versions
      // Cross-page coherence: /inventory + dashboard read different query keys
      // than this page; without this they serve up-to-5-min-stale quantities.
      invalidateInventoryCaches(queryClient);
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
  const selectedLocationName =
    locations.find((loc) => loc.id === selectedLocationId)?.name ?? "Select a location";

  const hasAnyChanges = hasChanges();

  return (
    <div className={`container mx-auto px-4 py-6 max-w-7xl ${hasAnyChanges ? "pb-32" : "pb-10"}`}>
      <a href="#products-heading" className="skip-link">
        Skip to products list
      </a>
      <PageHeader
        title="Inventory Journal"
        description="Make bulk inventory adjustments across multiple products"
        sticky
        className="mb-4 sm:mb-6 -mx-4 -mt-6 sm:-mx-4"
      >
        <ContextTag icon={<MapPin className="h-3 w-3 text-muted-foreground" />}>
          {selectedLocationName}
        </ContextTag>
      </PageHeader>

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
              size="icon"
              onClick={() => setShowFilters(!showFilters)}
              className="sm:hidden flex-shrink-0"
              aria-label="Toggle filters"
              aria-expanded={showFilters}
              aria-controls="journal-filters"
            >
              <Filter className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowFilters(!showFilters)}
              className="hidden sm:flex gap-2"
              aria-label="Toggle filters"
              aria-expanded={showFilters}
              aria-controls="journal-filters"
            >
              <Filter className="h-4 w-4" aria-hidden="true" />
              Filters
            </Button>
          </div>

          {showFilters && (
            <div className="mt-4" id="journal-filters" role="region" aria-label="Product filters">
              <JournalFilters onFilterChange={setFilters} />
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
          <ScrollArea className="h-[calc(100dvh-26rem)] sm:h-[600px]" aria-label="Products list">
            <div
              className="space-y-2 pr-3 sm:pr-0"
              role="list"
              aria-live="polite"
              aria-relevant="additions removals"
            >
              {isLoading ? (
                <div
                  className="text-center py-8 text-muted-foreground"
                  role="status"
                  aria-live="polite"
                >
                  <span aria-label="Loading products">Loading products...</span>
                </div>
              ) : filteredProducts.length === 0 ? (
                <div
                  className="text-center py-8 text-muted-foreground"
                  role="status"
                  aria-live="polite"
                >
                  <span>No products found</span>
                </div>
              ) : (
                filteredProducts.map((product) => (
                  <div key={product.id} role="listitem">
                    <JournalProductRow
                      product={product}
                      adjustment={getAdjustmentForProduct(product.id)}
                      onQuantityChange={(change) => handleQuantityChange(product.id, change)}
                    />
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Fixed Action Bar */}
      {hasAnyChanges && (
        <div
          className="fixed left-0 right-0 md:left-64 bg-surface border-t-2 border-primary shadow-lg z-30 bottom-[4.75rem] md:bottom-0"
          role="region"
          aria-label="Pending changes summary"
          aria-live="polite"
        >
          <div className="container mx-auto max-w-7xl px-4 py-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              {/* Summary chips */}
              <div className="flex items-center gap-3 flex-wrap">
                <Badge variant="outline" className="font-mono tabular-nums">
                  {Object.keys(adjustments).length} products
                </Badge>
                {totalChanges.additions > 0 && (
                  <ValueChip tone="positive" className="gap-1">
                    <TrendingUp className="h-3 w-3" />
                    +{totalChanges.additions}
                  </ValueChip>
                )}
                {totalChanges.removals > 0 && (
                  <ValueChip tone="negative" className="gap-1">
                    <TrendingDown className="h-3 w-3" />
                    -{totalChanges.removals}
                  </ValueChip>
                )}
                <ValueChip
                  tone={totalChanges.total > 0 ? "positive" : totalChanges.total < 0 ? "negative" : "neutral"}
                  className="font-semibold"
                >
                  Net: {totalChanges.total > 0 ? "+" : ""}{totalChanges.total}
                </ValueChip>
              </div>

              {/* Actions */}
              <div className="flex gap-2 flex-shrink-0">
                <Button variant="ghost" size="sm" onClick={clearAllAdjustments}>
                  <RotateCcw className="h-4 w-4 mr-1" />
                  Reset
                </Button>
                <Button size="sm" onClick={() => setShowReviewDialog(true)}>
                  <Save className="h-4 w-4 mr-1" />
                  Review & Submit
                </Button>
              </div>
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
    </div>
  );
}
