"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { RotateCcw, Trash2, Package } from "lucide-react";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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
  const { token: csrfToken } = useCSRF();
  const queryClient = useQueryClient();

  const {
    data: products = [],
    isLoading,
    isError,
    refetch,
  } = useQuery<DeletedProduct[]>({
    queryKey: ["deleted-products"],
    queryFn: async () => {
      const res = await fetch("/api/admin/products/deleted");
      if (!res.ok) throw new Error("Failed to load deleted products");
      const data = await res.json();
      return (data.products ?? []) as DeletedProduct[];
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async (product: DeletedProduct) => {
      const res = await fetch(`/api/admin/products/${product.id}/restore`, {
        method: "POST",
        headers: withCSRFHeaders({}, csrfToken),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to restore product");
      }
      return res.json().catch(() => ({}));
    },
    onSuccess: (_data, product) => {
      toast.success(`"${product.name}" has been restored`);
      // Refresh the deleted list (this component) and the main product list.
      queryClient.invalidateQueries({ queryKey: ["deleted-products"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (err) => {
      console.error("Error restoring product:", err);
      toast.error(err instanceof Error ? err.message : "Failed to restore product");
    },
  });
  const restoringId = restoreMutation.isPending
    ? restoreMutation.variables?.id ?? null
    : null;

  const handleRestore = (product: DeletedProduct) => {
    if (!csrfToken) {
      toast.error("Security token not ready. Please wait a moment and try again.");
      return;
    }
    restoreMutation.mutate(product);
  };

  // Facelift FR1-13: 4 rows of the rows' own height, inside the rows' frame.
  if (isLoading) {
    return (
      <div className="rounded-lg border bg-surface divide-y">
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-none" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-center py-8">
        <p className="text-destructive mb-2">
          Unable to load deleted products. Please try again.
        </p>
        <Button variant="outline" onClick={() => refetch()}>
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

      {/* Facelift F2-10 (FL-B-14): rows, not cards. No dimming and no
          strike-through: the `Deleted products` heading above the list says
          it (FR1-13: so no per-row Deleted badge either). */}
      <div className="rounded-lg border bg-surface divide-y">
        {products.map((product) => (
          <DeletedProductRow
            key={product.id}
            product={product}
            isRestoring={restoringId === product.id}
            onRestore={handleRestore}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One deleted product. Facelift FR1-9: `Restore Product` keeps its visible
 * label as its accessible name and is DESCRIBED by this row's product name
 * (a per-row `useId`), so a screen reader hears which product it restores.
 */
function DeletedProductRow({
  product,
  isRestoring,
  onRestore,
}: {
  product: DeletedProduct;
  isRestoring: boolean;
  onRestore: (product: DeletedProduct) => void;
}) {
  const nameId = useId();
  const deletedDate = new Date(product.deletedAt);
  const formattedDate = deletedDate.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="flex min-h-14 items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div id={nameId} className="text-sm font-semibold truncate">{product.name}</div>
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {product.baseName && (
            <span>
              {product.baseName}
              {product.variant ? ` / ${product.variant}` : ""}
            </span>
          )}
          <span>Deleted {formattedDate}</span>
          {product.deletedByUser && (
            <span>by {product.deletedByUser.username}</span>
          )}
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="shrink-0"
        disabled={isRestoring}
        aria-describedby={nameId}
        onClick={() => onRestore(product)}
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
    </div>
  );
}
