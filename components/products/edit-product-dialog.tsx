"use client";

import { useEffect, useState } from "react";
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

/** VERBATIM (pack § P2-B3-1R, M-b3 fix 8). */
const READ_FAILED = "Couldn't load this product.";

/**
 * The live read of the product being edited. `id` ties the answer to the
 * product it was asked for, so an answer for another id is never shown.
 */
type ProductRead =
  | { id: number; status: "ready"; product: Omit<Product, "quantity"> }
  | { id: number; status: "failed" };

interface EditProductDialogProps {
  // The loc-1 `products.quantity` mirror is retired (P2-B2.5) and no longer rides
  // the wire; this dialog never read it. `Omit` keeps every existing caller.
  product: Omit<Product, "quantity"> | null;
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

  // MS-2-2: the list's product (from `/api/products/optimized`) carries no
  // `reorderConfig`, so a form seeded from it never showed an override and could
  // never clear one. The form mounts only after `GET /api/products/[id]` answers,
  // and seeds from that answer. A plain mount-time fetch: no cache is reused, and
  // the host mounts this dialog per open (M-a.3), so every open reads afresh.
  const productId = product?.id ?? null;
  const [read, setRead] = useState<ProductRead | null>(null);

  useEffect(() => {
    if (productId === null) return;
    let current = true;
    fetch(`/api/products/${productId}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Failed to load product (${response.status})`);
        const live = (await response.json()) as Omit<Product, "quantity">;
        if (current) setRead({ id: productId, status: "ready", product: live });
      })
      .catch(() => {
        if (current) setRead({ id: productId, status: "failed" });
      });
    return () => {
      current = false;
    };
  }, [productId]);

  // Only an answer for THIS product counts; anything else is still loading.
  const shownRead = read !== null && read.id === productId ? read : null;

  const handleSubmit = async (data: ProductFormData) => {
    if (!product) return;
    
    try {
      setIsSubmitting(true);
      
      const response = await fetch(`/api/products/${product.id}`, {
        method: "PUT",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({
          lowStockThreshold: data.lowStockThreshold,
          costPrice: data.costPrice,
          retailPrice: data.retailPrice,
          ...(data.reorderConfig ? { reorderConfig: data.reorderConfig } : {}),
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
          {product?.approvalStatus === "PENDING_REVIEW" && (
            <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
              Pending review — this product is awaiting admin approval.
            </p>
          )}
        </DialogHeader>
        
        {product &&
          (shownRead === null ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : shownRead.status === "failed" ? (
            <p role="alert" className="py-6 text-center text-sm text-destructive">
              {READ_FAILED}
            </p>
          ) : (
            <ProductForm
              product={shownRead.product}
              onSubmit={handleSubmit}
              onCancel={() => onOpenChange(false)}
              isSubmitting={isSubmitting || csrfLoading}
            />
          ))}
      </DialogContent>
    </Dialog>
  );
}
