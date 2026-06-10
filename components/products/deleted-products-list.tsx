"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { RotateCcw, Trash2, Package } from "lucide-react";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

interface DeletedProduct {
  id: number;
  name: string;
  baseName?: string | null;
  variant?: string | null;
  unit?: string | null;
  deletedAt: string;
  deletedByUser?: {
    id: number;
    username: string;
    email: string;
  } | null;
}

export function DeletedProductsList() {
  const [products, setProducts] = useState<DeletedProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<number | null>(null);
  const { token: csrfToken } = useCSRF();
  const queryClient = useQueryClient();

  const loadDeletedProducts = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/products/deleted");
      if (!res.ok) throw new Error("Failed to load deleted products");
      const data = await res.json();
      setProducts(data.products ?? []);
    } catch (err) {
      console.error("Error loading deleted products:", err);
      setError("Unable to load deleted products. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadDeletedProducts();
  }, []);

  const handleRestore = async (product: DeletedProduct) => {
    if (!csrfToken) {
      toast.error("Security token not ready. Please wait a moment and try again.");
      return;
    }

    setRestoringId(product.id);
    try {
      const res = await fetch(`/api/admin/products/${product.id}/restore`, {
        method: "POST",
        headers: withCSRFHeaders({}, csrfToken),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to restore product");
      }

      toast.success(`"${product.name}" has been restored`);
      // Remove from local list
      setProducts((prev) => prev.filter((p) => p.id !== product.id));
      // Invalidate product queries so the main list refreshes
      queryClient.invalidateQueries({ queryKey: ["products"] });
    } catch (err) {
      console.error("Error restoring product:", err);
      toast.error(err instanceof Error ? err.message : "Failed to restore product");
    } finally {
      setRestoringId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-lg" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-destructive mb-2">{error}</p>
        <Button variant="outline" onClick={loadDeletedProducts}>
          Retry
        </Button>
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Package className="h-6 w-6 text-muted-foreground" />
        </div>
        <p className="mb-1 text-lg font-medium">No deleted products</p>
        <p className="text-sm text-muted-foreground">
          Products that are soft-deleted will appear here and can be restored.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground px-1">
        <Trash2 className="h-4 w-4" />
        <span>
          {products.length} deleted product{products.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {products.map((product) => {
          const isRestoring = restoringId === product.id;
          const deletedDate = new Date(product.deletedAt);
          const formattedDate = deletedDate.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
          });

          return (
            <Card
              key={product.id}
              className={cn(
                "flex flex-col border border-border/70 bg-gradient-to-br from-surface to-muted/40",
                "shadow-sm rounded-xl opacity-75 hover:opacity-100 transition-opacity duration-200"
              )}
            >
              <CardHeader className="space-y-1.5 pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base font-semibold line-through decoration-muted-foreground/50">
                    {product.name}
                  </CardTitle>
                  <Badge
                    variant="outline"
                    className="text-[11px] px-2 py-1 bg-negative-muted text-negative-foreground border-negative-border"
                  >
                    Deleted
                  </Badge>
                </div>
                {product.baseName && (
                  <p className="text-xs text-muted-foreground">
                    {product.baseName}
                    {product.variant ? ` / ${product.variant}` : ""}
                  </p>
                )}
              </CardHeader>
              <CardContent className="space-y-3 pt-0">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Deleted {formattedDate}</span>
                  {product.deletedByUser && (
                    <span>by {product.deletedByUser.username}</span>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 w-full text-xs"
                  disabled={isRestoring}
                  onClick={() => handleRestore(product)}
                >
                  {isRestoring ? (
                    <>
                      <span className="mr-2 h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      Restoring...
                    </>
                  ) : (
                    <>
                      <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                      Restore Product
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
