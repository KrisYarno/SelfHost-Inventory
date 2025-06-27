"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Product } from "@/types/product";
import { cn } from "@/lib/utils";

interface ProductFormInputs {
  baseName: string;
  size: string;
  lowStockThreshold: number;
  locationId?: number;
}

interface ProductFormProps {
  product?: Product;
  onSubmit: (data: any) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
  className?: string;
  locations?: Array<{ id: number; name: string }>;
}

// Regex to parse size like "1mg", "5 mg", "10 mL"
const SIZE_REGEX = /^(\d+(?:\.\d+)?)\s*(mg|mL|mcg)$/i;

export function ProductForm({
  product,
  onSubmit,
  onCancel,
  isSubmitting = false,
  className,
  locations = [],
}: ProductFormProps) {
  const [error, setError] = useState<string | null>(null);
  
  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
    setValue,
  } = useForm<ProductFormInputs>({
    defaultValues: {
      baseName: product?.baseName || "",
      size: product ? `${product.numericValue || ''} ${product.unit || ''}`.trim() : "",
      lowStockThreshold: product?.lowStockThreshold || 10,
      locationId: locations[0]?.id,
    },
  });

  const validateSize = (value: string) => {
    if (!value) return "Size is required";
    if (!SIZE_REGEX.test(value)) {
      return "Size must be in format like '1mg', '5 mg', or '10 mL'";
    }
    return true;
  };

  const handleFormSubmit = async (data: ProductFormInputs) => {
    try {
      setError(null);
      
      // Parse the size field
      const sizeMatch = data.size.match(SIZE_REGEX);
      if (!sizeMatch) {
        setError("Invalid size format");
        return;
      }

      const numericValue = parseFloat(sizeMatch[1]);
      const unit = sizeMatch[2].toLowerCase();
      
      // Format variant: use integer format if it's a whole number
      const variant = `${numericValue % 1 === 0 ? numericValue.toFixed(0) : numericValue} ${unit}`;
      
      // Construct name with single space
      const name = `${data.baseName} ${variant}`;

      const productData = {
        name,
        baseName: data.baseName,
        variant,
        unit,
        numericValue,
        lowStockThreshold: data.lowStockThreshold,
        locationId: data.locationId,
      };

      await onSubmit(productData);
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
          <Label htmlFor="baseName">Product Name</Label>
          <Input
            id="baseName"
            placeholder="e.g., AOD, BPC-157"
            {...register("baseName", {
              required: "Product name is required",
              minLength: {
                value: 1,
                message: "Product name must be at least 1 character",
              },
              maxLength: {
                value: 255,
                message: "Product name must be less than 255 characters",
              },
            })}
            disabled={isSubmitting}
          />
          {errors.baseName && (
            <p className="text-sm text-destructive">{errors.baseName.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="size">Size</Label>
          <Input
            id="size"
            placeholder="e.g., 5mg, 10 mL, 250mcg"
            {...register("size", {
              required: "Size is required",
              validate: validateSize,
            })}
            disabled={isSubmitting || !!product}
          />
          <p className="text-xs text-muted-foreground">
            Enter size with unit (mg, mL, or mcg)
          </p>
          {errors.size && (
            <p className="text-sm text-destructive">{errors.size.message}</p>
          )}
        </div>
      </div>

      {locations.length > 0 && !product && (
        <div className="space-y-2">
          <Label htmlFor="locationId">Location</Label>
          <Select
            value={watch("locationId")?.toString()}
            onValueChange={(value) => setValue("locationId", parseInt(value))}
            disabled={isSubmitting}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a location" />
            </SelectTrigger>
            <SelectContent>
              {locations.map((location) => (
                <SelectItem key={location.id} value={location.id.toString()}>
                  {location.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            Select the location for this product
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="lowStockThreshold">Low Stock Threshold</Label>
        <Input
          id="lowStockThreshold"
          type="number"
          min="0"
          placeholder="10"
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
          Email alerts will be sent when total stock across all locations drops below this level
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