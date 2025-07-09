'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { Save, Package, AlertTriangle } from 'lucide-react';
import { useCSRF, withCSRFHeaders } from '@/hooks/use-csrf';

interface ProductThreshold {
  id: number;
  name: string;
  lowStockThreshold: number;
  currentStock: number;
}

export default function ThresholdSettingsPage() {
  const [products, setProducts] = useState<ProductThreshold[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [modifiedProducts, setModifiedProducts] = useState<Set<number>>(new Set());
  const [thresholds, setThresholds] = useState<Record<number, number>>({});
  const { token: csrfToken } = useCSRF();

  useEffect(() => {
    fetchProducts();
  }, []);

  const fetchProducts = async () => {
    try {
      setIsLoading(true);
      const response = await fetch('/api/admin/products/thresholds');
      if (!response.ok) throw new Error('Failed to fetch products');
      
      const data = await response.json();
      setProducts(data);
      
      // Initialize thresholds
      const initialThresholds: Record<number, number> = {};
      data.forEach((product: ProductThreshold) => {
        initialThresholds[product.id] = product.lowStockThreshold;
      });
      setThresholds(initialThresholds);
    } catch (error) {
      console.error('Error fetching products:', error);
      toast.error('Failed to load products');
    } finally {
      setIsLoading(false);
    }
  };

  const handleThresholdChange = (productId: number, value: string) => {
    const numValue = parseInt(value) || 0;
    setThresholds(prev => ({
      ...prev,
      [productId]: Math.max(0, numValue),
    }));
    
    // Track which products have been modified
    const product = products.find(p => p.id === productId);
    if (product && product.lowStockThreshold !== numValue) {
      setModifiedProducts(prev => new Set(prev).add(productId));
    } else {
      setModifiedProducts(prev => {
        const newSet = new Set(prev);
        newSet.delete(productId);
        return newSet;
      });
    }
  };

  const handleSave = async () => {
    if (modifiedProducts.size === 0) {
      toast.info('No changes to save');
      return;
    }

    setIsSaving(true);
    try {
      const updates = Array.from(modifiedProducts).map(productId => ({
        id: productId,
        lowStockThreshold: thresholds[productId],
      }));

      const response = await fetch('/api/admin/products/thresholds', {
        method: 'PATCH',
        headers: withCSRFHeaders({
          'Content-Type': 'application/json',
        }, csrfToken),
        body: JSON.stringify({ updates }),
      });

      if (!response.ok) throw new Error('Failed to update thresholds');

      toast.success(`Updated thresholds for ${updates.length} products`);
      setModifiedProducts(new Set());
      await fetchProducts();
    } catch (error) {
      console.error('Error saving thresholds:', error);
      toast.error('Failed to save thresholds');
    } finally {
      setIsSaving(false);
    }
  };

  const handleBulkSet = (value: string) => {
    const numValue = parseInt(value) || 0;
    const newThresholds: Record<number, number> = {};
    const newModified = new Set<number>();
    
    products.forEach(product => {
      newThresholds[product.id] = Math.max(0, numValue);
      if (product.lowStockThreshold !== numValue) {
        newModified.add(product.id);
      }
    });
    
    setThresholds(newThresholds);
    setModifiedProducts(newModified);
  };

  if (isLoading) {
    return (
      <div className="container mx-auto p-6 space-y-6">
        <h1 className="text-3xl font-bold">Low Stock Thresholds</h1>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-48" />
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Low Stock Thresholds</h1>
          <p className="text-muted-foreground mt-1">
            Configure when products should trigger low stock alerts
          </p>
        </div>
        <Button
          onClick={handleSave}
          disabled={isSaving || modifiedProducts.size === 0}
        >
          <Save className="mr-2 h-4 w-4" />
          Save Changes ({modifiedProducts.size})
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Bulk Actions</CardTitle>
          <CardDescription>
            Set the same threshold for all products at once
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-4">
            <div className="flex-1 max-w-xs">
              <Label htmlFor="bulk-threshold">Set All Thresholds To:</Label>
              <Input
                id="bulk-threshold"
                type="number"
                min="0"
                placeholder="Enter value"
                onChange={(e) => handleBulkSet(e.target.value)}
                className="mt-2"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Product Thresholds</CardTitle>
          <CardDescription>
            Set individual thresholds for each product. Alerts will be sent when stock falls below these levels.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {products.map((product) => {
              const isModified = modifiedProducts.has(product.id);
              const isBelowThreshold = product.currentStock <= thresholds[product.id];
              
              return (
                <div
                  key={product.id}
                  className={`flex items-center gap-4 p-4 rounded-lg border ${
                    isModified ? 'border-primary bg-primary/5' : 'border-border'
                  }`}
                >
                  <Package className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                  
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{product.name}</p>
                      {isBelowThreshold && (
                        <Badge variant="destructive" className="text-xs">
                          <AlertTriangle className="h-3 w-3 mr-1" />
                          Below Threshold
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Current stock: {product.currentStock} units
                    </p>
                  </div>
                  
                  <div className="w-32">
                    <Input
                      type="number"
                      min="0"
                      value={thresholds[product.id] || 0}
                      onChange={(e) => handleThresholdChange(product.id, e.target.value)}
                      className="text-center"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}