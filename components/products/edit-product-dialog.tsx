"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProductForm } from "./product-form";
import { ProductFormData, Product } from "@/types/product";
import { toast } from "sonner";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";

interface EditProductDialogProps {
  product: Product | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditProductDialog({
  product,
  open,
  onOpenChange,
}: EditProductDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const router = useRouter();
  const { token: csrfToken, isLoading: csrfLoading } = useCSRF();

  const handleSubmit = async (data: any) => {
    if (!product) return;
    
    try {
      setIsSubmitting(true);
      
      // For edit, we only update the lowStockThreshold
      // The product name, variant, unit, etc. are immutable
      const response = await fetch(`/api/products/${product.id}`, {
        method: "PUT",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({
          lowStockThreshold: data.lowStockThreshold,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to update product");
      }

      const updatedProduct = await response.json();
      
      toast.success(`Product "${updatedProduct.name}" updated successfully`);
      onOpenChange(false);
      router.refresh(); // Refresh the page to show the updated product
    } catch (error) {
      console.error("Error updating product:", error);
      toast.error(error instanceof Error ? error.message : "Failed to update product");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Edit Product</DialogTitle>
          <DialogDescription>
            Update the product details
          </DialogDescription>
        </DialogHeader>
        
        {product && (
          <ProductForm
            product={product}
            onSubmit={handleSubmit}
            onCancel={() => onOpenChange(false)}
            isSubmitting={isSubmitting || csrfLoading}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}