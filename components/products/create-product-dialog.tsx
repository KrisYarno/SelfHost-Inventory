"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProductForm } from "./product-form";
import { toast } from "sonner";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";

interface CreateProductDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateProductDialog({
  open,
  onOpenChange,
}: CreateProductDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [locations, setLocations] = useState<Array<{ id: number; name: string }>>([]);
  const router = useRouter();
  const { token: csrfToken, isLoading: csrfLoading } = useCSRF();

  useEffect(() => {
    if (open) {
      // Fetch locations when dialog opens
      fetch("/api/locations", {
        headers: withCSRFHeaders({}, csrfToken),
      })
        .then(res => res.json())
        .then(data => {
          if (data.locations) {
            setLocations(data.locations);
          }
        })
        .catch(err => console.error("Failed to fetch locations:", err));
    }
  }, [open, csrfToken]);

  const handleSubmit = async (data: any) => {
    try {
      setIsSubmitting(true);
      
      // Data already contains properly formatted name, variant, unit, numericValue from ProductForm
      const response = await fetch("/api/products", {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({
          name: data.name,
          baseName: data.baseName,
          variant: data.variant,
          unit: data.unit,
          numericValue: data.numericValue,
          lowStockThreshold: data.lowStockThreshold,
          locationId: data.locationId || 1, // Default to location 1 if not specified
          costPrice: data.costPrice ?? 0,
          retailPrice: data.retailPrice ?? 0,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to create product");
      }

      const product = await response.json();
      
      toast.success(`Product "${product.name}" created successfully`);
      onOpenChange(false);
      router.refresh(); // Refresh the page to show the new product
    } catch (error) {
      console.error("Error creating product:", error);
      toast.error(error instanceof Error ? error.message : "Failed to create product");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Create New Product</DialogTitle>
          <DialogDescription>
            Add a new product to your inventory catalog
          </DialogDescription>
        </DialogHeader>
        
        <ProductForm
          onSubmit={handleSubmit}
          onCancel={() => onOpenChange(false)}
          isSubmitting={isSubmitting || csrfLoading}
          locations={locations}
        />
      </DialogContent>
    </Dialog>
  );
}
