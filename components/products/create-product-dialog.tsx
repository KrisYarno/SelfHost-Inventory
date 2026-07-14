"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
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
import { useLocations } from "@/hooks/use-staging";
import { useQueryClient } from "@tanstack/react-query";

interface CreateProductDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateProductDialog({
  open,
  onOpenChange,
}: CreateProductDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [defaultLocationId, setDefaultLocationId] = useState<number | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string> | null>(null);
  const router = useRouter();
  const { data: session } = useSession();
  const { token: csrfToken, isLoading: csrfLoading } = useCSRF();
  const queryClient = useQueryClient();

  // Locations are fetched (and cached) the moment the dialog opens.
  const {
    data: locations = [],
    isFetching: locationsLoading,
    isError: locationsIsError,
    error: locationsError,
  } = useLocations(open);
  const locationError = locationsIsError
    ? locationsError instanceof Error
      ? locationsError.message
      : "Failed to fetch locations"
    : null;

  // Resolve the default location once the catalog is available.
  useEffect(() => {
    if (open && locations.length > 0) {
      const userDefault = session?.user?.defaultLocationId;
      const firstLocation = locations[0]?.id;
      const resolvedDefault =
        locations.find((l) => l.id === userDefault)?.id || firstLocation;
      setDefaultLocationId(resolvedDefault);
    }
  }, [open, locations, session?.user?.defaultLocationId]);

  const handleSubmit = async (data: any) => {
    try {
      setIsSubmitting(true);
      setFormError(null);
      setFieldErrors(null);
      
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
          costPrice: data.costPrice ?? null,
          retailPrice: data.retailPrice ?? 0,
          ...(data.reorderConfig ? { reorderConfig: data.reorderConfig } : {}),
        }),
      });

      if (!response.ok) {
        const json = await response.json().catch(() => ({}));
        if (json.details && typeof json.details === "object") {
          const normalized: Record<string, string> = {};
          Object.entries(json.details).forEach(([key, value]) => {
            if (Array.isArray(value)) {
              const first = value.find(Boolean);
              if (first) normalized[key] = String(first);
            } else if (value) {
              normalized[key] = String(value);
            }
          });
          // Map server keys to client fields when naming differs
          if (normalized.variant && !normalized.variantLabel) {
            normalized.variantLabel = normalized.variant;
          }
          setFieldErrors(Object.keys(normalized).length ? normalized : null);
        }
        throw new Error(json.error || "Failed to create product");
      }

      const product = await response.json();

      toast.success(`Product "${product.name}" created successfully`);
      onOpenChange(false);
      // Refresh the react-query product list (ProductListOptimized) + server tree.
      queryClient.invalidateQueries({ queryKey: ["products"] });
      router.refresh();
    } catch (error) {
      console.error("Error creating product:", error);
      const message = error instanceof Error ? error.message : "Failed to create product";
      setFormError(message);
      toast.error(message);
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
          isSubmitting={isSubmitting || csrfLoading || locationsLoading}
          disableSubmit={csrfLoading || locationsLoading || !!locationError || !csrfToken}
          locations={locations}
          externalError={formError ?? locationError}
          defaultLocationId={defaultLocationId}
          externalFieldErrors={fieldErrors || undefined}
        />
      </DialogContent>
    </Dialog>
  );
}
