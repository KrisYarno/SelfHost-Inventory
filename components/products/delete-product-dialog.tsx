"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Product } from "@/types/product";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { useDeleteProduct } from "@/hooks/use-products";

interface DeleteProductDialogProps {
  product: Product | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeleteProductDialog({
  product,
  open,
  onOpenChange,
}: DeleteProductDialogProps) {
  const deleteProduct = useDeleteProduct();

  const handleDelete = async () => {
    if (!product) return;
    
    try {
      await deleteProduct.mutateAsync(product.id);
      toast.success(`Product "${product.name}" has been deleted`);
      onOpenChange(false);
    } catch (error) {
      console.error("Error deleting product:", error);
      toast.error(error instanceof Error ? error.message : "Failed to delete product");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Delete Product</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete this product?
          </DialogDescription>
        </DialogHeader>
        
        {product && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-lg border border-warning/50 bg-warning/10 p-3">
              <AlertTriangle className="h-5 w-5 text-warning" />
              <div className="text-sm">
                <p className="font-medium">This action will deactivate the product.</p>
                <p className="text-muted-foreground">
                  The product will no longer appear in active lists but historical data will be preserved.
                </p>
              </div>
            </div>
            
            <div className="rounded-lg border p-3">
              <p className="text-sm font-medium">{product.name}</p>
              <p className="text-xs text-muted-foreground">
                Base: {product.baseName} | Variant: {product.variant}
              </p>
            </div>
          </div>
        )}
        
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={deleteProduct.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleteProduct.isPending}
          >
            {deleteProduct.isPending ? (
              <>
                <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Deleting...
              </>
            ) : (
              "Delete Product"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}