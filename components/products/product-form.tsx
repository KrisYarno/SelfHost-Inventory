"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { ProductFormData, Product } from "@/types/product";
import { cn } from "@/lib/utils";

interface ProductFormProps {
  product?: Product;
  onSubmit: (data: ProductFormData) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
  className?: string;
}

export function ProductForm({
  product,
  onSubmit,
  onCancel,
  isSubmitting = false,
  className,
}: ProductFormProps) {
  const [error, setError] = useState<string | null>(null);
  
  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
    setValue,
  } = useForm<ProductFormData>({
    defaultValues: {
      name: product?.name || "",
      baseName: product?.baseName || "",
      variant: product?.variant || "",
      unit: product?.unit || "",
      numericValue: product?.numericValue ? Number(product.numericValue) : undefined,
      lowStockThreshold: product?.lowStockThreshold || 1,
    },
  });

  const handleFormSubmit = async (data: ProductFormData) => {
    try {
      setError(null);
      await onSubmit(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    }
  };


  return (
    <form
      onSubmit={handleSubmit(handleFormSubmit)}
      className={cn("space-y-4", className)}
    >
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="baseName">Base Name</Label>
          <Input
            id="baseName"
            placeholder="e.g., Coffee"
            {...register("baseName", {
              required: "Base name is required",
              minLength: {
                value: 1,
                message: "Base name must be at least 1 character",
              },
              maxLength: {
                value: 255,
                message: "Base name must be less than 255 characters",
              },
            })}
            disabled={isSubmitting}
          />
          {errors.baseName && (
            <p className="text-sm text-destructive">{errors.baseName.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="variant">Variant</Label>
          <Input
            id="variant"
            placeholder="e.g., 12oz Bag"
            {...register("variant", {
              required: "Variant is required",
              minLength: {
                value: 1,
                message: "Variant must be at least 1 character",
              },
              maxLength: {
                value: 255,
                message: "Variant must be less than 255 characters",
              },
            })}
            disabled={isSubmitting}
          />
          {errors.variant && (
            <p className="text-sm text-destructive">{errors.variant.message}</p>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="lowStockThreshold">Low Stock Threshold</Label>
        <Input
          id="lowStockThreshold"
          type="number"
          min="0"
          placeholder="1"
          {...register("lowStockThreshold", {
            valueAsNumber: true,
            min: {
              value: 0,
              message: "Threshold must be 0 or greater",
            },
          })}
          disabled={isSubmitting}
        />
        <p className="text-sm text-muted-foreground">
          Email alerts will be sent when stock drops below this level
        </p>
        {errors.lowStockThreshold && (
          <p className="text-sm text-destructive">{errors.lowStockThreshold.message}</p>
        )}
      </div>

      <div className="flex justify-end gap-3 pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              {product ? "Updating..." : "Creating..."}
            </>
          ) : (
            <>{product ? "Update Product" : "Create Product"}</>
          )}
        </Button>
      </div>
    </form>
  );
}