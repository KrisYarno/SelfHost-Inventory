"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { ProductListOptimized } from "@/components/products/product-list-optimized";
import { CreateProductDialog } from "@/components/products/create-product-dialog";
import { EditProductDialog } from "@/components/products/edit-product-dialog";
import { DeleteProductDialog } from "@/components/products/delete-product-dialog";
import { QuickAdjustDialog } from "@/components/inventory/quick-adjust-dialog";
import { StockInDialog } from "@/components/inventory/stock-in-dialog";
import { ProductWithQuantity } from "@/types/product";
import { Plus } from "lucide-react";

export default function ProductsPage() {
  const { data: session } = useSession();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [quickAdjustOpen, setQuickAdjustOpen] = useState(false);
  const [stockInOpen, setStockInOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<ProductWithQuantity | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  
  const isAdmin = session?.user?.isAdmin;

  const handleEdit = (product: ProductWithQuantity) => {
    setSelectedProduct(product);
    setEditDialogOpen(true);
  };

  const handleDelete = (product: ProductWithQuantity) => {
    setSelectedProduct(product);
    setDeleteDialogOpen(true);
  };

  const handleQuickAdjust = (product: ProductWithQuantity) => {
    setSelectedProduct(product);
    setQuickAdjustOpen(true);
  };

  const handleStockIn = (product: ProductWithQuantity) => {
    setSelectedProduct(product);
    setStockInOpen(true);
  };

  const refreshProducts = () => {
    setRefreshKey(prev => prev + 1);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="border-b border-border bg-background px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
            <p className="text-sm text-muted-foreground">
              Manage your product catalog
            </p>
          </div>
          <div className="flex items-center gap-4">
            {isAdmin && (
              <Button onClick={() => setCreateDialogOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Add Product
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-7xl">
          <ProductListOptimized
            onEdit={isAdmin ? handleEdit : undefined}
            onDelete={isAdmin ? handleDelete : undefined}
            onQuickAdjust={handleQuickAdjust}
            onStockIn={handleStockIn}
            isAdmin={isAdmin}
            showInventoryActions={true}
          />
        </div>
      </main>

      {/* Dialogs */}
      <CreateProductDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />
      
      <EditProductDialog
        product={selectedProduct}
        open={editDialogOpen}
        onOpenChange={(open) => {
          setEditDialogOpen(open);
          if (!open) setSelectedProduct(null);
        }}
      />
      
      <DeleteProductDialog
        product={selectedProduct}
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open);
          if (!open) setSelectedProduct(null);
        }}
      />
      
      {selectedProduct && (
        <QuickAdjustDialog
          open={quickAdjustOpen}
          onOpenChange={(open) => {
            setQuickAdjustOpen(open);
            if (!open) setSelectedProduct(null);
          }}
          product={selectedProduct}
          onSuccess={refreshProducts}
        />
      )}
      
      {selectedProduct && (
        <StockInDialog
          open={stockInOpen}
          onOpenChange={(open) => {
            setStockInOpen(open);
            if (!open) setSelectedProduct(null);
          }}
          product={selectedProduct}
          onSuccess={refreshProducts}
        />
      )}
    </div>
  );
}