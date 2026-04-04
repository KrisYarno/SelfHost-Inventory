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
  const [locationsLoading, setLocationsLoading] = useState(false);
  const [defaultLocationId, setDefaultLocationId] = useState<number | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string> | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const router = useRouter();
  const { data: session } = useSession();
  const { token: csrfToken, isLoading: csrfLoading } = useCSRF();

  useEffect(() => {
    if (open && csrfToken && !csrfLoading) {
      // Fetch locations when dialog opens
      setLocationsLoading(true);
      setLocationError(null);
      fetch("/api/locations", {
        headers: withCSRFHeaders({}, csrfToken),
      })
        .then(async (res) => {
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || "Failed to fetch locations");
          }
          return res.json();
        })
        .then(data => {
          if (data.locations) {
            setLocations(data.locations);
            const userDefault = session?.user?.defaultLocationId;
            const firstLocation = data.locations[0]?.id;
            const resolvedDefault = data.locations.find((l: any) => l.id === userDefault)?.id || firstLocation;
            setDefaultLocationId(resolvedDefault);
          }
        })
        .catch(err => {
          console.error("Failed to fetch locations:", err);
          setLocationError(err instanceof Error ? err.message : "Failed to fetch locations");
          setFormError(err instanceof Error ? err.message : "Failed to fetch locations");
        })
        .finally(() => setLocationsLoading(false));
    }
  }, [open, csrfToken, csrfLoading, session?.user?.defaultLocationId]);

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
          costPrice: data.costPrice ?? 0,
          retailPrice: data.retailPrice ?? 0,
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
      router.refresh(); // Refresh the page to show the new product
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
          externalError={formError}
          defaultLocationId={defaultLocationId}
          externalFieldErrors={fieldErrors || undefined}
        />
      </DialogContent>
    </Dialog>
  );
}
