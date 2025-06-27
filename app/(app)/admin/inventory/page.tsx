"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  Download, 
  ChevronDown, 
  ChevronRight,
  MapPin,
  Search,
  AlertCircle
} from "lucide-react";
import { formatNumber } from "@/lib/utils";
import { toast } from "sonner";
import { useDebounce } from "@/hooks/use-debounce";

interface ProductInventory {
  id: number;
  name: string;
  baseName: string | null;
  variant: string | null;
  totalQuantity: number;
  locations: Array<{
    id: number;
    name: string;
    quantity: number;
  }>;
}

interface InventoryOverviewData {
  products: ProductInventory[];
  totalProducts: number;
}

export default function AdminInventoryPage() {
  const [expandedProducts, setExpandedProducts] = useState<Set<number>>(new Set());
  const [searchTerm, setSearchTerm] = useState("");
  const [data, setData] = useState<InventoryOverviewData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const debouncedSearch = useDebounce(searchTerm, 300);

  const fetchInventoryData = useCallback(async () => {
    try {
      setIsLoading(true);
      const params = new URLSearchParams();
      if (debouncedSearch) params.append("search", debouncedSearch);
      
      const response = await fetch(`/api/admin/inventory?${params}`);
      if (!response.ok) throw new Error("Failed to fetch inventory data");
      const result = await response.json();
      setData(result);
    } catch (error) {
      console.error('Error fetching inventory:', error);
      toast.error('Failed to load inventory data');
    } finally {
      setIsLoading(false);
    }
  }, [debouncedSearch]);

  useEffect(() => {
    fetchInventoryData();
  }, [fetchInventoryData]);

  const handleExportCSV = async () => {
    try {
      const response = await fetch("/api/admin/inventory/export", {
        method: "GET",
      });
      
      if (!response.ok) throw new Error("Failed to export data");
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `inventory-overview-${new Date().toISOString().split('T')[0]}.csv`;
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

  const toggleExpanded = (productId: number) => {
    const newExpanded = new Set(expandedProducts);
    if (newExpanded.has(productId)) {
      newExpanded.delete(productId);
    } else {
      newExpanded.add(productId);
    }
    setExpandedProducts(newExpanded);
  };

  // Commented out - functionality moved to read-only view
  // const handleQuickAdjust = async (productId: number, locationId: number, delta: number) => {
  //   try {
  //     const response = await fetch("/api/inventory/adjust", {
  //       method: "POST",
  //       headers: { "Content-Type": "application/json" },
  //       body: JSON.stringify({
  //         productId,
  //         locationId,
  //         quantity: delta,
  //         notes: `Admin overview adjustment`
  //       }),
  //     });
  //     if (!response.ok) throw new Error("Failed to adjust inventory");
  //     
  //     toast.success("Inventory adjusted successfully");
  //     await fetchInventoryData();
  //   } catch (error) {
  //     toast.error("Failed to adjust inventory");
  //     console.error(error);
  //   }
  // };


  if (isLoading) {
    return (
      <div className="container mx-auto p-6 space-y-6">
        <div className="flex justify-between items-center">
          <h1 className="text-3xl font-bold">Inventory Overview</h1>
          <Skeleton className="h-10 w-[140px]" />
        </div>
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold">Location Inventory Overview</h1>
          <p className="text-muted-foreground mt-1">
            Administrative view of inventory distribution across all locations
          </p>
        </div>
        <Button onClick={handleExportCSV} variant="outline">
          <Download className="mr-2 h-4 w-4" />
          Export as CSV
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Inventory Distribution</CardTitle>
          <CardDescription>
            View and manage inventory levels by location. This overview shows where products are stored and allows quick administrative adjustments.
          </CardDescription>
          <div className="flex items-center space-x-2 mt-4">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search products..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="max-w-sm"
            />
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {data?.products.map((product) => {
              const isExpanded = expandedProducts.has(product.id);
              
              return (
                <div key={product.id} className="border rounded-lg">
                  <div
                    className="flex items-center justify-between p-4 cursor-pointer hover:bg-muted/50"
                    onClick={() => toggleExpanded(product.id)}
                  >
                    <div className="flex items-center gap-2">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                      <span className="font-medium">{product.name}</span>
                    </div>
                    <div className="text-lg font-semibold">
                      {formatNumber(product.totalQuantity)} units
                    </div>
                  </div>
                  
                  {isExpanded && (
                    <div className="border-t px-4 py-3 bg-muted/30">
                      <div className="space-y-3">
                        {product.locations.map((location) => {                          
                          return (
                            <div
                              key={location.id}
                              className="flex items-center justify-between py-2 px-3 rounded-lg bg-background"
                            >
                              <div className="flex items-center gap-3">
                                <MapPin className="h-4 w-4 text-muted-foreground" />
                                <div>
                                  <p className="font-medium">{location.name}</p>
                                  <p className="text-sm text-muted-foreground">
                                    {formatNumber(location.quantity)} units
                                  </p>
                                </div>
                              </div>
                              
                              {location.quantity === 0 && (
                                <Badge variant="outline" className="text-orange-600 border-orange-600">
                                  <AlertCircle className="h-3 w-3 mr-1" />
                                  Out of Stock
                                </Badge>
                              )}
                            </div>
                          );
                        })}
                        
                        {product.locations.length === 0 && (
                          <p className="text-sm text-muted-foreground text-center py-2">
                            No location data available
                          </p>
                        )}
                      </div>
                      
                      <div className="mt-3 pt-3 border-t text-xs text-muted-foreground">
                        <p>To adjust inventory, use the Products or Inventory pages.</p>
                        <p>This view is for administrative oversight only.</p>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            
            {data?.products.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                No products found
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}