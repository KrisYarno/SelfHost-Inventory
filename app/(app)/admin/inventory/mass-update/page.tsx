"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  Save, 
  RotateCcw, 
  AlertTriangle,
  Download,
  Upload,
  Search,
  Check,
  X
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

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

  // Fetch all data once on mount
  const fetchInventoryData = useCallback(async () => {
    try {
      setIsLoading(true);
      // Fetch all products without any filters
      const response = await fetch(`/api/admin/inventory/mass-update`);
      if (!response.ok) throw new Error("Failed to fetch inventory data");
      
      const result = await response.json();
      setData(result);
    } catch (error) {
      console.error('Error fetching inventory:', error);
      toast.error('Failed to load inventory data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Only fetch once on mount
  useEffect(() => {
    fetchInventoryData();
  }, []);

  // Handle quantity change
  const handleQuantityChange = (productId: number, locationId: number, value: string) => {
    if (!data) return;

    const newQuantity = value === "" ? null : parseInt(value);
    
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
      
      return {
        ...prevData,
        products: updatedProducts,
        totalChanges
      };
    });
    
    setHasUnsavedChanges(true);
  };

  // Save all changes
  const handleSaveAll = async () => {
    if (!data || data.totalChanges === 0) return;

    const confirmMessage = `You are about to update ${data.totalChanges} inventory quantities. This action cannot be undone. Continue?`;
    
    if (!confirm(confirmMessage)) return;

    setIsSaving(true);
    
    try {
      // Collect all changes
      const changes = data.products.flatMap(product => 
        product.locations
          .filter(loc => loc.hasChanged)
          .map(loc => ({
            productId: product.productId,
            locationId: loc.locationId,
            newQuantity: loc.newQuantity!,
            delta: loc.delta
          }))
      );

      const response = await fetch('/api/admin/inventory/mass-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          changes,
          note: `Mass inventory update - ${new Date().toLocaleString()}`
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save changes');
      }

      toast.success(`Successfully updated ${data.totalChanges} inventory quantities`);
      setHasUnsavedChanges(false);
      
      // Refresh data
      await fetchInventoryData();
    } catch (error) {
      console.error('Error saving changes:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to save changes');
    } finally {
      setIsSaving(false);
    }
  };

  // Reset all changes
  const handleReset = () => {
    if (!hasUnsavedChanges) return;
    
    if (confirm('Reset all changes? This will discard any unsaved modifications.')) {
      fetchInventoryData();
      setHasUnsavedChanges(false);
    }
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

  // Client-side filtering
  const filteredProducts = data?.products.filter(product => {
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
  }) || [];

  // Get unique categories
  const categories = data ? Array.from(new Set(data.products.map(p => p.baseName || 'Uncategorized'))).sort() : [];

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
            Enter physical count numbers to update inventory across all locations
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
                onClick={handleSaveAll}
                size="sm"
                disabled={!data || data.totalChanges === 0 || isSaving}
              >
                <Save className="mr-2 h-4 w-4" />
                Save All ({data?.totalChanges || 0})
              </Button>
            </div>
          </div>
          
          <div className="flex flex-col sm:flex-row gap-4 mt-4">
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
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>
    </div>
  );
}