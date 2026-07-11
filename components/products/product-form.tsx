"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Product } from "@/types/product";
import { cn } from "@/lib/utils";
import { effectiveLowStockThreshold } from "@/lib/stock-threshold";
import { useLowStockDefault } from "@/hooks/use-low-stock-default";

interface ProductFormInputs {
  baseName: string;
  variantLabel: string;
  numericValue: number | null;
  unit: string;
  locationId?: number;
  costPrice: number;
  retailPrice: number;
}

// R-L13/D-L9 tri-state: inherit the system default (NULL) / explicit custom value
// (>0) / alerts off (0). One control, resolved to a single nullable threshold.
type ThresholdMode = "inherit" | "custom" | "off";

function initialThresholdMode(value: number | null | undefined): ThresholdMode {
  if (value === null || value === undefined) return "inherit";
  if (value === 0) return "off";
  return "custom";
}

interface ProductFormProps {
  product?: Product;
  onSubmit: (data: any) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
  disableSubmit?: boolean;
  className?: string;
  locations?: Array<{ id: number; name: string }>;
  externalError?: string | null;
  defaultLocationId?: number;
  externalFieldErrors?: Partial<{
    baseName: string;
    numericValue: string;
    unit: string;
    variantLabel: string;
  }>;
}

export function ProductForm({
  product,
  onSubmit,
  onCancel,
  isSubmitting = false,
  disableSubmit = false,
  className,
  locations = [],
  externalError,
  defaultLocationId,
  externalFieldErrors,
}: ProductFormProps) {
  const [error, setError] = useState<string | null>(null);
  const allowedUnits = ["mg", "ml", "mcg", "iu"];

  const lowStockDefault = useLowStockDefault();
  // Tri-state alert-threshold control (D-L9). NULL/undefined -> inherit; 0 -> off;
  // >0 -> custom. No `|| 10` coercion — a 0 stays "off", not silently forced to 10.
  const [thresholdMode, setThresholdMode] = useState<ThresholdMode>(
    initialThresholdMode(product?.lowStockThreshold)
  );
  const [customThreshold, setCustomThreshold] = useState<number>(
    product?.lowStockThreshold && product.lowStockThreshold > 0
      ? product.lowStockThreshold
      : lowStockDefault
  );

  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
    setValue,
    setError: setFieldError,
  } = useForm<ProductFormInputs>({
    defaultValues: {
      baseName: product?.baseName || "",
      variantLabel: product?.variant || "",
      numericValue: product?.numericValue ? Number(product.numericValue) : null,
      unit: product?.unit || "",
      locationId: locations[0]?.id,
      costPrice: product ? Number(product.costPrice ?? 0) : 0,
      retailPrice: product ? Number(product.retailPrice ?? 0) : 0,
    },
  });

  // Resolve the tri-state selection to the single nullable value the API persists.
  const resolvedThreshold: number | null =
    thresholdMode === "inherit" ? null : thresholdMode === "off" ? 0 : customThreshold;
  const effectiveThreshold = effectiveLowStockThreshold(resolvedThreshold, lowStockDefault);

  // Set default location when provided (create mode only)
  useEffect(() => {
    if (!product && defaultLocationId) {
      setValue("locationId", defaultLocationId);
    }
  }, [defaultLocationId, product, setValue]);

  const displayError = error || externalError || null;

  // Surface server-side field errors
  useEffect(() => {
    if (!externalFieldErrors) return;
    if (externalFieldErrors.baseName) {
      setFieldError("baseName", { type: "server", message: externalFieldErrors.baseName });
    }
    if (externalFieldErrors.numericValue) {
      setFieldError("numericValue", { type: "server", message: externalFieldErrors.numericValue });
    }
    if (externalFieldErrors.unit) {
      setFieldError("unit" as any, { type: "server", message: externalFieldErrors.unit });
    }
    if (externalFieldErrors.variantLabel) {
      setFieldError("variantLabel" as any, { type: "server", message: externalFieldErrors.variantLabel });
    }
  }, [externalFieldErrors, setFieldError]);

  const handleFormSubmit = async (data: ProductFormInputs) => {
    try {
      setError(null);

      const numericValueRaw =
        data.numericValue !== null && data.numericValue !== undefined
          ? Number(data.numericValue)
          : undefined;
      const hasNumeric = numericValueRaw !== undefined;
      const numericValue = numericValueRaw;
      const unit = data.unit?.trim();
      const variantLabel = data.variantLabel?.trim() || "";

      if (hasNumeric && Number.isNaN(numericValue)) {
        setError("Numeric size must be a valid number");
        return;
      }

      if (hasNumeric && !unit) {
        setError("Select a unit when providing a size");
        return;
      }

      if (unit && !hasNumeric) {
        setError("Add a numeric size when selecting a unit");
        return;
      }

      if (!hasNumeric && !variantLabel) {
        setError("Provide either a size + unit or a variant label");
        return;
      }

      const normalizedUnit = unit ? unit.toLowerCase() : undefined;
      if (normalizedUnit && !allowedUnits.includes(normalizedUnit)) {
        setError("Unit must be one of mg, mL, mcg, or IU");
        return;
      }

      const sizeDisplay =
        hasNumeric
          ? (() => {
              const numericForDisplay = numericValue ?? 0;
              return Number.isInteger(numericForDisplay)
                ? numericForDisplay.toFixed(0)
                : numericForDisplay.toString();
            })()
          : "";

      const unitDisplay =
        normalizedUnit === "ml" ? "mL" : normalizedUnit || "";

      const variant =
        hasNumeric
          ? [sizeDisplay, unitDisplay].filter(Boolean).join(" ").trim()
          : variantLabel;

      const name = `${data.baseName} ${variant}`.trim();

      const sanitizedCostPrice = Number.isFinite(data.costPrice) ? data.costPrice : 0;
      const sanitizedRetailPrice = Number.isFinite(data.retailPrice) ? data.retailPrice : 0;

      const productData = {
        name,
        baseName: data.baseName,
        variant,
        unit: normalizedUnit,
        numericValue: numericValue ?? undefined,
        // Tri-state -> single nullable value (D-L9): null inherit / 0 off / n custom.
        lowStockThreshold: resolvedThreshold,
        locationId: data.locationId,
        costPrice: sanitizedCostPrice,
        retailPrice: sanitizedRetailPrice,
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
      {displayError && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {displayError}
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
            disabled={isSubmitting || !!product}
          />
          {errors.baseName && (
            <p className="text-sm text-destructive">{errors.baseName.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="numericValue">Size (optional)</Label>
          <Input
            id="numericValue"
            type="number"
            step="0.01"
            min="0"
            placeholder="e.g., 15"
            {...register("numericValue", {
              valueAsNumber: true,
              min: {
                value: 0,
                message: "Size must be 0 or greater",
              },
            })}
            disabled={isSubmitting || !!product}
          />
          <p className="text-xs text-muted-foreground">
            Add a numeric size when applicable (mg, mL, mcg, or IU)
          </p>
          {errors.numericValue && (
            <p className="text-sm text-destructive">{errors.numericValue.message}</p>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="unit">Unit</Label>
          <Select
            value={watch("unit")}
            onValueChange={(value) => setValue("unit", value)}
            disabled={isSubmitting || !!product}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select unit (optional)" />
            </SelectTrigger>
            <SelectContent>
              {allowedUnits.map((unit) => (
                <SelectItem key={unit} value={unit}>
                  {unit === "ml" ? "mL" : unit.toUpperCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Required when a size is provided
          </p>
          {externalFieldErrors?.unit && (
            <p className="text-sm text-destructive">{externalFieldErrors.unit}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="variantLabel">Variant Label</Label>
          <Input
            id="variantLabel"
            placeholder="e.g., Spray, Vial, Capsule"
            {...register("variantLabel")}
            disabled={isSubmitting || !!product}
          />
          <p className="text-xs text-muted-foreground">
            Use when there is no numeric size (or to label the variant)
          </p>
          {externalFieldErrors?.variantLabel && (
            <p className="text-sm text-destructive">{externalFieldErrors.variantLabel}</p>
          )}
        </div>
      </div>

            <div className="rounded-md border p-3 text-sm">
        <p className="text-muted-foreground">Preview name</p>
        <p className="font-medium">
          {(() => {
            const base = watch("baseName") || "";
            const numericVal = watch("numericValue");
            const hasNumeric =
              numericVal !== null &&
              numericVal !== undefined &&
              !Number.isNaN(numericVal as number);
            const unitVal = watch("unit") || "";
            const variantFromSize = hasNumeric ? `${numericVal ?? ""} ${unitVal}`.trim() : "";
            const variant = variantFromSize || watch("variantLabel") || "";
            return `${base} ${variant}`.trim() || "--";
          })()}
        </p>
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

      <fieldset className="space-y-2" disabled={isSubmitting}>
        <legend className="text-sm font-medium">Low-stock alert threshold</legend>
        <p className="text-sm text-muted-foreground">
          Email alerts are sent when total stock across all locations drops to this level.
        </p>

        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="thresholdMode"
            className="mt-1"
            checked={thresholdMode === "inherit"}
            onChange={() => setThresholdMode("inherit")}
          />
          <span className="text-sm">Use system default ({lowStockDefault})</span>
        </label>

        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="thresholdMode"
            checked={thresholdMode === "custom"}
            onChange={() => setThresholdMode("custom")}
          />
          <span className="text-sm">Custom threshold</span>
          <Input
            type="number"
            min="0"
            aria-label="Custom low-stock threshold"
            className="h-8 w-24"
            value={Number.isFinite(customThreshold) ? customThreshold : ""}
            onFocus={() => setThresholdMode("custom")}
            onChange={(e) => {
              const parsed = parseInt(e.target.value, 10);
              setCustomThreshold(Number.isNaN(parsed) ? 0 : Math.max(0, parsed));
              setThresholdMode("custom");
            }}
          />
        </label>

        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="thresholdMode"
            className="mt-1"
            checked={thresholdMode === "off"}
            onChange={() => setThresholdMode("off")}
          />
          <span className="text-sm">Alerts off</span>
        </label>

        <p className="text-xs text-muted-foreground">
          {effectiveThreshold > 0
            ? `Effective: ${effectiveThreshold}`
            : "Effective: alerts disabled"}
        </p>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="costPrice">Cost Price</Label>
          <Input
            id="costPrice"
            type="number"
            step="0.01"
            min="0"
            placeholder="0.00"
            {...register("costPrice", {
              valueAsNumber: true,
              min: {
                value: 0,
                message: "Cost must be 0 or greater",
              },
            })}
            disabled={isSubmitting}
          />
          {errors.costPrice && (
            <p className="text-sm text-destructive">{errors.costPrice.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="retailPrice">Retail Price</Label>
          <Input
            id="retailPrice"
            type="number"
            step="0.01"
            min="0"
            placeholder="0.00"
            {...register("retailPrice", {
              valueAsNumber: true,
              min: {
                value: 0,
                message: "Retail price must be 0 or greater",
              },
            })}
            disabled={isSubmitting}
          />
          {errors.retailPrice && (
            <p className="text-sm text-destructive">{errors.retailPrice.message}</p>
          )}
        </div>
      </div>

      <div className="flex justify-end gap-3 pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting || disableSubmit}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting || disableSubmit}>
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



