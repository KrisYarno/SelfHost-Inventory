"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { ProductListOptimized } from "@/components/products/product-list-optimized";
import { DeletedProductsList } from "@/components/products/deleted-products-list";
import { CreateProductDialog } from "@/components/products/create-product-dialog";
import { EditProductDialog } from "@/components/products/edit-product-dialog";
import { DeleteProductDialog } from "@/components/products/delete-product-dialog";
import { QuickAdjustDialog } from "@/components/inventory/quick-adjust-dialog";
import { StockInDialog } from "@/components/inventory/stock-in-dialog";
import { ProductWithQuantity } from "@/types/product";
import { Plus, Trash2 } from "lucide-react";
import { Page } from "@/components/layout/page";

export default function ProductsPage() {
  const { data: session } = useSession();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [quickAdjustOpen, setQuickAdjustOpen] = useState(false);
  const [stockInOpen, setStockInOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<ProductWithQuantity | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);

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
    // Refresh handled by React Query in ProductListOptimized
  };

  // Facelift F2-4 (A21): the admin's header actions, one row that wraps (the
  // F1 frame). Icon-only below `sm`; the F1 touch floor makes both 44 px on
  // phones. Members get none.
  const actions = isAdmin ? (
    <>
      <Button
        variant={showDeleted ? "secondary" : "outline"}
        size="sm"
        aria-pressed={showDeleted}
        aria-label="Deleted products"
        onClick={() => setShowDeleted((shown) => !shown)}
      >
        <Trash2 className="h-4 w-4" />
        <span className="hidden sm:inline">Deleted</span>
      </Button>
      <Button size="sm" aria-label="Add Product" onClick={() => setCreateDialogOpen(true)}>
        <Plus className="h-4 w-4" />
        <span className="hidden sm:inline">Add Product</span>
      </Button>
    </>
  ) : undefined;

  return (
    <>
      {/* F2-4: the F1 frame; the shell's main element is the one scroller. */}
      <Page title="Products" actions={actions}>
        {showDeleted && isAdmin && (
          <div className="space-y-4">
            <h2 className="text-h3">Deleted products</h2>
            <DeletedProductsList />
          </div>
        )}
        {/* Facelift FR1-12: the list stays MOUNTED while the deleted view
            shows, hidden, so its filter, page and search survive a trip to
            Deleted and back. */}
        <ProductListOptimized
          onEdit={isAdmin ? handleEdit : undefined}
          onDelete={isAdmin ? handleDelete : undefined}
          onQuickAdjust={handleQuickAdjust}
          onStockIn={handleStockIn}
          onCreate={isAdmin ? () => setCreateDialogOpen(true) : undefined}
          isAdmin={isAdmin}
          className={showDeleted && isAdmin ? "hidden" : undefined}
        />
      </Page>

      {/* Dialogs */}
      <CreateProductDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />

      {/* Mounted per open (M-a.3): every open is a fresh mount, so the dialog's
          live read of the product and the form's defaults never carry over. */}
      {editDialogOpen && selectedProduct && (
        <EditProductDialog
          product={selectedProduct}
          open={editDialogOpen}
          onOpenChange={(open) => {
            setEditDialogOpen(open);
            if (!open) setSelectedProduct(null);
          }}
        />
      )}

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
    </>
  );
}
