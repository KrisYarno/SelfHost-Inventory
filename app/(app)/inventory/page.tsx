'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { SimpleInventoryLogTable } from '@/components/inventory/simple-inventory-log-table';
import { StockLevelBadge, StockLevelIndicator } from '@/components/inventory/stock-level-badge';
import { QuickAdjustDialog } from '@/components/inventory/quick-adjust-dialog';
import { StockInDialog } from '@/components/inventory/stock-in-dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FileText, Plus, TrendingUp, BookOpen } from 'lucide-react';
import { toast } from 'sonner';
import type { 
  InventoryLogWithRelations, 
  InventoryTransactionWithLogs,
  CurrentInventoryLevel 
} from '@/types/inventory';
import type { ProductWithQuantity } from '@/types/product';

export default function InventoryPage() {
  const [logs, setLogs] = useState<InventoryLogWithRelations[]>([]);
  const [transactions, setTransactions] = useState<InventoryTransactionWithLogs[]>([]);
  const [currentInventory, setCurrentInventory] = useState<CurrentInventoryLevel[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<ProductWithQuantity | null>(null);
  const [showQuickAdjust, setShowQuickAdjust] = useState(false);
  const [showStockIn, setShowStockIn] = useState(false);

  // Fetch current inventory levels
  const fetchCurrentInventory = async () => {
    try {
      const response = await fetch('/api/inventory/current');
      if (!response.ok) throw new Error('Failed to fetch inventory');
      const data = await response.json();
      setCurrentInventory(data.inventory);
    } catch (error) {
      toast.error('Failed to load current inventory levels');
    }
  };

  // Fetch inventory logs
  const fetchLogs = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/inventory/logs?pageSize=20');
      if (!response.ok) throw new Error('Failed to fetch logs');
      const data = await response.json();
      setLogs(data.logs);
    } catch (error) {
      toast.error('Failed to load inventory logs');
    } finally {
      setLoading(false);
    }
  };

  // Fetch transactions
  const fetchTransactions = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/inventory/transactions?pageSize=10');
      if (!response.ok) throw new Error('Failed to fetch transactions');
      const data = await response.json();
      setTransactions(data.transactions);
    } catch (error) {
      toast.error('Failed to load transactions');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCurrentInventory();
    fetchLogs();
    // fetchTransactions(); // Commented out - no transaction table in schema
  }, []);

  const handleProductAction = (product: CurrentInventoryLevel, action: 'adjust' | 'stockIn') => {
    // Convert CurrentInventoryLevel to ProductWithQuantity format
    const productWithQuantity: ProductWithQuantity = {
      ...product.product,
      currentQuantity: product.quantity,
      lastUpdated: product.lastUpdated
    };
    
    setSelectedProduct(productWithQuantity);
    if (action === 'adjust') {
      setShowQuickAdjust(true);
    } else {
      setShowStockIn(true);
    }
  };

  const refreshData = () => {
    fetchCurrentInventory();
    fetchLogs();
    // fetchTransactions(); // Commented out - no transaction table in schema
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Inventory Management</h1>
          <p className="text-muted-foreground">
            Track inventory levels, view transaction history, and manage stock adjustments.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/journal" className="gap-2">
              <BookOpen className="h-4 w-4" />
              Journal Mode
            </Link>
          </Button>
        </div>
      </div>

      {/* Current Inventory Levels */}
      <Card>
        <CardHeader>
          <CardTitle>Current Stock Levels</CardTitle>
          <CardDescription>Real-time inventory quantities across all products</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {currentInventory.map((item) => (
              <Card key={`${item.productId}-${item.locationId}`} className="group">
                <CardContent className="pt-6">
                  <div className="space-y-3">
                    <div>
                      <p className="text-sm font-medium">{item.product.name}</p>
                      <p className="text-xs text-muted-foreground">{item.location.name}</p>
                    </div>
                    <div className="flex items-center justify-between">
                      <StockLevelBadge quantity={item.quantity} />
                      <span className="text-2xl font-bold">{item.quantity}</span>
                    </div>
                    <StockLevelIndicator quantity={item.quantity} />
                    
                    {/* Quick Actions */}
                    <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleProductAction(item, 'stockIn')}
                        className="flex-1 gap-1"
                      >
                        <Plus className="h-3 w-3" />
                        Stock In
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleProductAction(item, 'adjust')}
                        className="flex-1 gap-1"
                      >
                        <TrendingUp className="h-3 w-3" />
                        Adjust
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Tabs for different views */}
      <Tabs defaultValue="logs" className="space-y-4">
        <TabsList>
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
                        {currentInventory.map((item) => (
                          <SelectItem 
                            key={item.productId} 
                            value={item.productId.toString()}
                          >
                            {item.product.name}
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