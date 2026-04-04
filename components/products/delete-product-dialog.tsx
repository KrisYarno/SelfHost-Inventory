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
import { useCSRF } from "@/hooks/use-csrf";

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
  const { token: csrfToken, isLoading: csrfLoading, error: csrfError, refreshToken } = useCSRF();
  const deleteProduct = useDeleteProduct(csrfToken || undefined);

  const handleDelete = async () => {
    if (!product) return;
    if (!deleteProduct.isReady) {
      toast.error("Preparing delete request. Please try again in a moment.");
      if (csrfError) {
        await refreshToken();
      }
      return;
    }
    
    try {
      await deleteProduct.mutateAsync(product.id);
      toast.success(`Product "${product.name}" has been deleted (soft delete)`);
      onOpenChange(false);
    } catch (error) {
      const status = (error as any)?.status;
      if (status === 400 && error instanceof Error && error.message.includes("already deleted")) {
        toast.success(`Product "${product.name}" is already deleted`);
        onOpenChange(false);
        return;
      }
      if (status === 401 || status === 403) {
        toast.error("Delete requires admin access and a valid session. Please refresh/sign in.");
        return;
      }
      if (status === 404) {
        toast.error("Product not found. Please refresh the page.");
        return;
      }
      if (status === 403 && error instanceof Error && error.message.toLowerCase().includes("csrf")) {
        toast.error("Security check failed. Refresh and try again.");
        return;
      }
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
        
        {csrfError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            Unable to load security token. Please refresh and try again.
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
            disabled={deleteProduct.isPending || csrfLoading || !deleteProduct.isReady}
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
