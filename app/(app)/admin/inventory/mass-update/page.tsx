"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { 
  Save, 
  RotateCcw, 
  AlertTriangle,
  Download,
  Upload,
  Search,
  Check,
  X,
  Shield,
  RefreshCw
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import { 
  BatchUpdateResult, 
  FailedUpdate, 
  MassUpdateChange 
} from "@/types/mass-update-errors";
import { recoveryManager } from "@/lib/mass-update-recovery";
import { MassUpdateRecoveryDialog } from "@/components/admin/mass-update-recovery-dialog";

interface ProductInventory {
  productId: number;
  productName: string;
  baseName: string;
  variant: string | null;
  locations: {
    locationId: number;
    locationName: string;
    currentQuantity: number;
    newQuantity: number | null;
    delta: number;
    hasChanged: boolean;
  }[];
}

interface MassUpdateData {
  products: ProductInventory[];
  locations: Array<{ id: number; name: string }>;
  totalProducts: number;
  totalChanges: number;
}

export default function AdminMassInventoryUpdatePage() {
  const [data, setData] = useState<MassUpdateData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategory] = useState<string>("all");
  const [showChangedOnly, setShowChangedOnly] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [fetchController, setFetchController] = useState<AbortController | null>(null);
  const [allowPartialUpdates, setAllowPartialUpdates] = useState(true);
  const [showRecoveryDialog, setShowRecoveryDialog] = useState(false);
  const [lastFailures, setLastFailures] = useState<FailedUpdate[]>([]);
  const [isRetrying, setIsRetrying] = useState(false);
  const { token: csrfToken, isLoading: csrfLoading, error: csrfError, refreshToken: refreshCSRFToken } = useCSRF();

  // Fetch all data once on mount with request deduplication
  const fetchInventoryData = useCallback(async () => {
    // Cancel any in-flight requests
    if (fetchController) {
      fetchController.abort();
    }

    const controller = new AbortController();
    setFetchController(controller);

    try {
      setIsLoading(true);
      // Fetch all products without any filters
      const response = await fetch(`/api/admin/inventory/mass-update`, {
        signal: controller.signal
      });
      if (!response.ok) throw new Error("Failed to fetch inventory data");
      
      const result = await response.json();
      setData(result);
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        console.error('Error fetching inventory:', error);
        toast.error('Failed to load inventory data');
      }
    } finally {
      setIsLoading(false);
      setFetchController(null);
    }
  }, [fetchController]);

  // Only fetch once on mount and check for recovery state
  useEffect(() => {
    let mounted = true;
    
    if (mounted) {
      fetchInventoryData();
      
      // Check for recovery state
      if (recoveryManager.hasRecoverableFailures()) {
        const state = recoveryManager.getRecoveryState();
        if (state) {
          setLastFailures(state.failedUpdates);
          toast.warning(`${state.failedUpdates.length} updates from your last session failed. You can retry them.`, {
            duration: 7000,
            action: {
              label: "Review",
              onClick: () => setShowRecoveryDialog(true)
            }
          });
        }
      }
    }

    return () => {
      mounted = false;
      if (fetchController) {
        fetchController.abort();
      }
    };
  }, []);

  // Handle quantity change
  const handleQuantityChange = (productId: number, locationId: number, value: string) => {
    if (!data) return;

    const newQuantity = value === "" ? null : parseInt(value);
    console.log('Quantity changed', { productId, locationId, value, newQuantity });
    
    setData(prevData => {
      if (!prevData) return null;
      
      const updatedProducts = prevData.products.map(product => {
        if (product.productId !== productId) return product;
        
        const updatedLocations = product.locations.map(location => {
          if (location.locationId !== locationId) return location;
          
          const delta = newQuantity === null ? 0 : newQuantity - location.currentQuantity;
          
          return {
            ...location,
            newQuantity,
            delta,
            hasChanged: newQuantity !== null && newQuantity !== location.currentQuantity
          };
        });
        
        return {
          ...product,
          locations: updatedLocations
        };
      });
      
      // Calculate total changes
      const totalChanges = updatedProducts.reduce((sum, product) => 
        sum + product.locations.filter(loc => loc.hasChanged).length, 0
      );
      
      console.log('Total changes calculated:', totalChanges);
      
      return {
        ...prevData,
        products: updatedProducts,
        totalChanges
      };
    });
    
    setHasUnsavedChanges(true);
  };

  // Save all changes with error recovery
  const handleSaveAll = async (isRetry = false, retryChanges?: MassUpdateChange[]) => {
    console.log('handleSaveAll called', { isRetry, data, totalChanges: data?.totalChanges });
    
    if (!isRetry && (!data || data.totalChanges === 0)) return;
    if (isRetry && (!retryChanges || retryChanges.length === 0)) return;

    // Check for CSRF token
    if (!csrfToken && !csrfLoading) {
      console.error('CSRF token not available', { csrfToken, csrfLoading, csrfError });
      toast.error('Security token not available. Please refresh the page.');
      return;
    }

    if (!isRetry) {
      const confirmMessage = allowPartialUpdates
        ? `You are about to update ${data!.totalChanges} inventory quantities. If some updates fail, successful ones will be saved. Continue?`
        : `You are about to update ${data!.totalChanges} inventory quantities. All updates must succeed or none will be saved. Continue?`;
      
      if (!confirm(confirmMessage)) return;
    }

    setIsSaving(true);
    if (isRetry) setIsRetrying(true);
    
    try {
      // Collect all changes
      const changes: MassUpdateChange[] = isRetry ? retryChanges! : data!.products.flatMap(product => 
        product.locations
          .filter(loc => loc.hasChanged)
          .map(loc => ({
            productId: product.productId,
            locationId: loc.locationId,
            newQuantity: loc.newQuantity!,
            delta: loc.delta,
            productName: product.productName,
            locationName: loc.locationName
          }))
      );

      const response = await fetch('/api/admin/inventory/mass-update', {
        method: 'POST',
        headers: withCSRFHeaders({ 'Content-Type': 'application/json' }, csrfToken),
        body: JSON.stringify({ 
          changes,
          note: `Mass inventory update - ${new Date().toLocaleString()}`,
          allowPartial: allowPartialUpdates,
          isRetry
        })
      });

      const result: BatchUpdateResult = await response.json();

      if (!response.ok && response.status === 403) {
        // If CSRF token is invalid, try refreshing it once
        await refreshCSRFToken();
        toast.error('Security token expired. Please try saving again.');
        return;
      }

      // Handle the result
      if (result.successful > 0) {
        toast.success(`Successfully updated ${result.successful} inventory quantities`);
        
        if (!isRetry) {
          setHasUnsavedChanges(false);
          
          // Update local data to reflect saved changes
          setData(prevData => {
            if (!prevData) return null;
            
            // Create a set of successfully updated items
            const successfulUpdates = new Set(
              changes
                .filter(change => !result.failures.find(f => 
                  f.productId === change.productId && f.locationId === change.locationId
                ))
                .map(c => `${c.productId}-${c.locationId}`)
            );
            
            return {
              ...prevData,
              products: prevData.products.map(product => ({
                ...product,
                locations: product.locations.map(location => {
                  const key = `${product.productId}-${location.locationId}`;
                  const wasSuccessful = successfulUpdates.has(key);
                  
                  return {
                    ...location,
                    currentQuantity: wasSuccessful && location.newQuantity !== null 
                      ? location.newQuantity 
                      : location.currentQuantity,
                    newQuantity: wasSuccessful ? null : location.newQuantity,
                    delta: wasSuccessful ? 0 : location.delta,
                    hasChanged: !wasSuccessful && location.hasChanged
                  };
                })
              })),
              totalChanges: prevData.products.reduce((sum, product) => 
                sum + product.locations.filter(loc => loc.hasChanged).length, 0
              )
            };
          });
        }
      }

      // Handle failures
      if (result.failed > 0) {
        setLastFailures(result.failures);
        recoveryManager.saveFailedUpdates(result.failures);
        
        if (result.partial) {
          toast.warning(`Partial success: ${result.successful} updated, ${result.failed} failed.`, {
            duration: 10000,
            action: {
              label: "Review Failures",
              onClick: () => setShowRecoveryDialog(true)
            }
          });
        } else {
          toast.error(`All ${result.failed} updates failed.`, {
            duration: 10000,
            action: {
              label: "Review Failures",
              onClick: () => setShowRecoveryDialog(true)
            }
          });
        }
        
        setShowRecoveryDialog(true);
      } else if (isRetry) {
        // All retries successful, clear recovery state
        recoveryManager.clearRecoveryState();
        setLastFailures([]);
      }
      
    } catch (error) {
      console.error('Error saving changes:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to save changes');
    } finally {
      setIsSaving(false);
      setIsRetrying(false);
    }
  };

  // Reset all changes
  const handleReset = () => {
    if (!hasUnsavedChanges) return;
    
    if (confirm('Reset all changes? This will discard any unsaved modifications.')) {
      // Reset local data instead of refetching
      setData(prevData => {
        if (!prevData) return null;
        
        return {
          ...prevData,
          products: prevData.products.map(product => ({
            ...product,
            locations: product.locations.map(location => ({
              ...location,
              newQuantity: null,
              delta: 0,
              hasChanged: false
            }))
          })),
          totalChanges: 0
        };
      });
      setHasUnsavedChanges(false);
    }
  };

  // Handle retry of failed updates
  const handleRetryFailures = (failuresToRetry: FailedUpdate[]) => {
    const retryChanges = failuresToRetry.map(failure => ({
      productId: failure.productId,
      locationId: failure.locationId,
      newQuantity: failure.attemptedQuantity,
      delta: failure.attemptedQuantity - failure.currentQuantity,
      productName: failure.productName,
      locationName: failure.locationName
    }));
    
    handleSaveAll(true, retryChanges);
  };

  // Dismiss recovery dialog and clear state
  const handleDismissRecovery = () => {
    recoveryManager.clearRecoveryState();
    setLastFailures([]);
    setShowRecoveryDialog(false);
  };

  // Export current data
  const handleExport = async () => {
    try {
      const response = await fetch('/api/admin/inventory/mass-update/export');
      if (!response.ok) throw new Error('Failed to export data');
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `inventory-count-${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      toast.success('Export completed');
    } catch (error) {
      toast.error('Failed to export data');
    }
  };

  // Client-side filtering with memoization for better performance with 100+ products
  const filteredProducts = useMemo(() => {
    if (!data?.products) return [];
    
    return data.products.filter(product => {
      // Filter by search term
      if (searchTerm) {
        const searchLower = searchTerm.toLowerCase();
        const matchesSearch = 
          product.productName.toLowerCase().includes(searchLower) ||
          product.baseName.toLowerCase().includes(searchLower) ||
          (product.variant && product.variant.toLowerCase().includes(searchLower));
        
        if (!matchesSearch) return false;
      }
      
      // Filter by category
      if (categoryFilter !== "all") {
        const productCategory = product.baseName || 'Uncategorized';
        if (productCategory !== categoryFilter) return false;
      }
      
      // Filter by changed only
      if (showChangedOnly && !product.locations.some(loc => loc.hasChanged)) return false;
    
      return true;
    });
  }, [data?.products, searchTerm, categoryFilter, showChangedOnly]);

  // Get unique categories with memoization
  const categories = useMemo(() => {
    if (!data?.products) return [];
    return Array.from(new Set(data.products.map(p => p.baseName || 'Uncategorized'))).sort();
  }, [data?.products]);

  if (isLoading) {
    return (
      <div className="container mx-auto p-6 space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold">Mass Inventory Update</h1>
            <p className="text-muted-foreground mt-1">
              Enter physical count numbers to update inventory across all locations
            </p>
          </div>
        </div>
        
        <Card>
          <CardHeader>
            <CardTitle>Loading Inventory Data...</CardTitle>
            <CardDescription>Please wait while we fetch all products and locations</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {/* Table header skeleton */}
              <div className="flex items-center gap-4 pb-4 border-b">
                <Skeleton className="h-10 w-[200px]" />
                <Skeleton className="h-10 w-[150px]" />
                <Skeleton className="h-10 w-[150px]" />
                <Skeleton className="h-10 w-[150px]" />
              </div>
              
              {/* Table rows skeleton */}
              {[...Array(8)].map((_, i) => (
                <div key={i} className="flex items-center gap-4 py-2">
                  <Skeleton className="h-12 w-[200px]" />
                  <Skeleton className="h-10 w-[150px]" />
                  <Skeleton className="h-10 w-[150px]" />
                  <Skeleton className="h-10 w-[150px]" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold">Mass Inventory Update</h1>
          <p className="text-muted-foreground mt-1">
            Enter physical count numbers to update inventory across all locations. Supports updating 100+ products efficiently.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={handleExport} variant="outline" size="sm">
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </div>
      </div>

      {hasUnsavedChanges && (
        <Alert className="border-orange-600 bg-orange-50 dark:bg-orange-900/20">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            You have unsaved changes. Remember to save before leaving this page.
          </AlertDescription>
        </Alert>
      )}

      {lastFailures.length > 0 && !showRecoveryDialog && (
        <Alert className="border-yellow-600 bg-yellow-50 dark:bg-yellow-900/20">
          <RefreshCw className="h-4 w-4" />
          <AlertDescription className="flex items-center justify-between">
            <span>{lastFailures.length} update{lastFailures.length !== 1 ? 's' : ''} from a previous attempt can be retried.</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowRecoveryDialog(true)}
            >
              Review Failures
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {csrfError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Security error: Unable to load CSRF token. Please refresh the page.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <CardTitle>Inventory Count Entry</CardTitle>
              <CardDescription>
                Enter the actual counted quantities. The system will calculate adjustments automatically.
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={handleReset}
                variant="outline"
                size="sm"
                disabled={!hasUnsavedChanges}
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Reset
              </Button>
              <Button
                onClick={() => {
                  console.log('Save button clicked', { 
                    data, 
                    totalChanges: data?.totalChanges, 
                    isSaving,
                    disabled: !data || data.totalChanges === 0 || isSaving 
                  });
                  handleSaveAll();
                }}
                size="sm"
                disabled={!data || data.totalChanges === 0 || isSaving}
              >
                <Save className="mr-2 h-4 w-4" />
                Save All ({data?.totalChanges || 0})
              </Button>
            </div>
          </div>
          
          <div className="space-y-4 mt-4">
            <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
              <Shield className="h-4 w-4 text-muted-foreground" />
              <div className="flex items-center gap-2">
                <Checkbox
                  id="allowPartial"
                  checked={allowPartialUpdates}
                  onCheckedChange={(checked) => setAllowPartialUpdates(checked as boolean)}
                />
                <label
                  htmlFor="allowPartial"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Allow partial updates
                </label>
              </div>
              <span className="text-sm text-muted-foreground ml-2">
                {allowPartialUpdates 
                  ? "Successful updates will be saved even if some fail"
                  : "All updates must succeed or none will be saved"
                }
              </span>
            </div>
            
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="flex-1">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search products..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>
              <Select value={categoryFilter} onValueChange={setCategory}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="All Categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  {categories.map(category => (
                    <SelectItem key={category} value={category}>{category}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant={showChangedOnly ? "default" : "outline"}
                size="sm"
                onClick={() => setShowChangedOnly(!showChangedOnly)}
              >
                {showChangedOnly ? "Show All" : "Changed Only"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="relative">
          {isSaving && (
            <div className="absolute inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center">
              <div className="flex flex-col items-center gap-2">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
                <p className="text-sm font-medium">Saving changes...</p>
              </div>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b">
                  <th className="text-left p-2">Product</th>
                  {data?.locations.map(location => (
                    <th key={location.id} className="text-center p-2 min-w-[200px]">
                      {location.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map((product) => (
                  <tr key={product.productId} className="border-b hover:bg-muted/50">
                    <td className="p-2">
                      <div>
                        <div className="font-medium">{product.productName}</div>
                        {product.variant && (
                          <div className="text-sm text-muted-foreground">
                            {product.variant}
                          </div>
                        )}
                      </div>
                    </td>
                    {product.locations.map((location) => (
                      <td key={location.locationId} className="p-2">
                        <div className="flex flex-col items-center gap-1">
                          <div className="text-sm text-muted-foreground">
                            Current: {location.currentQuantity}
                          </div>
                          <Input
                            type="number"
                            value={location.newQuantity ?? ""}
                            onChange={(e) => handleQuantityChange(
                              product.productId,
                              location.locationId,
                              e.target.value
                            )}
                            className={cn(
                              "w-24 text-center",
                              location.hasChanged && "border-blue-500",
                              location.delta > 0 && "text-green-600",
                              location.delta < 0 && "text-red-600"
                            )}
                            placeholder="--"
                            disabled={isSaving}
                          />
                          {location.hasChanged && (
                            <Badge 
                              variant={location.delta > 0 ? "default" : "destructive"}
                              className="text-xs"
                            >
                              {location.delta > 0 ? "+" : ""}{location.delta}
                            </Badge>
                          )}
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          
          {filteredProducts.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              {showChangedOnly ? "No products with changes" : "No products found"}
            </div>
          )}
          
          {filteredProducts.length > 0 && (
            <div className="mt-4 p-2 text-sm text-muted-foreground border-t">
              Showing {filteredProducts.length} of {data?.totalProducts || 0} products
              {(data?.totalChanges ?? 0) > 0 && ` • ${data?.totalChanges} pending changes`}
            </div>
          )}
        </CardContent>
      </Card>

      <MassUpdateRecoveryDialog
        open={showRecoveryDialog}
        onOpenChange={setShowRecoveryDialog}
        failures={lastFailures}
        onRetry={handleRetryFailures}
        onDismiss={handleDismissRecovery}
        isRetrying={isRetrying}
      />
    </div>
  );
}